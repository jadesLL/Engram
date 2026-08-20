import fs from 'node:fs';
import path from 'node:path';
import { db, newId, now } from '../lib/db.js';
import { getActiveChat, llmReady, type ChatMessage } from '../lib/llm.js';
import { recordLlmResultCacheHit } from '../lib/llmUsage.js';
import {
  createSemanticCacheSession,
  runSemanticStage,
  type SemanticCacheContextMode,
} from '../lib/semanticStage.js';
import { safeJoin } from '../lib/vault.js';
import { hybridSearchMany } from '../retrieval/hybrid.js';
import { extractWikiLinks, RELATION_WORDS } from './extractor.js';
import { addReports } from '../dream/reports.js';
import {
  composeItemOutputListSchema, criticOutputSchema, mapOutputSchema, normalizeOutputSchema,
  planOutputSchema, questionOutputSchema, verifierOutputSchema,
  COMPOSE_BATCH_LIMIT, MAP_BATCH_LIMIT, NORMALIZE_BATCH_LIMIT, PLAN_BATCH_LIMIT,
  type Candidate, type ComposedItem, type StructuredDocument, type PlanItem,
  type IngestRelation, type NormalizeMerge, type QuestionOutput, type VerifierOutput,
  type DocumentChunk,
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
import { contentHash as hash, loadSourceDocument } from './sourceDocument.js';
import { reconcileQuestionsAfterRun, syncIngestQuestionReport } from './ingestQuestions.js';
import { EXTRACTABLE_EXTENSIONS } from './fileExtraction.js';
import { chunkLosslessly } from './losslessChunker.js';
import { finalizeSourceCandidateReingest } from './candidateLedger.js';
import { appendWikiLog } from './indexFile.js';

export type { IngestStats } from './knowledgeCommit.js';
export type IngestStage = '解析' | 'Map' | 'Normalize' | 'Plan' | 'Critic' | 'Retrieve' | 'Compose' | 'Verify' | 'Commit';
export type IngestProgress = { stage: IngestStage; progress: number; detail?: string };
export type IngestProgressCallback = (update: IngestProgress) => void;
const EMPTY: IngestStats = { created: 0, merged: 0, skipped: 0, pending: 0 };
export const INGEST_PIPELINE_VERSION = '2026-08-20.1';

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

function restoreSourceAfterAttempt(
  sourceVersionId: string,
  previousActiveVersionId: string | undefined,
  runId: string,
  sourcePath: string,
  runStatus: 'failed' | 'cancelled',
  error: string,
): void {
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`DELETE FROM page_contributions WHERE source_version_id=? AND active=0`)
      .run(sourceVersionId);
    if (previousActiveVersionId) {
      if (sourceVersionId !== previousActiveVersionId) {
        db.prepare(`UPDATE source_versions SET status='failed',error=? WHERE id=?`)
          .run(error, sourceVersionId);
      }
      db.prepare(
        `UPDATE source_versions SET status='superseded'
         WHERE path=? AND id<>? AND status NOT IN ('failed','processing')`
      ).run(sourcePath, previousActiveVersionId);
      db.prepare(
        `UPDATE source_versions SET status='active',error=NULL,
         activated_at=COALESCE(activated_at,?) WHERE id=?`
      ).run(timestamp, previousActiveVersionId);
      db.prepare(
        `UPDATE page_contributions SET active=CASE WHEN source_version_id=? THEN 1 ELSE 0 END
         WHERE source_version_id IN (SELECT id FROM source_versions WHERE path=?)`
      ).run(previousActiveVersionId, sourcePath);
    } else {
      db.prepare(`UPDATE source_versions SET status='failed',error=? WHERE id=?`)
        .run(error, sourceVersionId);
    }
    db.prepare(
      `UPDATE ingest_runs SET status=?,commit_status='failed',
       derived_status='failed',finished_at=?,error=? WHERE id=?`
    ).run(runStatus, timestamp, error, runId);
  })();
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
  try {
    const resultSets = await hybridSearchMany(queries, 5);
    for (const hits of resultSets) {
      for (const hit of hits.filter((h) =>
        h.refType === 'page' && (h.path.startsWith('Wiki/概念/') || h.path.startsWith('Wiki/实体/'))
      )) {
        lines.add(`- ${hit.title}（${hit.type || '未分类'}）：${hit.snippet.replace(/\n/g, ' ').slice(0, 180)}`);
      }
    }
  } catch { /* retrieval degradation is audited by the empty result */ }
  return [...lines].slice(0, 30).join('\n');
}

