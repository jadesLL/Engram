import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { db, newId, now } from '../lib/db.js';
import { chatJsonSchema, llmReady } from '../lib/llm.js';
import { createPage, readPage, safeJoin, writePage } from '../lib/vault.js';
import { docxToText } from './docx.js';
import { xlsxToText, pptxToText } from './office.js';
import { chunkLosslessly, assertLosslessChunks } from './losslessChunker.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { TYPE_DIR, isEntity } from '../lib/pageTypes.js';
import { extractWikiLinks } from './extractor.js';
import { addReports } from '../dream/reports.js';
import {
  composedItemSchema, composeOutputSchema, composeItemOutputListSchema, criticOutputSchema, mapOutputSchema, normalizeOutputSchema,
  planOutputSchema, questionOutputSchema, verifierOutputSchema,
  type Candidate, type ComposedItem, type StructuredDocument, type PlanItem,
  type QuestionOutput, type VerifierOutput,
} from './ingestModel.js';
import { enforceWriteGate, whitelistFactIds } from './ingestGuards.js';
import {
  composePrompt, criticPrompt, mapPrompt, normalizePrompt, planPrompt,
  questionFinderPrompt, verifierPrompt,
} from '../prompts/ingestPipeline.js';

export interface IngestStats { created: number; merged: number; skipped: number; pending: number }
export type IngestStage = '解析' | 'Map' | 'Normalize' | 'Plan' | 'Critic' | 'Retrieve' | 'Compose' | 'Verify' | 'Commit';
export type IngestProgress = { stage: IngestStage; progress: number; detail?: string };
export type IngestProgressCallback = (update: IngestProgress) => void;
const EMPTY: IngestStats = { created: 0, merged: 0, skipped: 0, pending: 0 };
const KIND_TYPE: Record<string, string> = { concept: 'concept', person: 'person', project: 'project', org: 'org' };

