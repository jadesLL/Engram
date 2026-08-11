import fs from 'node:fs';
import path from 'node:path';
import { db, newId, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { safeJoin } from '../lib/vault.js';
import { hybridSearch } from '../retrieval/hybrid.js';
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

export type { IngestStats } from './knowledgeCommit.js';
export type IngestStage = '解析' | 'Map' | 'Normalize' | 'Plan' | 'Critic' | 'Retrieve' | 'Compose' | 'Verify' | 'Commit';
export type IngestProgress = { stage: IngestStage; progress: number; detail?: string };
export type IngestProgressCallback = (update: IngestProgress) => void;
const EMPTY: IngestStats = { created: 0, merged: 0, skipped: 0, pending: 0 };

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

async function jsonStage<T>(
  runId: string,
  schema: any,
  system: string,
  input: unknown,
  tag: string,
  maxTokens = 8000,
  stage = tag,
): Promise<T> {
  return runSemanticStage<T>({
    scope: 'ingest',
    refId: runId,
    stage,
    tag,
    schema,
    system,
    input,
    temperature: 0.1,
    maxTokens,
    retries: 1,
  });
}

function validateFacts(candidates: Candidate[], chunks: Iterable<Pick<DocumentChunk, 'id' | 'content'>>): Candidate[] {
  const byId = new Map([...chunks].map((chunk) => [chunk.id, chunk.content]));
  return candidates.map((candidate) => ({
    ...candidate,
    facts: candidate.facts.filter((fact) => fact.sources.length > 0 && fact.sources.every((source) => byId.get(source.chunkId)?.includes(source.quote))),
  })).filter((candidate) => candidate.facts.length > 0);
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
  return /解析|截断|json|schema|validation|at most|too_big|最多|结构校验/i
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
): Promise<Candidate[]> {
  try {
    const out = await jsonStage<{ candidates: Candidate[] }>(
      runId,
      mapOutputSchema,
      mapPrompt(chunk.id, titleRoster),
      `分段 ${chunk.id} [${chunk.start},${chunk.end})：\n${chunk.content}`,
      'ingest-map',
      8000,
      `ingest-map:${chunk.id}`,
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
        for (const part of parts) mapped.push(...await mapChunk(runId, part, titleRoster));
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
      for (const part of parts) mapped.push(...await mapChunk(runId, part, titleRoster));
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
): Promise<T> {
  let coverageError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const correction = attempt
      ? '\n上一轮输出遗漏、重复或修改了 candidateId。请严格逐项覆盖输入中的全部 candidateId。'
      : '';
    const result = await jsonStage<T>(
      runId,
      schema,
      `${system}${correction}`,
      input,
      tag,
      maxTokens,
      `${stage}${attempt ? ':coverage-retry' : ''}`,
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
): Promise<Candidate[]> {
  const result = await jsonStage<{ merges: NormalizeMerge[] }>(
    runId,
    normalizeOutputSchema,
    normalizePrompt,
    { candidates: candidates.map(compactCandidate) },
    'ingest-normalize',
    6000,
    `ingest-normalize:${pass}:${batchIndex + 1}`,
  );
  const normalized = applyNormalizeMerges(candidates, result.merges);
  audit(runId, `normalize:${pass}:${batchIndex + 1}`, {
    merges: result.merges,
    inputCount: candidates.length,
    outputCount: normalized.length,
  }, candidates.map((candidate) => candidate.candidateId));
  return normalized;
}

async function normalizeCandidates(runId: string, mapped: Candidate[]): Promise<Candidate[]> {
  let candidates: Candidate[] = [];
  const firstPass = batches(mapped, NORMALIZE_BATCH_LIMIT);
  for (let index = 0; index < firstPass.length; index++) {
    candidates.push(...await normalizeBatch(runId, firstPass[index], 1, index));
  }
  if (firstPass.length > 1) {
    const secondPass = candidates.length <= NORMALIZE_BATCH_LIMIT
      ? [candidates]
      : spreadBatches(candidates, NORMALIZE_BATCH_LIMIT);
    const crossed: Candidate[] = [];
    for (let index = 0; index < secondPass.length; index++) {
      crossed.push(...await normalizeBatch(runId, secondPass[index], 2, index));
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
  options: { force?: boolean } = {},
): Promise<IngestStats> {
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
    const rawMapped: Candidate[] = [];
    for (let chunkIndex = 0; chunkIndex < document.chunks.length; chunkIndex++) {
      const chunk = document.chunks[chunkIndex];
      onProgress({ stage: 'Map', progress: 10 + Math.round(((chunkIndex + 1) / document.chunks.length) * 24), detail: `${chunkIndex + 1}/${document.chunks.length}` });
      rawMapped.push(...await mapChunk(runId, chunk, titleRoster));
    }
    const mapped = rawMapped.map((candidate, index) => ({
      ...candidate,
      candidateId: `m${String(index + 1).padStart(5, '0')}`,
    }));
    audit(runId, 'map', mapped, { chunks: document.chunks.length });

    onProgress({ stage: 'Normalize', progress: 38 });
    const candidates = await normalizeCandidates(runId, mapped);
    persistFacts(runId, candidates); audit(runId, 'normalize', candidates, mapped);
    const allowedFactIds = new Set(candidates.flatMap((candidate) => candidate.facts.map((fact) => fact.id)));
    const facts = candidates.flatMap((candidate) => candidate.facts);

    onProgress({ stage: 'Retrieve', progress: 48 });
    const related = await dynamicContext(candidates, document); audit(runId, 'retrieve', { related }, candidates.map((c) => c.name));

    onProgress({ stage: 'Plan', progress: 56 });
    const plan: PlanItem[] = [];
    const candidateBatches = batches(candidates, PLAN_BATCH_LIMIT);
    for (let index = 0; index < candidateBatches.length; index++) {
      const candidateBatch = candidateBatches[index];
      const rawPlan = await coveredItemsStage<{ items: PlanItem[] }>(
        runId,
        planOutputSchema,
        planPrompt(titleRoster, related),
        { candidates: candidateBatch },
        candidateBatch,
        'ingest-plan',
        8000,
        `ingest-plan:${index + 1}`,
      );
      const batchPlan = whitelistFactIds(rawPlan.items, allowedFactIds).items;
      plan.push(...batchPlan);
      audit(runId, `plan:${index + 1}`, batchPlan, candidateBatch);
    }
    audit(runId, 'plan', plan, candidates);

    let reviewedPlan: PlanItem[] = [];
    const planBatches = batches(plan, PLAN_BATCH_LIMIT);
    for (let index = 0; index < planBatches.length; index++) {
      const planBatch = planBatches[index];
      const candidateIds = new Set(planBatch.map((item) => item.candidateId));
      const candidateBatch = candidates.filter((candidate) => candidateIds.has(candidate.candidateId));
      onProgress({ stage: 'Critic', progress: 64, detail: `首次审查 ${index + 1}/${planBatches.length}` });
      const firstCritique = await coveredItemsStage<{ approved: boolean; issues: string[]; items: PlanItem[] }>(
        runId,
        criticOutputSchema,
        criticPrompt,
        { plan: planBatch, candidates: candidateBatch, roster: titleRoster, related },
        planBatch,
        'ingest-critic',
        8000,
        `ingest-critic:${index + 1}`,
      );
      const revised = whitelistFactIds(firstCritique.items, allowedFactIds).items;
      audit(runId, `critic:${index + 1}`, { ...firstCritique, items: revised }, planBatch);
      onProgress({ stage: 'Critic', progress: 69, detail: `修订复核 ${index + 1}/${planBatches.length}` });
      const secondCritique = await coveredItemsStage<{ approved: boolean; issues: string[]; items: PlanItem[] }>(
        runId,
        criticOutputSchema,
        criticPrompt,
        { plan: revised, candidates: candidateBatch, roster: titleRoster, related, previousCritique: firstCritique },
        revised,
        'ingest-critic-review',
        8000,
        `ingest-critic-review:${index + 1}`,
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
    reviewedPlan = await guardAmbiguousEntityNames(reviewedPlan, candidates, rosterEntries);
    reviewedPlan = attachCandidateRelations(reviewedPlan, candidates, rosterEntries, allowedFactIds);
    audit(runId, 'critic_review', { items: reviewedPlan }, plan);

    onProgress({ stage: 'Compose', progress: 76 });
    const contentById = new Map<string, string>();
    const composeTargets = reviewedPlan.filter((item) => item.action !== 'skip');
    const composeBatches = batches(composeTargets, COMPOSE_BATCH_LIMIT);
    for (let index = 0; index < composeBatches.length; index++) {
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
      };
      const rawComposed = await coveredItemsStage<{
        items: Array<{ candidateId: string; name: string; content: string }>;
      }>(
        runId,
        composeItemOutputListSchema,
        composePrompt(titleRoster, related),
        composeInput,
        composeBatch,
        'ingest-compose',
        9000,
        `ingest-compose:${index + 1}`,
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
    for (let index = 0; index < candidateBatches.length; index++) {
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
      );
      generatedQuestions.push(...result.questions);
      audit(runId, `questions:${index + 1}`, result, candidateBatch.map((item) => item.candidateId));
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
    for (let index = 0; index < verifyBatches.length; index++) {
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
      );
      verifiedItems.push(...result.items);
      audit(runId, `verify:${index + 1}`, result, verifyBatch);
    }
    const verified: VerifierOutput = { items: verifiedItems };
    audit(runId, 'verify', verified, { composed, questions });
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
      if (options.force) finalizeSourceCandidateReingest(relPath, runId);
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