async function jsonStage<T>(
  runId: string,
  schema: any,
  system: string,
  input: unknown,
  tag: string,
  maxTokens = 8000,
  stage = tag,
  cacheContext?: unknown,
  history?: ChatMessage[],
  cacheContextMode: SemanticCacheContextMode = 'once',
  signal?: AbortSignal,
): Promise<T> {
  return runSemanticStage<T>({
    scope: 'ingest',
    refId: runId,
    stage,
    tag,
    schema,
    system,
    cacheContext,
    cacheContextMode,
    history,
    maxHistoryChars: 96_000,
    promptVersion: INGEST_PIPELINE_VERSION,
    cacheScope: `${tag}:${stage.split(':')[0]}`,
    resultCache: true,
    input,
    temperature: 0.1,
    maxTokens,
    retries: 1,
    signal,
  });
}

function ingestInputSignature(
  sourcePath: string,
  document: StructuredDocument,
  answers: SupplementalAnswer[],
): string {
  const active = getActiveChat();
  const knowledge = db.prepare(
    `SELECT id,title,type,summary FROM pages
     WHERE deleted=0
       AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
       AND id NOT IN (
         SELECT pc.page_id FROM page_contributions pc
         JOIN source_versions sv ON sv.id=pc.source_version_id
         WHERE sv.path=?
       )
     ORDER BY id`
  ).all(sourcePath);
  return hash(JSON.stringify({
    pipelineVersion: INGEST_PIPELINE_VERSION,
    contentHash: document.contentHash,
    model: active ? {
      provider: active.provider,
      baseUrl: active.baseUrl.replace(/\/+$/, ''),
      model: active.model,
    } : null,
    answers: answers.map((answer) => ({
      id: answer.id,
      question: answer.question,
      answer: answer.answer,
    })),
    knowledge,
  }));
}

/** 规范化引文文本用于模糊匹配：LLM 返回的 quote 经常有标点全半角差异、
 *  多余空格或换行，纯 includes 会静默丢弃整条 fact。
 *  归一化后做子串匹配，容忍这些表层差异。 */
function normalizeForMatch(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[''＇｀"＂]/g, '"')
    .replace(/['']/g, "'")
    .replace(/[，､]/g, ',')
    .replace(/[。｡]/g, '.')
    .replace(/[：：]/g, ':')
    .replace(/[；；]/g, ';')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[—–－]/g, '-')
    .replace(/……/g, '...')
    .toLowerCase();
}

function quoteInContent(quote: string, content: string): boolean {
  if (content.includes(quote)) return true;
  return normalizeForMatch(content).includes(normalizeForMatch(quote));
}

function validateFacts(candidates: Candidate[], chunks: Iterable<Pick<DocumentChunk, 'id' | 'content'>>): Candidate[] {
  const byId = new Map([...chunks].map((chunk) => [chunk.id, chunk.content]));
  return candidates.map((candidate) => ({
    ...candidate,
    facts: candidate.facts.filter((fact) => fact.sources.length > 0 && fact.sources.every((source) => {
      const chunkContent = byId.get(source.chunkId);
      return chunkContent && quoteInContent(source.quote, chunkContent);
    })),
  })).filter((candidate) => candidate.facts.length > 0);
}

/** 并发执行异步任务，限制最大并发数。 */
async function concurrentMap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function batches<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function spreadBatches<T>(items: T[], size: number): T[][] {
  const count = Math.ceil(items.length / size);
  if (count <= 1) return [items];
  const output = Array.from({ length: count }, () => [] as T[]);
  items.forEach((item, index) => output[index % count].push(item));
  return output.filter((batch) => batch.length);
}

function structuredOutputFailure(error: unknown): boolean {
  return /解析|截断|json|schema|validation|enum|at most|too_big|最多|结构校验/i
    .test(String((error as any)?.message || error));
}

function splitMapChunk(chunk: DocumentChunk): DocumentChunk[] {
  if (chunk.content.length <= 1200) return [];
  const target = Math.max(1000, Math.ceil(chunk.content.length / 2));
  const parts = chunkLosslessly(chunk.content, { maxChars: target, overlapChars: 120 });
  if (parts.length <= 1) return [];
  return parts.map((part, index) => ({
    ...part,
    id: `${chunk.id}.${index + 1}`,
    index: chunk.index,
    start: chunk.start + part.start,
    end: chunk.start + part.end,
  }));
}

