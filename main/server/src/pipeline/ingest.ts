import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { db, newId, now } from '../lib/db.js';
import { chatJsonSchema, llmReady } from '../lib/llm.js';
import { safeJoin } from '../lib/vault.js';
import { docxToText } from './docx.js';
import { xlsxToText, pptxToText } from './office.js';
import { chunkLosslessly, assertLosslessChunks } from './losslessChunker.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { extractWikiLinks, RELATION_WORDS } from './extractor.js';
import { addReports } from '../dream/reports.js';
import {
  composeItemOutputListSchema, criticOutputSchema, mapOutputSchema, normalizeOutputSchema,
  planOutputSchema, questionOutputSchema, verifierOutputSchema,
  type Candidate, type ComposedItem, type StructuredDocument, type PlanItem,
  type IngestRelation, type QuestionOutput, type VerifierOutput,
} from './ingestModel.js';
import { enforceWriteGate, whitelistFactIds } from './ingestGuards.js';
import {
  guardAmbiguousEntityNames,
  type EntityRosterEntry,
} from './entityAmbiguity.js';
import {
  composePrompt, criticPrompt, mapPrompt, normalizePrompt, planPrompt,
  questionFinderPrompt, verifierPrompt,
} from '../prompts/ingestPipeline.js';
import { commitKnowledgeItems, type IngestStats, type KnowledgeItem } from './knowledgeCommit.js';
import {
  beginSourceVersion,
  failSourceVersion,
  recordQuestions,
  supplementalAnswerContent,
  supplementalAnswers,
  type SupplementalAnswer,
} from './sourceLedger.js';
import { reconcileQuestionsAfterRun, syncIngestQuestionReport } from './ingestQuestions.js';

export type { IngestStats } from './knowledgeCommit.js';
export type IngestStage = '解析' | 'Map' | 'Normalize' | 'Plan' | 'Critic' | 'Retrieve' | 'Compose' | 'Verify' | 'Commit';
export type IngestProgress = { stage: IngestStage; progress: number; detail?: string };
export type IngestProgressCallback = (update: IngestProgress) => void;
const EMPTY: IngestStats = { created: 0, merged: 0, skipped: 0, pending: 0 };

function hash(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }

async function loadDocument(relPath: string): Promise<StructuredDocument> {
  const abs = safeJoin(relPath);
  const bytes = fs.readFileSync(abs);
  const ext = path.posix.extname(relPath).slice(1).toLowerCase();
  let text: string;
  if (ext === 'docx') text = await docxToText(bytes);
  else if (ext === 'xlsx') text = xlsxToText(bytes);
  else if (ext === 'pptx') text = await pptxToText(bytes);
  else text = matter(bytes.toString('utf8')).content.replace(/\r\n/g, '\n').trim();
  const chunks = chunkLosslessly(text);
  assertLosslessChunks(text, chunks);
  return { path: relPath, title: path.posix.basename(relPath), contentHash: hash(bytes), text, chunks };
}

function audit(runId: string, stage: string, payload: unknown, input?: unknown) {
  const serialized = JSON.stringify(payload);
  db.prepare(`INSERT INTO ingest_audit(run_id, stage, at, input_hash, payload) VALUES(?, ?, ?, ?, ?)`).run(
    runId, stage, now(), input === undefined ? null : hash(JSON.stringify(input)), serialized.slice(0, 500_000)
  );
}

function setStatus(pathName: string, contentHash: string, runId: string, status: string, error: string | null = null) {
  db.prepare(`INSERT INTO ingest_log(path, at, content_hash, status, run_id, error) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET at=excluded.at, content_hash=excluded.content_hash, status=excluded.status, run_id=excluded.run_id, error=excluded.error`)
    .run(pathName, now(), contentHash, status, runId, error);
}

function loadRoster(limit = 2000): EntityRosterEntry[] {
  return db.prepare(
    `SELECT id, title, type, summary FROM pages
     WHERE deleted=0 AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
     ORDER BY updated_at DESC LIMIT ?`
  ).all(limit) as EntityRosterEntry[];
}

function roster(entries: EntityRosterEntry[], limit = 100): string {
  return entries.slice(0, limit)
    .map((row) => `- ${row.title}（${row.type || '未分类'}）${row.summary ? `：${row.summary.slice(0, 80)}` : ''}`).join('\n');
}

async function dynamicContext(candidates: Candidate[], document: StructuredDocument): Promise<string> {
  const queries = [...new Set(candidates.map((c) => `${c.name} ${c.summary}`))].slice(0, 12);
  if (!queries.length) queries.push(`${document.title} ${document.text.slice(0, 300)}`);
  const lines = new Set<string>();
  for (const query of queries) {
    try {
      const hits = await hybridSearch(query, 5);
      for (const hit of hits.filter((h) =>
        h.refType === 'page' && (h.path.startsWith('Wiki/概念/') || h.path.startsWith('Wiki/实体/'))
      )) {
        lines.add(`- ${hit.title}（${hit.type || '未分类'}）：${hit.snippet.replace(/\n/g, ' ').slice(0, 180)}`);
      }
    } catch { /* retrieval degradation is audited by the empty result */ }
  }
  return [...lines].slice(0, 30).join('\n');
}