function hash(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function today(): string { return new Date().toISOString().slice(0, 10); }
function sourceMarker(runId: string, factIds: string[]): string { return `<!-- ingest:${runId};facts:${factIds.join(',')} -->`; }

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

function roster(limit = 100): string {
  return (db.prepare(`SELECT title, type, summary FROM pages WHERE deleted=0 AND path LIKE 'Wiki/%' ORDER BY updated_at DESC LIMIT ?`).all(limit) as any[])
    .map((row) => `- ${row.title}（${row.type || '未分类'}）${row.summary ? `：${row.summary.slice(0, 80)}` : ''}`).join('\n');
}

async function dynamicContext(candidates: Candidate[], document: StructuredDocument): Promise<string> {
  const queries = [...new Set(candidates.map((c) => `${c.name} ${c.summary}`))].slice(0, 12);
  if (!queries.length) queries.push(`${document.title} ${document.text.slice(0, 300)}`);
  const lines = new Set<string>();
  for (const query of queries) {
    try {
      const hits = await hybridSearch(query, 5);
      for (const hit of hits.filter((h) => h.refType === 'page')) lines.add(`- ${hit.title}（${hit.type || '未分类'}）：${hit.snippet.replace(/\n/g, ' ').slice(0, 180)}`);
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

function knownTitles(extra: string[]): Set<string> {
  const set = new Set((db.prepare(`SELECT lower(title) title FROM pages WHERE deleted=0 AND path LIKE 'Wiki/%'`).all() as any[]).map((r) => r.title));
  extra.forEach((title) => set.add(title.toLowerCase()));
  return set;
}
function stripDeadLinks(content: string, known: Set<string>): string {
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (full, target: string, alias?: string) => known.has(target.trim().toLowerCase()) ? full : (alias || target).trim());
}

function entityBody(item: ComposedItem, marker: string): string {
  return `# ${item.name}\n\n${item.content.trim()}\n${marker}\n\n## 时间线\n`;
}
function conceptBody(item: ComposedItem, sourceRef: string, marker: string): string {
  return `# ${item.name}\n\n${item.content.trim()}\n\n---\n> 来源：${sourceRef}\n${marker}\n`;
}
function generatedSection(runId: string, sourceRef: string, marker: string, content: string): string {
  return `<!-- ingest-section:${runId}:start -->\n## AI 提炼（${today()}）\n\n> 来自 ${sourceRef}\n${marker}\n\n${content.trim()}\n<!-- ingest-section:${runId}:end -->`;
}
function mergeBody(old: string, item: ComposedItem, sourceRef: string, marker: string, runId: string): string {
  const section = generatedSection(runId, sourceRef, marker, item.content);
  const sectionPattern = new RegExp(`<!-- ingest-section:${runId}:start -->[\\s\\S]*?<!-- ingest-section:${runId}:end -->`);
  if (sectionPattern.test(old)) return old.replace(sectionPattern, section);
  return `${old.replace(/\n*$/, '')}\n\n${section}\n`;
}
function pending(item: ComposedItem, source: string, reason: string, runId: string) {
  const payload = { name: item.name, kind: item.kind, source, reason, runId, confidence: item.confidence, target: item.target, summary: item.summary, content: item.content, factIds: item.factIds };
  addReports([{ kind: 'pending_review', payload }]);
}

export function applyReviewedCandidate(payload: Record<string, any>, kind: 'concept' | 'person' | 'project' | 'org'): { id: string; path: string } {
  const item = composedItemSchema.parse({
    name: payload.name,
    kind,
    action: 'create',
    target: '',
    domain: payload.domain || '',
    confidence: payload.confidence || '中',
    summary: payload.summary || '',
    factIds: Array.isArray(payload.factIds) ? payload.factIds : [],
    reason: payload.reason || '',
    content: payload.content || payload.summary || '',
  });
  const markerRunId = payload.runId || `review-${hash(`${item.name}:${payload.source || ''}`).slice(0, 16)}`;
  const existing = db.prepare(`SELECT id, path FROM pages WHERE deleted=0 AND lower(title)=lower(?) AND path LIKE 'Wiki/%'`).get(item.name) as any;
  if (existing) {
    const page = readPage(existing.path);
    if (!page) throw new Error('审核目标页面无法读取');
    const marker = sourceMarker(markerRunId, item.factIds);
    if (!page.content.includes(marker)) {
      writePage(existing.path, mergeBody(page.content, item, payload.source || '人工审核', marker, markerRunId), { summary: item.summary });
    }
    return existing;
  }
  const dir = TYPE_DIR[item.kind];
  if (!dir) throw new Error('审核类型无效');
  const page = createPage(dir, item.name);
  const marker = sourceMarker(markerRunId, item.factIds);
  const sourceRef = payload.source || '人工审核';
  writePage(page.path, isEntity(item.kind) ? entityBody(item, marker) : conceptBody(item, sourceRef, marker), {
    type: item.kind, domain: item.domain, confidence: item.confidence, retrieved: today(), summary: item.summary,
    sources: payload.source ? [payload.source] : [],
  });
  return { id: page.id, path: page.path };
}

function commit(items: ComposedItem[], runId: string, sourceName: string, sourceRef: string): IngestStats {
  const stats = { ...EMPTY };
  const find = db.prepare(`SELECT id, path FROM pages WHERE deleted=0 AND lower(title)=lower(?)`);
  const known = knownTitles(items.map((item) => item.name));
  for (const item of items) {
    if (item.action === 'skip') { stats.skipped++; continue; }
    if (item.action === 'review') { pending(item, sourceName, item.reason || '需要人工确认', runId); stats.pending++; continue; }
    const targetName = item.action === 'merge' ? item.target : item.name;
    const existing = find.get(targetName) as any;
    if (item.action === 'merge' && (!existing || !existing.path.startsWith('Wiki/'))) {
      pending(item, sourceName, `合并目标「${targetName}」不存在`, runId); stats.pending++; continue;
    }
    const marker = sourceMarker(runId, item.factIds);
    const content = stripDeadLinks(item.content, known);
    const clean = { ...item, content };
    if (existing?.path.startsWith('Wiki/')) {
      const page = readPage(existing.path);
      if (!page || page.content.includes(marker)) { stats.skipped++; continue; }
      writePage(existing.path, mergeBody(page.content, clean, sourceRef, marker, runId), { summary: item.summary });
      stats.merged++;
    } else {
      const dir = TYPE_DIR[item.kind];
      if (!dir) { pending(item, sourceName, '类型不清', runId); stats.pending++; continue; }
      const page = createPage(dir, item.name);
      const type = KIND_TYPE[item.kind];
      writePage(page.path, isEntity(type) ? entityBody(clean, marker) : conceptBody(clean, sourceRef, marker), {
        type, domain: item.domain, confidence: item.confidence, retrieved: today(), summary: item.summary, sources: [sourceName],
      });
      stats.created++;
    }
  }
  return stats;
}

export async function ingestRawFile(relPath: string, onProgress: IngestProgressCallback = () => {}): Promise<IngestStats> {
  if (!llmReady()) throw new Error('未配置 LLM，无法整理');
  onProgress({ stage: '解析', progress: 2, detail: relPath });
  const document = await loadDocument(relPath);
  onProgress({ stage: '解析', progress: 8, detail: `${document.chunks.length} 个分段` });
  if (document.text.length < 30) return { ...EMPTY };
  const prior = db.prepare(`SELECT content_hash, status FROM ingest_log WHERE path=?`).get(relPath) as any;
  if (prior?.content_hash === document.contentHash && prior.status === 'completed') return { ...EMPTY };
  const runId = newId();
  db.prepare(`INSERT INTO ingest_runs(id,path,content_hash,status,started_at) VALUES(?,?,?,?,?)`).run(runId, relPath, document.contentHash, 'running', now());
  setStatus(relPath, document.contentHash, runId, 'running');
  try {
    const titleRoster = roster();
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
    // 硬性守卫：单事实 create 项信息量不足以独立成页，降级为 review（不依赖 LLM 自觉）
    reviewedPlan = reviewedPlan.map((item) => {
      if (item.action === 'create' && item.factIds.length <= 1) {
        return { ...item, action: 'review' as const, reason: [item.reason, '仅单条事实支撑，信息量不足以独立成页'].filter(Boolean).join('；') };
      }
      return item;
    });
    audit(runId, 'critic_review', { ...secondCritique, items: reviewedPlan }, revised);

    onProgress({ stage: 'Compose', progress: 76 });
    // Compose：LLM 只输出 {name, content}，其余字段从 plan 继承；传入 roster/related 让正文关联知识库
    const composeInput = {
      items: reviewedPlan.map((it) => ({ name: it.name, kind: it.kind, action: it.action, target: it.target, summary: it.summary, factIds: it.factIds })),
      facts,
    };
    const rawComposed = await jsonStage<{ items: { name: string; content: string }[] }>(
      composeItemOutputListSchema, composePrompt(titleRoster, related), composeInput, 'ingest-compose', 12000
    );
    // 按 name 匹配回 reviewedPlan，合并出完整 ComposedItem[]
    const contentByName = new Map(rawComposed.items.map((it) => [it.name.trim().toLowerCase(), it.content]));
    const composedItems: ComposedItem[] = reviewedPlan.map((plan) => ({
      ...plan,
      content: contentByName.get(plan.name.trim().toLowerCase()) || '',
    }));
    const composed = { items: whitelistFactIds(composedItems, allowedFactIds).items };
    audit(runId, 'compose', composed, reviewedPlan);

    const questions = await jsonStage<QuestionOutput>(questionOutputSchema, questionFinderPrompt, { candidates, plan: reviewedPlan }, 'ingest-questions'); audit(runId, 'questions', questions, candidates);
    onProgress({ stage: 'Verify', progress: 86 });
    const verified = await jsonStage<VerifierOutput>(verifierOutputSchema, verifierPrompt, { items: composed.items, facts, questions: questions.questions }, 'ingest-verify'); audit(runId, 'verify', verified, { composed, questions });
    const safeItems = enforceWriteGate(composed.items, verified, allowedFactIds);
    const rawPage = db.prepare(`SELECT title FROM pages WHERE path=? AND deleted=0`).get(relPath) as any;
    const sourceRef = rawPage ? `[[${rawPage.title}]]` : `原始资料/${document.title}`;
    onProgress({ stage: 'Commit', progress: 94 });
    const stats = commit(safeItems, runId, document.title, sourceRef);
    const finish = db.transaction(() => {
      if (questions.questions.length) {
        addReports([{ kind: 'ingest_questions', payload: { path: relPath, runId, contentHash: document.contentHash, questions: questions.questions } }]);
      }
      audit(runId, 'commit', stats, safeItems.map((item) => ({ name: item.name, action: item.action })));
      db.prepare(`UPDATE ingest_runs SET status='completed', finished_at=?, stats=? WHERE id=? AND status='running'`).run(now(), JSON.stringify(stats), runId);
      setStatus(relPath, document.contentHash, runId, 'completed');
    });
    finish();
    onProgress({ stage: 'Commit', progress: 100, detail: '提交完成' });
    return stats;
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 2000);
    db.prepare(`UPDATE ingest_runs SET status='failed', finished_at=?, error=? WHERE id=?`).run(now(), message, runId);
    setStatus(relPath, document.contentHash, runId, 'failed', message);
    throw error;
  }
}

export async function ingestAllRaw(): Promise<string[]> {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(safeJoin('原始资料'), { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => !e.isDirectory() && !e.name.startsWith('.') && ['md', 'markdown', 'docx', 'xlsx', 'pptx'].includes(path.extname(e.name).slice(1).toLowerCase())).map((e) => `原始资料/${e.name}`);
}

export { extractWikiLinks };