async function mapChunk(
  runId: string,
  chunk: DocumentChunk,
  titleRoster: string,
  history: ChatMessage[],
  cacheContextMode: SemanticCacheContextMode = 'once',
  signal?: AbortSignal,
): Promise<Candidate[]> {
  signal?.throwIfAborted();
  try {
    const out = await jsonStage<{ candidates: Candidate[] }>(
      runId,
      mapOutputSchema,
      mapPrompt,
      {
        chunkId: chunk.id,
        start: chunk.start,
        end: chunk.end,
        content: chunk.content,
      },
      'ingest-map',
      8000,
      `ingest-map:${chunk.id}`,
      { roster: titleRoster },
      history,
      cacheContextMode,
      signal,
    );
    const valid = validateFacts(out.candidates, [chunk]);
    if (out.candidates.length >= MAP_BATCH_LIMIT) {
      const parts = splitMapChunk(chunk);
      if (parts.length > 1) {
        audit(runId, `map_split:${chunk.id}`, {
          reason: `候选达到单段上限 ${MAP_BATCH_LIMIT}`,
          chunks: parts.map((part) => ({ id: part.id, start: part.start, end: part.end })),
        });
        const mapped: Candidate[] = [];
        for (const part of parts) {
          mapped.push(...await mapChunk(runId, part, titleRoster, history, 'once', signal));
        }
        return mapped;
      }
    }
    audit(runId, `map:${chunk.id}`, valid, { start: chunk.start, end: chunk.end });
    return valid;
  } catch (error) {
    const parts = structuredOutputFailure(error) ? splitMapChunk(chunk) : [];
    if (parts.length > 1) {
      audit(runId, `map_split:${chunk.id}`, {
        reason: String((error as any)?.message || error),
        chunks: parts.map((part) => ({ id: part.id, start: part.start, end: part.end })),
      });
      const mapped: Candidate[] = [];
      for (const part of parts) {
        mapped.push(...await mapChunk(runId, part, titleRoster, history, 'once', signal));
      }
      return mapped;
    }
    audit(runId, `map_failed:${chunk.id}`, {
      error: String((error as any)?.message || error),
    }, { start: chunk.start, end: chunk.end });
    throw error;
  }
}

function exactCandidateCoverage(
  expected: Array<{ candidateId: string }>,
  actual: Array<{ candidateId: string }>,
  stage: string,
): void {
  const expectedIds = expected.map((item) => item.candidateId);
  const actualIds = actual.map((item) => item.candidateId);
  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);
  const duplicates = actualIds.filter((id, index) => !id || actualIds.indexOf(id) !== index);
  const missing = expectedIds.filter((id) => !actualSet.has(id));
  const unknown = actualIds.filter((id) => !expectedSet.has(id));
  if (duplicates.length || missing.length || unknown.length || actualIds.length !== expectedIds.length) {
    throw new Error(
      `${stage} 候选覆盖不完整：遗漏 ${missing.join(',') || '无'}；重复 ${[...new Set(duplicates)].join(',') || '无'}；未知 ${unknown.join(',') || '无'}`,
    );
  }
}

async function coveredItemsStage<T extends { items: Array<{ candidateId: string }> }>(
  runId: string,
  schema: any,
  system: string,
  input: unknown,
  expected: Array<{ candidateId: string }>,
  tag: string,
  maxTokens: number,
  stage: string,
  cacheContext?: unknown,
  history?: ChatMessage[],
  cacheContextMode: SemanticCacheContextMode = 'once',
  signal?: AbortSignal,
): Promise<T> {
  let coverageError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const stageInput = attempt
      ? {
          ...(typeof input === 'object' && input !== null && !Array.isArray(input)
            ? input as Record<string, unknown>
            : { input }),
          coverageCorrection: '上一轮输出遗漏、重复或修改了 candidateId。请严格逐项覆盖输入中的全部 candidateId。',
        }
      : input;
    const result = await jsonStage<T>(
      runId,
      schema,
      system,
      stageInput,
      tag,
      maxTokens,
      `${stage}${attempt ? ':coverage-retry' : ''}`,
      cacheContext,
      history,
      attempt ? 'once' : cacheContextMode,
      signal,
    );
    try {
      exactCandidateCoverage(expected, result.items, stage);
      return result;
    } catch (error) {
      coverageError = error;
    }
  }
  throw coverageError;
}

function compactCandidate(candidate: Candidate): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    name: candidate.name,
    kind: candidate.kind,
    domain: candidate.domain,
    summary: candidate.summary,
    facts: candidate.facts.map((fact) => fact.statement),
  };
}

function dedupeFacts(candidates: Candidate[]): Candidate['facts'] {
  const facts = new Map<string, Candidate['facts'][number]>();
  for (const candidate of candidates) {
    for (const fact of candidate.facts) {
      const key = `${fact.statement}\0${JSON.stringify(fact.sources)}`;
      if (!facts.has(key)) facts.set(key, fact);
    }
  }
  return [...facts.values()];
}