async function jsonStage<T>(schema: any, system: string, input: unknown, tag: string, maxTokens = 8000): Promise<T> {
  return chatJsonSchema<T>(schema, [
    { role: 'system', content: system },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
  ], { temperature: 0.1, maxTokens, retries: 1, tag });
}

function validateFacts(candidates: Candidate[], document: StructuredDocument): Candidate[] {
  const byId = new Map(document.chunks.map((chunk) => [chunk.id, chunk.content]));
  return candidates.map((candidate) => ({
    ...candidate,
    facts: candidate.facts.filter((fact) => fact.sources.length > 0 && fact.sources.every((source) => byId.get(source.chunkId)?.includes(source.quote))),
  })).filter((candidate) => candidate.facts.length > 0);
}

function persistFacts(runId: string, candidates: Candidate[]) {
  const insert = db.prepare(`INSERT OR REPLACE INTO ingest_facts(run_id, fact_id, statement, sources) VALUES(?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const candidate of candidates) for (const fact of candidate.facts) insert.run(runId, fact.id, fact.statement, JSON.stringify(fact.sources));
  });
  tx();
}

function addSupplementalAnswers(document: StructuredDocument, answers: SupplementalAnswer[]): void {
  for (const answer of answers) {
    const content = supplementalAnswerContent(answer);
    document.chunks.push({
      id: `q-${answer.id}`,
      index: document.chunks.length,
      heading: '用户补充问答',
      content,
      start: document.text.length,
      end: document.text.length,
    });
  }
}

function canonicalRelationName(name: string, plan: PlanItem[], rosterEntries: EntityRosterEntry[]): string | null {
  const normalized = name.trim().toLowerCase();
  const item = plan.find((candidate) => candidate.name.trim().toLowerCase() === normalized);
  if (item) {
    if (item.action === 'skip' || item.action === 'review') return null;
    return item.action === 'merge' ? item.target : item.name;
  }
  return rosterEntries.find((entry) => entry.title.trim().toLowerCase() === normalized)?.title || null;
}

function attachCandidateRelations(
  plan: PlanItem[],
  candidates: Candidate[],
  rosterEntries: EntityRosterEntry[],
  allowedFactIds: ReadonlySet<string>,
): PlanItem[] {
  const extracted: IngestRelation[] = [];
  for (const candidate of candidates) {
    for (const relation of candidate.relations) {
      if (!(RELATION_WORDS as readonly string[]).includes(relation.word)) continue;
      if (!relation.factId || !allowedFactIds.has(relation.factId)) continue;
      const src = canonicalRelationName(relation.src, plan, rosterEntries);
      const dst = canonicalRelationName(relation.dst, plan, rosterEntries);
      if (src && dst) extracted.push({ src, word: relation.word, dst, factId: relation.factId });
    }
  }
  return plan.map((item) => {
    const pageName = item.action === 'merge' ? item.target : item.name;
    const inherited = item.relations.filter((relation) =>
      relation.factId && allowedFactIds.has(relation.factId) &&
      (RELATION_WORDS as readonly string[]).includes(relation.word)
    );
    const related = extracted.filter((relation) => relation.src.toLowerCase() === pageName.toLowerCase());
    const unique = new Map([...inherited, ...related].map((relation) => [
      `${relation.src}\0${relation.word}\0${relation.dst}\0${relation.factId}`,
      relation,
    ]));
    return { ...item, relations: [...unique.values()] };
  });
}

export async function ingestRawFile(
  relPath: string,
  onProgress: IngestProgressCallback = () => {},
  options: { force?: boolean } = {},
): Promise<IngestStats> {
  onProgress({ stage: '解析', progress: 2, detail: relPath });
  let document: StructuredDocument;
  try {
    document = await loadDocument(relPath);
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 2000);
    let contentHash = hash(`${relPath}:${message}`);
    try { contentHash = hash(fs.readFileSync(safeJoin(relPath))); } catch { /* retain deterministic fallback */ }
    const runId = newId();
    const sourceVersion = beginSourceVersion(relPath, contentHash);
    db.prepare(
      `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
       VALUES(?,?,?,?, 'running','pending','pending',?)`
    ).run(runId, relPath, contentHash, sourceVersion.id, now());
    failSourceVersion(sourceVersion.id, runId, message);
    setStatus(relPath, contentHash, runId, 'failed', message);
    throw error;
  }
  const resolvedQuestions = supplementalAnswers(relPath);
  addSupplementalAnswers(document, resolvedQuestions);
  onProgress({ stage: '解析', progress: 8, detail: `${document.chunks.length} 个分段` });
  const prior = db.prepare(`SELECT content_hash, status FROM ingest_log WHERE path=?`).get(relPath) as any;
  if (!options.force && prior?.content_hash === document.contentHash && prior.status === 'completed') return { ...EMPTY };
  const runId = newId();
  const sourceVersion = beginSourceVersion(relPath, document.contentHash);
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, relPath, document.contentHash, sourceVersion.id, now());
  setStatus(relPath, document.contentHash, runId, 'running');
  if (!llmReady()) {
    const message = '未配置 LLM，无法整理';
    failSourceVersion(sourceVersion.id, runId, message);
    setStatus(relPath, document.contentHash, runId, 'failed', message);
    throw new Error(message);
  }
  try {
    if (document.text.length < 30 && !resolvedQuestions.length) {
      const { stats } = commitKnowledgeItems([], {
        runId,
        sourceVersion,
        sourcePath: relPath,
        sourceName: document.title,
        sourceRef: `原始资料/${document.title}`,
      });
      audit(runId, 'commit', stats, { reason: '正文少于 30 字' });
      db.prepare(`UPDATE ingest_runs SET stats=? WHERE id=?`).run(JSON.stringify(stats), runId);
      setStatus(relPath, document.contentHash, runId, 'completed');
      return stats;
    }
    const rosterEntries = loadRoster();
    const titleRoster = roster(rosterEntries);
    const mapped: Candidate[] = [];
    for (let chunkIndex = 0; chunkIndex < document.chunks.length; chunkIndex++) {
      const chunk = document.chunks[chunkIndex];
      onProgress({ stage: 'Map', progress: 10 + Math.round(((chunkIndex + 1) / document.chunks.length) * 24), detail: `${chunkIndex + 1}/${document.chunks.length}` });
      try {
        const out = await jsonStage<{ candidates: Candidate[] }>(mapOutputSchema, mapPrompt(chunk.id, titleRoster), `分段 ${chunk.id} [${chunk.start},${chunk.end})：\n${chunk.content}`, 'ingest-map');
        const valid = validateFacts(out.candidates, document);
        mapped.push(...valid);
        audit(runId, `map:${chunk.id}`, valid, { start: chunk.start, end: chunk.end });
      } catch (error: any) {
        audit(runId, `map_failed:${chunk.id}`, { error: String(error?.message || error) }, { start: chunk.start, end: chunk.end });
        throw error;
      }
    }
    onProgress({ stage: 'Normalize', progress: 38 });
    const normalizedOut = await jsonStage<{ candidates: Candidate[] }>(normalizeOutputSchema, normalizePrompt, { candidates: mapped }, 'ingest-normalize');
    const candidates = validateFacts(normalizedOut.candidates, document);
    persistFacts(runId, candidates); audit(runId, 'normalize', candidates, mapped);
    const allowedFactIds = new Set(candidates.flatMap((candidate) => candidate.facts.map((fact) => fact.id)));
    const facts = candidates.flatMap((candidate) => candidate.facts);

    onProgress({ stage: 'Retrieve', progress: 48 });
    const related = await dynamicContext(candidates, document); audit(runId, 'retrieve', { related }, candidates.map((c) => c.name));

    onProgress({ stage: 'Plan', progress: 56 });
    const rawPlan = await jsonStage<{ items: PlanItem[] }>(planOutputSchema, planPrompt(titleRoster, related), { candidates }, 'ingest-plan');
    const plan = whitelistFactIds(rawPlan.items, allowedFactIds).items;
    audit(runId, 'plan', plan, candidates);

    onProgress({ stage: 'Critic', progress: 64, detail: '首次审查' });
    const firstCritique = await jsonStage<{ approved: boolean; issues: string[]; items: PlanItem[] }>(criticOutputSchema, criticPrompt, { plan, candidates, roster: titleRoster, related }, 'ingest-critic');
    const revised = whitelistFactIds(firstCritique.items, allowedFactIds).items;
    audit(runId, 'critic', { ...firstCritique, items: revised }, plan);
    onProgress({ stage: 'Critic', progress: 69, detail: '修订复核' });
    const secondCritique = await jsonStage<{ approved: boolean; issues: string[]; items: PlanItem[] }>(criticOutputSchema, criticPrompt, { plan: revised, candidates, roster: titleRoster, related, previousCritique: firstCritique }, 'ingest-critic-review');
    let reviewedPlan = whitelistFactIds(secondCritique.items, allowedFactIds).items;
    if (!secondCritique.approved) reviewedPlan = reviewedPlan.map((item) => item.action === 'skip' ? item : { ...item, action: 'review' as const, reason: [item.reason, ...secondCritique.issues].filter(Boolean).join('；') });
    reviewedPlan = guardAmbiguousEntityNames(reviewedPlan, candidates, rosterEntries);
    reviewedPlan = attachCandidateRelations(reviewedPlan, candidates, rosterEntries, allowedFactIds);
    audit(runId, 'critic_review', { ...secondCritique, items: reviewedPlan }, revised);

    onProgress({ stage: 'Compose', progress: 76 });
    // Compose：LLM 只输出 {name, content}，其余字段从 plan 继承；传入 roster/related 让正文关联知识库
    const composeInput = {
      items: reviewedPlan.map((it) => ({
        name: it.name,
        kind: it.kind,
        action: it.action,
        target: it.target,
        summary: it.summary,
        factIds: it.factIds,
        relations: it.relations,
      })),
      facts,
    };
    const rawComposed = await jsonStage<{ items: { name: string; content: string }[] }>(
      composeItemOutputListSchema, composePrompt(titleRoster, related), composeInput, 'ingest-compose', 12000
    );
    // 按 name 匹配回 reviewedPlan，合并出完整 ComposedItem[]
    const contentByName = new Map(rawComposed.items.map((it) => [it.name.trim().toLowerCase(), it.content]));
    const composedItems: KnowledgeItem[] = reviewedPlan.map((plan) => ({
      ...plan,
      content: contentByName.get(plan.name.trim().toLowerCase()) || '',
    }));
    const composed = { items: whitelistFactIds(composedItems, allowedFactIds).items };
    audit(runId, 'compose', composed, reviewedPlan);

    const questions = await jsonStage<QuestionOutput>(
      questionOutputSchema,
      questionFinderPrompt,
      { candidates, plan: reviewedPlan, resolvedQuestions },
      'ingest-questions',
    );
    const ambiguityQuestions = reviewedPlan.flatMap((item) => item.ambiguity ? [{
      question: item.ambiguity.question,
      factIds: item.factIds,
      acceptance: item.ambiguity.category === 'role_title'
        ? ['给出完整姓名，或选择库中已有人物']
        : ['确认并入已有实体，或给出经过核实的正确名称'],
    }] : []);
    const seenQuestions = new Set<string>();
    questions.questions = [...ambiguityQuestions, ...questions.questions].filter((question) => {
      const key = question.question.trim();
      if (!key || seenQuestions.has(key)) return false;
      seenQuestions.add(key);
      return true;
    }).slice(0, 12);
    audit(runId, 'questions', questions, candidates);
    onProgress({ stage: 'Verify', progress: 86 });
    const verified = await jsonStage<VerifierOutput>(verifierOutputSchema, verifierPrompt, { items: composed.items, facts, questions: questions.questions }, 'ingest-verify'); audit(runId, 'verify', verified, { composed, questions });
    const safeItems = enforceWriteGate(composed.items, verified, allowedFactIds);
    const rawPage = db.prepare(`SELECT title FROM pages WHERE path=? AND deleted=0`).get(relPath) as any;
    const sourceRef = rawPage ? `[[${rawPage.title}]]` : `原始资料/${document.title}`;
    onProgress({ stage: 'Commit', progress: 94 });
    const recordedQuestions = recordQuestions(runId, sourceVersion.id, relPath, questions.questions);
    const { stats } = commitKnowledgeItems(safeItems, {
      runId,
      sourceVersion,
      sourcePath: relPath,
      sourceName: document.title,
      sourceRef,
    });
    const finish = db.transaction(() => {
      reconcileQuestionsAfterRun(relPath, runId);
      if (recordedQuestions.length) {
        addReports([{
          kind: 'ingest_questions',
          payload: {
            path: relPath,
            runId,
            sourceVersionId: sourceVersion.id,
            contentHash: document.contentHash,
            questions: recordedQuestions,
          },
        }]);
      }
      audit(runId, 'commit', stats, safeItems.map((item) => ({ name: item.name, action: item.action })));
      db.prepare(`UPDATE ingest_runs SET stats=? WHERE id=?`).run(JSON.stringify(stats), runId);
      syncIngestQuestionReport(relPath);
      setStatus(relPath, document.contentHash, runId, 'completed');
    });
    finish();
    onProgress({ stage: 'Commit', progress: 100, detail: '提交完成' });
    return stats;
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 2000);
    failSourceVersion(sourceVersion.id, runId, message);
    setStatus(relPath, document.contentHash, runId, 'failed', message);
    throw error;
  }
}

export async function ingestAllRaw(): Promise<string[]> {
  const output: string[] = [];
  const walk = (relative: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(safeJoin(relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (['md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx'].includes(ext)) output.push(child);
    }
  };
  walk('原始资料');
  return output;
}

export { extractWikiLinks };