function dedupeCandidateRelations(candidates: Candidate[]): Candidate['relations'] {
  const relations = new Map<string, Candidate['relations'][number]>();
  for (const candidate of candidates) {
    for (const relation of candidate.relations) {
      const key = `${relation.src}\0${relation.word}\0${relation.dst}\0${relation.factId}`;
      if (!relations.has(key)) relations.set(key, relation);
    }
  }
  return [...relations.values()];
}

function applyNormalizeMerges(candidates: Candidate[], merges: NormalizeMerge[]): Candidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const used = new Set<string>();
  const replacements = new Map<string, Candidate>();
  for (const merge of merges) {
    const memberIds = [...new Set(merge.memberIds)];
    if (!memberIds.includes(merge.canonicalId)) {
      throw new Error(`Normalize 合并 ${merge.canonicalId} 未包含 canonicalId`);
    }
    if (memberIds.some((id) => !byId.has(id))) {
      throw new Error(`Normalize 引用了未知候选：${memberIds.filter((id) => !byId.has(id)).join(',')}`);
    }
    if (memberIds.some((id) => used.has(id))) {
      throw new Error(`Normalize 候选被重复合并：${memberIds.filter((id) => used.has(id)).join(',')}`);
    }
    const members = memberIds.map((id) => byId.get(id)!);
    memberIds.forEach((id) => used.add(id));
    replacements.set(merge.canonicalId, {
      ...members[0],
      candidateId: merge.canonicalId,
      name: merge.name,
      kind: merge.kind,
      domain: merge.domain || members.find((item) => item.domain)?.domain || '',
      summary: merge.summary || members.find((item) => item.summary)?.summary || '',
      facts: dedupeFacts(members),
      relations: dedupeCandidateRelations(members),
    });
  }
  const output: Candidate[] = [];
  for (const candidate of candidates) {
    const replacement = replacements.get(candidate.candidateId);
    if (replacement) output.push(replacement);
    else if (!used.has(candidate.candidateId)) output.push(candidate);
  }
  return output;
}

async function normalizeBatch(
  runId: string,
  candidates: Candidate[],
  pass: number,
  batchIndex: number,
  history: ChatMessage[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const result = await jsonStage<{ merges: NormalizeMerge[] }>(
    runId,
    normalizeOutputSchema,
    normalizePrompt,
    { candidates: candidates.map(compactCandidate) },
    'ingest-normalize',
    6000,
    `ingest-normalize:${pass}:${batchIndex + 1}`,
    undefined,
    history,
    'once',
    signal,
  );
  const normalized = applyNormalizeMerges(candidates, result.merges);
  audit(runId, `normalize:${pass}:${batchIndex + 1}`, {
    merges: result.merges,
    inputCount: candidates.length,
    outputCount: normalized.length,
  }, candidates.map((candidate) => candidate.candidateId));
  return normalized;
}

async function normalizeCandidates(
  runId: string,
  mapped: Candidate[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  let candidates: Candidate[] = [];
  const history = createSemanticCacheSession(`ingest-normalize:${runId}`, normalizePrompt);
  const firstPass = batches(mapped, NORMALIZE_BATCH_LIMIT);
  for (let index = 0; index < firstPass.length; index++) {
    candidates.push(...await normalizeBatch(runId, firstPass[index], 1, index, history, signal));
  }
  if (firstPass.length > 1) {
    const secondPass = candidates.length <= NORMALIZE_BATCH_LIMIT
      ? [candidates]
      : spreadBatches(candidates, NORMALIZE_BATCH_LIMIT);
    const crossed: Candidate[] = [];
    for (let index = 0; index < secondPass.length; index++) {
      crossed.push(...await normalizeBatch(runId, secondPass[index], 2, index, history, signal));
    }
    candidates = crossed;
  }
  return candidates;
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
  options: { force?: boolean; reextract?: boolean; signal?: AbortSignal } = {},
): Promise<IngestStats> {
  options.signal?.throwIfAborted();
  onProgress({ stage: '解析', progress: 2, detail: relPath });
  let document: StructuredDocument;
  try {
    document = await loadSourceDocument(relPath);
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
  const prior = db.prepare(
    `SELECT content_hash,status,run_id,error FROM ingest_log WHERE path=?`
  ).get(relPath) as any;
  if (!options.force && prior?.content_hash === document.contentHash && prior.status === 'completed') {
    // 内容未变直接跳过时同样按一次管线级结果缓存命中记账：
    // 之前的运行结果被完整复用，不记账会让用量页低估整理的缓存收益。
    const reusedTokens = (db.prepare(
      `SELECT llm_prompt_tokens FROM ingest_runs WHERE id=?`
    ).get(prior.run_id) as { llm_prompt_tokens: number } | undefined)?.llm_prompt_tokens || 0;
    const active = getActiveChat();
    recordLlmResultCacheHit({
      provider: active?.provider || 'custom',
      model: active?.model || 'unknown',
      operation: 'chat',
      tag: 'ingest-pipeline-cache',
      scope: 'ingest',
      refId: prior.run_id,
      stage: 'pipeline',
      promptVersion: INGEST_PIPELINE_VERSION,
      cacheScope: 'ingest:pipeline',
      dependencyHash: prior.content_hash,
      resultCacheHit: true,
    }, 0, reusedTokens);
    return { ...EMPTY };
  }
  const inputSignature = ingestInputSignature(relPath, document, resolvedQuestions);
  const reusable = db.prepare(
    `SELECT id,stats,llm_prompt_tokens FROM ingest_runs
     WHERE path=? AND content_hash=? AND input_signature=?
       AND status='completed' AND commit_status='committed'
     ORDER BY finished_at DESC LIMIT 1`
  ).get(relPath, document.contentHash, inputSignature) as {
    id: string;
    stats: string;
    llm_prompt_tokens: number;
  } | undefined;
  // reextract：按页面触发的深度重新提炼，需绕过签名复用闸强制重跑相同内容；force 仅绕过第一道内容未变闸。
  if (!options.reextract && reusable) {
    const active = getActiveChat();
    recordLlmResultCacheHit({
      provider: active?.provider || 'custom',
      model: active?.model || 'unknown',
      operation: 'chat',
      tag: 'ingest-pipeline-cache',
      scope: 'ingest',
      refId: reusable.id,
      stage: 'pipeline',
      promptVersion: INGEST_PIPELINE_VERSION,
      cacheScope: 'ingest:pipeline',
      dependencyHash: inputSignature,
      resultCacheHit: true,
    }, 0, reusable.llm_prompt_tokens);
    return { ...EMPTY };
  }
  const previousActiveVersion = db.prepare(
    `SELECT id FROM source_versions WHERE path=? AND status='active'
     ORDER BY activated_at DESC LIMIT 1`
  ).get(relPath) as { id: string } | undefined;
  const runId = newId();
  const sourceVersion = beginSourceVersion(relPath, document.contentHash);
  db.prepare(
    `INSERT INTO ingest_runs(
       id,path,content_hash,source_version_id,status,commit_status,derived_status,input_signature,started_at
     ) VALUES(?,?,?,?, 'running','pending','pending',?,?)`
  ).run(runId, relPath, document.contentHash, sourceVersion.id, inputSignature, now());
  setStatus(relPath, document.contentHash, runId, 'running');
  if (!llmReady()) {
    const message = '未配置 LLM，无法整理';
    failSourceVersion(sourceVersion.id, runId, message);
    setStatus(relPath, document.contentHash, runId, 'failed', message);
    throw new Error(message);
  }
  try {
    if (!document.text.trim() && !resolvedQuestions.length) {
      const { stats } = commitKnowledgeItems([], {
        runId,
        sourceVersion,
        sourcePath: relPath,
        sourceName: document.title,
        sourceRef: `原始资料/${document.title}`,
      });
      audit(runId, 'commit', stats, { reason: '原始资料没有可读取正文' });
      db.prepare(`UPDATE ingest_runs SET stats=? WHERE id=?`).run(JSON.stringify(stats), runId);
      setStatus(relPath, document.contentHash, runId, 'completed');
      return stats;
    }
    const rosterEntries = loadRoster();
    const titleRoster = roster(rosterEntries);
    const MAP_CONCURRENCY = 1;
    const mapResults = await concurrentMap(document.chunks, MAP_CONCURRENCY, async (chunk, chunkIndex) => {
      options.signal?.throwIfAborted();
      onProgress({ stage: 'Map', progress: 10 + Math.round(((chunkIndex + 1) / document.chunks.length) * 24), detail: `${chunkIndex + 1}/${document.chunks.length}` });
      const history = createSemanticCacheSession(`ingest-map:${runId}`, mapPrompt);
      return mapChunk(runId, chunk, titleRoster, history, 'always', options.signal);
    });
    const rawMapped: Candidate[] = mapResults.flat();
    const mapped = rawMapped.map((candidate, index) => ({
      ...candidate,
      candidateId: `m${String(index + 1).padStart(5, '0')}`,
    }));
    audit(runId, 'map', mapped, { chunks: document.chunks.length });

    onProgress({ stage: 'Normalize', progress: 38 });
    const candidates = await normalizeCandidates(runId, mapped, options.signal);
    persistFacts(runId, candidates); audit(runId, 'normalize', candidates, mapped);
    const allowedFactIds = new Set(candidates.flatMap((candidate) => candidate.facts.map((fact) => fact.id)));
    const facts = candidates.flatMap((candidate) => candidate.facts);

    onProgress({ stage: 'Retrieve', progress: 48 });
    const related = await dynamicContext(candidates, document); audit(runId, 'retrieve', { related }, candidates.map((c) => c.name));

    onProgress({ stage: 'Plan', progress: 56 });
    const plan: PlanItem[] = [];
    const candidateBatches = batches(candidates, PLAN_BATCH_LIMIT);
    const planHistory = createSemanticCacheSession(`ingest-plan:${runId}`, planPrompt);
    for (let index = 0; index < candidateBatches.length; index++) {
      options.signal?.throwIfAborted();
      const candidateBatch = candidateBatches[index];
      const rawPlan = await coveredItemsStage<{ items: PlanItem[] }>(
        runId,
        planOutputSchema,
        planPrompt,
        { candidates: candidateBatch, related },
        candidateBatch,
        'ingest-plan',
        8000,
        `ingest-plan:${index + 1}`,
        { roster: titleRoster },
        planHistory,
        index === 0 ? 'always' : 'once',
        options.signal,
      );
      const batchPlan = whitelistFactIds(rawPlan.items, allowedFactIds).items;
      plan.push(...batchPlan);
      audit(runId, `plan:${index + 1}`, batchPlan, candidateBatch);
    }
    audit(runId, 'plan', plan, candidates);

    let reviewedPlan: PlanItem[] = [];
    const planBatches = batches(plan, PLAN_BATCH_LIMIT);
    const criticHistory = createSemanticCacheSession(`ingest-critic:${runId}`, criticPrompt);
    for (let index = 0; index < planBatches.length; index++) {
      options.signal?.throwIfAborted();
      const planBatch = planBatches[index];
      const candidateIds = new Set(planBatch.map((item) => item.candidateId));
      const candidateBatch = candidates.filter((candidate) => candidateIds.has(candidate.candidateId));
      onProgress({ stage: 'Critic', progress: 64, detail: `首次审查 ${index + 1}/${planBatches.length}` });
      const firstCritique = await coveredItemsStage<{ approved: boolean; issues: string[]; items: PlanItem[] }>(
        runId,
        criticOutputSchema,
        criticPrompt,
        { plan: planBatch, candidates: candidateBatch, related },
        planBatch,
        'ingest-critic',
        8000,
        `ingest-critic:${index + 1}`,
        { roster: titleRoster },
        criticHistory,
        index === 0 ? 'always' : 'once',
        options.signal,
      );
      const revised = whitelistFactIds(firstCritique.items, allowedFactIds).items;
      audit(runId, `critic:${index + 1}`, { ...firstCritique, items: revised }, planBatch);
      if (firstCritique.approved && !firstCritique.issues.length) {
        reviewedPlan.push(...revised);
        audit(runId, `critic_review:${index + 1}`, {
          approved: true,
          issues: [],
          skippedSecondPass: true,
          items: revised,
        }, revised);
        continue;
      }
      onProgress({ stage: 'Critic', progress: 69, detail: `修订复核 ${index + 1}/${planBatches.length}` });
      const secondCritique = await coveredItemsStage<{ approved: boolean; issues: string[]; items: PlanItem[] }>(
        runId,
        criticOutputSchema,
        criticPrompt,
        { plan: revised, candidates: candidateBatch, previousCritique: firstCritique, related },
        revised,
        'ingest-critic-review',
        8000,
        `ingest-critic-review:${index + 1}`,
        { roster: titleRoster },
        criticHistory,
        'once',
        options.signal,
      );
      let reviewedBatch = whitelistFactIds(secondCritique.items, allowedFactIds).items;
      if (!secondCritique.approved) {
        reviewedBatch = reviewedBatch.map((item) => item.action === 'skip' ? item : {
          ...item,
          action: 'review' as const,
          reason: [item.reason, ...secondCritique.issues].filter(Boolean).join('；'),
        });
      }
      reviewedPlan.push(...reviewedBatch);
      audit(runId, `critic_review:${index + 1}`, { ...secondCritique, items: reviewedBatch }, revised);
    }
    reviewedPlan = await guardAmbiguousEntityNames(
      reviewedPlan,
      candidates,
      rosterEntries,
      options.signal,
    );
    reviewedPlan = attachCandidateRelations(reviewedPlan, candidates, rosterEntries, allowedFactIds);
    audit(runId, 'critic_review', { items: reviewedPlan }, plan);

    onProgress({ stage: 'Compose', progress: 76 });
    const contentById = new Map<string, string>();
    const composeTargets = reviewedPlan.filter((item) => item.action !== 'skip');
    const composeBatches = batches(composeTargets, COMPOSE_BATCH_LIMIT);
    const composeHistory = createSemanticCacheSession(`ingest-compose:${runId}`, composePrompt);
    for (let index = 0; index < composeBatches.length; index++) {
      options.signal?.throwIfAborted();
      const composeBatch = composeBatches[index];
      const factIds = new Set(composeBatch.flatMap((item) => item.factIds));
      const batchFacts = facts.filter((fact) => factIds.has(fact.id));
      const composeInput = {
        items: composeBatch.map((item) => ({
          candidateId: item.candidateId,
          name: item.name,
          kind: item.kind,
          action: item.action,
          target: item.target,
          summary: item.summary,
          factIds: item.factIds,
          relations: item.relations,
        })),
        facts: batchFacts,
        related,
      };
      const rawComposed = await coveredItemsStage<{
        items: Array<{ candidateId: string; name: string; content: string }>;
      }>(
        runId,
        composeItemOutputListSchema,
        composePrompt,
        composeInput,
        composeBatch,
        'ingest-compose',
        9000,
        `ingest-compose:${index + 1}`,
        { roster: titleRoster },
        composeHistory,
        index === 0 ? 'always' : 'once',
        options.signal,
      );
      for (const item of rawComposed.items) contentById.set(item.candidateId, item.content);
      audit(runId, `compose:${index + 1}`, rawComposed, composeInput.items);
    }
    const composedItems: KnowledgeItem[] = reviewedPlan.map((item) => ({
      ...item,
      content: item.action === 'skip' ? '' : contentById.get(item.candidateId) || '',
    }));
    const composed = { items: whitelistFactIds(composedItems, allowedFactIds).items };
    audit(runId, 'compose', composed, reviewedPlan);

    const generatedQuestions: QuestionOutput['questions'] = [];
    const needsQuestionFinder = reviewedPlan.some((item) =>
      item.action === 'review' ||
      Boolean(item.ambiguity) ||
      item.confidence === '低' ||
      /冲突|未知|不确定/.test(item.reason)
    );
    if (needsQuestionFinder) {
      const questionHistory = createSemanticCacheSession(`ingest-questions:${runId}`, questionFinderPrompt);
      for (let index = 0; index < candidateBatches.length; index++) {
        options.signal?.throwIfAborted();
        const candidateBatch = candidateBatches[index];
        const candidateIds = new Set(candidateBatch.map((item) => item.candidateId));
        const planBatch = reviewedPlan.filter((item) => candidateIds.has(item.candidateId));
        const result = await jsonStage<QuestionOutput>(
          runId,
          questionOutputSchema,
          questionFinderPrompt,
          { candidates: candidateBatch, plan: planBatch, resolvedQuestions },
          'ingest-questions',
          6000,
          `ingest-questions:${index + 1}`,
          undefined,
          questionHistory,
          'once',
          options.signal,
        );
        generatedQuestions.push(...result.questions);
        audit(runId, `questions:${index + 1}`, result, candidateBatch.map((item) => item.candidateId));
      }
    }
    const ambiguityQuestions = reviewedPlan.flatMap((item) => item.ambiguity ? [{
      question: item.ambiguity.question,
      factIds: item.factIds,
      acceptance: item.ambiguity.category === 'role_title'
        ? ['给出完整姓名，或选择库中已有人物']
        : ['确认并入已有实体，或给出经过核实的正确名称'],
    }] : []);
    const seenQuestions = new Set<string>();
    const questions: QuestionOutput = {
      questions: [...ambiguityQuestions, ...generatedQuestions].filter((question) => {
      const key = question.question.trim();
      if (!key || seenQuestions.has(key)) return false;
      seenQuestions.add(key);
      return true;
      }),
    };
    audit(runId, 'questions', questions, candidates);

    onProgress({ stage: 'Verify', progress: 86 });
    const verifiedItems: VerifierOutput['items'] = [];
    const verifyTargets = composed.items.filter((item) => item.action !== 'skip');
    const verifyBatches = batches(verifyTargets, COMPOSE_BATCH_LIMIT);
    const verifyHistory = createSemanticCacheSession(`ingest-verify:${runId}`, verifierPrompt);
    for (let index = 0; index < verifyBatches.length; index++) {
      options.signal?.throwIfAborted();
      const verifyBatch = verifyBatches[index];
      const factIds = new Set(verifyBatch.flatMap((item) => item.factIds));
      const batchFacts = facts.filter((fact) => factIds.has(fact.id));
      const batchQuestions = questions.questions.filter((question) =>
        !question.factIds.length || question.factIds.some((factId) => factIds.has(factId))
      );
      const result = await coveredItemsStage<VerifierOutput>(
        runId,
        verifierOutputSchema,
        verifierPrompt,
        { items: verifyBatch, facts: batchFacts, questions: batchQuestions },
        verifyBatch,
        'ingest-verify',
        7000,
        `ingest-verify:${index + 1}`,
        undefined,
        verifyHistory,
        'once',
        options.signal,
      );
      verifiedItems.push(...result.items);
      audit(runId, `verify:${index + 1}`, result, verifyBatch);
    }
    // 防御性补跑：coveredItemsStage 已做批次内覆盖校验，此处补齐跨批次遗漏的验证结果，
    // 避免因单次 LLM 抖动让本可验证的候选落入待审；补跑仍失败则保留缺失，由写入门禁转 review。
    const verifiedIds = new Set(verifiedItems.map((v) => v.candidateId));
    const missingVerify = verifyTargets.filter((t) => !verifiedIds.has(t.candidateId));
    for (const target of missingVerify) {
      options.signal?.throwIfAborted();
      const missingFactIds = new Set(target.factIds);
      const missingFacts = facts.filter((fact) => missingFactIds.has(fact.id));
      const missingQuestions = questions.questions.filter((question) =>
        !question.factIds.length || question.factIds.some((factId) => missingFactIds.has(factId))
      );
      try {
        const retried = await coveredItemsStage<VerifierOutput>(
          runId,
          verifierOutputSchema,
          verifierPrompt,
          { items: [target], facts: missingFacts, questions: missingQuestions },
          [target],
          'ingest-verify',
          7000,
          `ingest-verify:retry:${target.candidateId}`,
          undefined,
          verifyHistory,
          'once',
          options.signal,
        );
        verifiedItems.push(...retried.items);
        audit(runId, `verify:retry:${target.candidateId}`, retried, [target]);
      } catch { /* 补跑仍失败则保留缺失，由写入门禁转 review */ }
    }
    const verified: VerifierOutput = { items: verifiedItems };
    audit(runId, 'verify', verified, { composed, questions });
    const safeItems = enforceWriteGate(composed.items, verified, allowedFactIds);
    options.signal?.throwIfAborted();
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
      const promptTokens = (db.prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) prompt_tokens FROM llm_usage WHERE ref_id=?`
      ).get(runId) as { prompt_tokens: number }).prompt_tokens;
      db.prepare(`UPDATE ingest_runs SET stats=?,llm_prompt_tokens=? WHERE id=?`)
        .run(JSON.stringify(stats), promptTokens, runId);
      if (options.force) finalizeSourceCandidateReingest(relPath, runId);
      syncIngestQuestionReport(relPath);
      setStatus(relPath, document.contentHash, runId, 'completed');
    });
    finish();
    try {
      const parts: string[] = [];
      if (stats.created) parts.push(`新建 ${stats.created} 页`);
      if (stats.merged) parts.push(`合并 ${stats.merged} 页`);
      if (stats.pending) parts.push(`待审 ${stats.pending} 项`);
      if (stats.skipped) parts.push(`跳过 ${stats.skipped} 项`);
      appendWikiLog('整理资料', `[[${document.title}]] → ${parts.join(' / ') || '无变更'}`);
    } catch { /* 日志失败不阻塞整理结果 */ }
    onProgress({ stage: 'Commit', progress: 100, detail: '提交完成' });
    return stats;
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 2000);
    const cancelled = Boolean(options.signal?.aborted);
    const attemptError = cancelled ? '用户取消整理' : message;
    restoreSourceAfterAttempt(
      sourceVersion.id,
      previousActiveVersion?.id,
      runId,
      relPath,
      cancelled ? 'cancelled' : 'failed',
      attemptError,
    );
    if (prior?.status === 'completed' && prior.content_hash && prior.run_id) {
      setStatus(relPath, prior.content_hash, prior.run_id, 'completed', prior.error || null);
    } else {
      setStatus(
        relPath,
        document.contentHash,
        runId,
        cancelled ? 'cancelled' : 'failed',
        attemptError,
      );
    }
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
      if ([
        'md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx',
        ...EXTRACTABLE_EXTENSIONS,
      ].includes(ext)) output.push(child);
    }
  };
  walk('原始资料');
  return output;
}

export { extractWikiLinks };
