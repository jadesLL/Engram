import crypto from 'node:crypto';
import { z } from 'zod';
import { db, newId, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { readPage, readPageMeta, writePage } from '../lib/vault.js';
import { isEntity } from '../lib/pageTypes.js';
import { enqueue } from '../jobQueue.js';
import { addReports } from '../dream/reports.js';
import { pageSynthesisPrompt, pageSynthesisVerifyPrompt } from '../prompts/pageSynthesis.js';
import { allPageContributions, contributionsForProjection, type StoredContribution } from './sourceLedger.js';
import {
  extractEntityManualSections,
  extractEntitySynthesis,
  renderEntitySynthesisProjection,
  renderEntitySections,
  type EntitySections,
  type EntitySynthesisSections,
} from './knowledgePage.js';

const evidenceClaimSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1)).min(1).max(30),
});

const synthesisOutputSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  domain: z.string().trim().max(120).default(''),
  confidence: z.enum(['高', '中', '低']).default('中'),
  sections: z.array(z.object({
    heading: z.string().trim().max(80).default(''),
    paragraphs: z.array(evidenceClaimSchema).max(12).default([]),
    bullets: z.array(evidenceClaimSchema).max(30).default([]),
  })).min(1).max(12),
  related: z.preprocess(
    (value) => Array.isArray(value)
      ? value.filter((item: any) =>
          item && typeof item === 'object' &&
          typeof item.title === 'string' &&
          typeof item.note === 'string' &&
          Array.isArray(item.evidenceIds) &&
          item.evidenceIds.length > 0
        )
      : [],
    z.array(z.object({
      title: z.string().trim().min(1).max(120),
      note: z.string().trim().min(1).max(500),
      evidenceIds: z.array(z.string().min(1)).min(1).max(30),
    })).max(30),
  ),
  timeline: z.preprocess(
    (value) => Array.isArray(value)
      ? value.filter((item: any) =>
          item && typeof item === 'object' &&
          typeof item.date === 'string' &&
          typeof item.event === 'string' &&
          Array.isArray(item.evidenceIds) &&
          item.evidenceIds.length > 0
        )
      : [],
    z.array(z.object({
      date: z.string().trim().min(1).max(40),
      event: z.string().trim().min(1).max(800),
      evidenceIds: z.array(z.string().min(1)).min(1).max(30),
    })).max(40),
  ),
  unresolvedConflicts: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  manualChangesPreserved: z.boolean().default(true),
});

const synthesisVerifySchema = z.object({
  pass: z.boolean(),
  unsupported: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  manualChangesPreserved: z.boolean().default(true),
});

type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;
type SynthesisVerifyOutput = z.infer<typeof synthesisVerifySchema>;

export interface PageEvidenceFact {
  id: string;
  runId: string;
  factId: string;
  statement: string;
  sourcePath: string;
  sourceRef: string;
  sourceVersionId: string;
  quotes: Array<{ chunkId: string; quote: string }>;
}

interface PageEvidenceBundle {
  page: { id: string; path: string; title: string; type: string };
  contributions: StoredContribution[];
  facts: PageEvidenceFact[];
  relations: Array<{ src: string; word: string; dst: string; evidenceId: string }>;
  sourceVersionIds: string[];
  evidenceHash: string;
}

export interface StoredPageSynthesis {
  id: string;
  page_id: string;
  input_hash: string;
  evidence_hash: string;
  trigger_run_id: string | null;
  status: string;
  summary: string;
  domain: string;
  confidence: string;
  current_content: string;
  related_content: string;
  timeline_content: string;
  evidence_map: string;
  source_version_ids: string;
  manual_changed: number;
  error: string;
  created_at: string;
  updated_at: string;
}

interface SynthesisInputState {
  active: StoredPageSynthesis | null;
  extracted: EntitySynthesisSections | null;
  manualSections: EntitySections;
  manualChanged: boolean;
  markerMissing: boolean;
  inputHash: string;
}

interface EvidenceMap {
  sections: Array<{
    heading: string;
    claims: Array<{ kind: 'paragraph' | 'bullet'; text: string; evidenceIds: string[] }>;
  }>;
  related: Array<{ title: string; note: string; evidenceIds: string[] }>;
  timeline: Array<{ date: string; event: string; evidenceIds: string[] }>;
}

class PageSynthesisConflict extends Error {}
const PAGE_SYNTHESIS_VERSION = 2;

function sha(value: unknown): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clean(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function sameContent(a: string, b: string): boolean {
  return clean(a) === clean(b);
}

function factLookup(runId: string, rawFactId: string): {
  runId: string;
  factId: string;
  statement: string;
  sources: string;
} | null {
  const direct = db.prepare(
    `SELECT run_id runId,fact_id factId,statement,sources
     FROM ingest_facts WHERE run_id=? AND fact_id=?`
  ).get(runId, rawFactId) as any;
  if (direct) return direct;
  const separator = rawFactId.indexOf(':');
  if (separator <= 0) return null;
  return db.prepare(
    `SELECT run_id runId,fact_id factId,statement,sources
     FROM ingest_facts WHERE run_id=? AND fact_id=?`
  ).get(rawFactId.slice(0, separator), rawFactId.slice(separator + 1)) as any || null;
}

function evidenceId(runId: string, factId: string): string {
  return `${runId}:${factId}`;
}

function loadPageEvidence(pageId: string): PageEvidenceBundle | null {
  const page = db.prepare(
    `SELECT id,path,title,type FROM pages WHERE id=? AND deleted=0`
  ).get(pageId) as PageEvidenceBundle['page'] | undefined;
  if (!page || !isEntity(page.type)) return null;
  const contributions = contributionsForProjection(pageId);
  const facts = new Map<string, PageEvidenceFact>();
  const relations: PageEvidenceBundle['relations'] = [];
  for (const contribution of contributions) {
    for (const rawFactId of parseArray<string>(contribution.fact_ids)) {
      const row = factLookup(contribution.run_id, rawFactId);
      if (!row) continue;
      const id = evidenceId(row.runId, row.factId);
      if (!facts.has(id)) {
        facts.set(id, {
          id,
          runId: row.runId,
          factId: row.factId,
          statement: row.statement,
          sourcePath: contribution.source_path,
          sourceRef: contribution.source_ref || contribution.source_path,
          sourceVersionId: contribution.source_version_id,
          quotes: parseArray<{ chunkId: string; quote: string }>(row.sources)
            .filter((source) => source.chunkId && source.quote),
        });
      }
    }
    for (const relation of parseArray<{ src: string; word: string; dst: string; factId: string }>(contribution.relations)) {
      const fact = factLookup(contribution.run_id, relation.factId);
      if (!fact || !relation.src || !relation.word || !relation.dst) continue;
      relations.push({
        src: relation.src,
        word: relation.word,
        dst: relation.dst,
        evidenceId: evidenceId(fact.runId, fact.factId),
      });
    }
  }
  const factList = [...facts.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sourceVersionIds = [...new Set(contributions.map((item) => item.source_version_id))].sort();
  const evidenceHash = sha({
    sourceVersionIds,
    facts: factList.map((fact) => ({
      id: fact.id,
      statement: fact.statement,
      sourcePath: fact.sourcePath,
      quotes: fact.quotes,
    })),
    relations: relations.slice().sort((a, b) =>
      `${a.src}\0${a.word}\0${a.dst}\0${a.evidenceId}`.localeCompare(
        `${b.src}\0${b.word}\0${b.dst}\0${b.evidenceId}`,
      )
    ),
  });
  return { page, contributions, facts: factList, relations, sourceVersionIds, evidenceHash };
}

export function activePageSynthesis(pageId: string): StoredPageSynthesis | null {
  return db.prepare(
    `SELECT * FROM page_syntheses
     WHERE page_id=? AND status='active' ORDER BY updated_at DESC LIMIT 1`
  ).get(pageId) as StoredPageSynthesis | undefined || null;
}

export function hasActivePageSynthesis(pageId: string): boolean {
  return Boolean(activePageSynthesis(pageId));
}

function inputState(bundle: PageEvidenceBundle, body: string): SynthesisInputState {
  const active = activePageSynthesis(bundle.page.id);
  const extracted = extractEntitySynthesis(body, bundle.page.title);
  const manualSections = extractEntityManualSections(
    body,
    bundle.page.title,
    allPageContributions(bundle.page.id),
  );
  const markerMissing = Boolean(active && (!extracted || extracted.id !== active.id));
  const manualChanged = Boolean(active && extracted && extracted.id === active.id && (
    !sameContent(extracted.current, active.current_content) ||
    !sameContent(extracted.related, active.related_content) ||
    !sameContent(extracted.timeline, active.timeline_content)
  ));
  const edited = manualChanged && extracted ? {
    current: extracted.current,
    related: extracted.related,
    timeline: extracted.timeline,
  } : null;
  return {
    active,
    extracted,
    manualSections,
    manualChanged,
    markerMissing,
    inputHash: sha({
      synthesisVersion: PAGE_SYNTHESIS_VERSION,
      evidenceHash: bundle.evidenceHash,
      manual: {
        current: manualSections.current,
        related: manualSections.related,
        timeline: manualSections.timeline,
      },
      edited,
      markerMissing,
    }),
  };
}

function knownRoster(): { text: string; titles: Set<string> } {
  const rows = db.prepare(
    `SELECT title,type,summary FROM pages WHERE deleted=0
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
     ORDER BY updated_at DESC LIMIT 2000`
  ).all() as Array<{ title: string; type: string; summary: string }>;
  return {
    text: rows.map((row) =>
      `- ${row.title}（${row.type || '未分类'}）${row.summary ? `：${row.summary.slice(0, 100)}` : ''}`
    ).join('\n'),
    titles: new Set(rows.map((row) => row.title.toLowerCase())),
  };
}

function validateEvidenceIds(output: SynthesisOutput, allowed: Set<string>): void {
  const groups = [
    ...output.sections.flatMap((section) => [...section.paragraphs, ...section.bullets]),
    ...output.related,
    ...output.timeline,
  ];
  for (const claim of groups) {
    if (!claim.evidenceIds.length || claim.evidenceIds.some((id) => !allowed.has(id))) {
      throw new Error(`综合草稿包含无效证据引用：${claim.evidenceIds.join(', ')}`);
    }
  }
}

function filterTimelineEvidence(output: SynthesisOutput, facts: PageEvidenceFact[]): SynthesisOutput {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const timeline = output.timeline.filter((item) => {
    const year = item.date.match(/\d{4}/)?.[0];
    const month = item.date.match(/\d{1,2}月/)?.[0];
    if (!year && !month && !/Q[1-4]/i.test(item.date)) return false;
    const evidence = item.evidenceIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((fact) => `${fact!.statement}\n${fact!.quotes.map((quote) => quote.quote).join('\n')}`)
      .join('\n');
    return !((year && !evidence.includes(year)) || (!year && month && !evidence.includes(month)));
  });
  return { ...output, timeline };
}

function normalizeText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim();
}

function renderOutput(
  output: SynthesisOutput,
  knownTitles: Set<string>,
  facts: PageEvidenceFact[],
): {
  sections: EntitySynthesisSections;
  evidenceMap: EvidenceMap;
} {
  const sectionMap: EvidenceMap['sections'] = [];
  const currentLines: string[] = [];
  for (const section of output.sections) {
    const heading = normalizeText(section.heading);
    if (heading) currentLines.push(`### ${heading}`, '');
    const claims: EvidenceMap['sections'][number]['claims'] = [];
    for (const paragraph of section.paragraphs) {
      const text = normalizeText(paragraph.text);
      if (!text) continue;
      currentLines.push(text, '');
      claims.push({ kind: 'paragraph', text, evidenceIds: [...new Set(paragraph.evidenceIds)] });
    }
    for (const bullet of section.bullets) {
      const text = normalizeText(bullet.text);
      if (!text) continue;
      currentLines.push(`- ${text}`);
      claims.push({ kind: 'bullet', text, evidenceIds: [...new Set(bullet.evidenceIds)] });
    }
    if (section.bullets.length) currentLines.push('');
    if (claims.length) sectionMap.push({ heading, claims });
  }

  const relatedMap: EvidenceMap['related'] = [];
  const relatedLines: string[] = [];
  const seenRelated = new Set<string>();
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  for (const item of output.related) {
    const key = item.title.toLowerCase();
    if (!knownTitles.has(key) || seenRelated.has(key)) continue;
    const supportingFact = item.evidenceIds
      .map((id) => factsById.get(id))
      .find((fact) => fact && (
        fact.statement.includes(item.title) ||
        fact.quotes.some((quote) => quote.quote.includes(item.title))
      ));
    if (!supportingFact) continue;
    seenRelated.add(key);
    const note = normalizeText(supportingFact.statement);
    relatedLines.push(`- [[${item.title}]]：${note}`);
    relatedMap.push({
      title: item.title,
      note,
      evidenceIds: [...new Set(item.evidenceIds)],
    });
  }

  const timelineMap: EvidenceMap['timeline'] = [];
  const timelineLines: string[] = [];
  const seenTimeline = new Set<string>();
  for (const item of output.timeline) {
    const date = normalizeText(item.date);
    const event = normalizeText(item.event);
    const key = `${date}\0${event}`;
    if (seenTimeline.has(key)) continue;
    seenTimeline.add(key);
    timelineLines.push(`- ${date}：${event}`);
    timelineMap.push({
      date,
      event,
      evidenceIds: [...new Set(item.evidenceIds)],
    });
  }

  return {
    sections: {
      id: '',
      current: clean(currentLines.join('\n')),
      related: clean(relatedLines.join('\n')),
      timeline: clean(timelineLines.join('\n')),
    },
    evidenceMap: {
      sections: sectionMap,
      related: relatedMap,
      timeline: timelineMap,
    },
  };
}

function synthesisReport(
  bundle: PageEvidenceBundle,
  synthesisId: string,
  error: string,
  conflict: boolean,
): void {
  addReports([{
    kind: 'enrich',
    issueKey: `page-recompose:${bundle.page.id}`,
    fingerprint: sha([synthesisId, error]),
    payload: {
      pageId: bundle.page.id,
      title: bundle.page.title,
      pageUpdated: now(),
      recompose: true,
      conflict,
      synthesisId,
      evidenceHash: bundle.evidenceHash,
      detail: `${conflict ? '整页综合需要人工确认' : '整页综合失败'}：${error}`,
    },
  }]);
}

function failSynthesis(
  bundle: PageEvidenceBundle,
  synthesisId: string,
  error: unknown,
  conflict = false,
): never {
  const message = String((error as any)?.message || error).slice(0, 4000);
  db.prepare(
    `UPDATE page_syntheses SET status=?,error=?,updated_at=? WHERE id=?`
  ).run(conflict ? 'conflict' : 'failed', message, now(), synthesisId);
  synthesisReport(bundle, synthesisId, message, conflict);
  throw error instanceof Error ? error : new Error(message);
}

function resolveSynthesisReport(pageId: string): void {
  db.prepare(
    `UPDATE reports SET status='resolved'
     WHERE kind='enrich' AND issue_key=? AND status IN ('open','applying')`
  ).run(`page-recompose:${pageId}`);
}

export function queuePageRecompose(
  pageId: string,
  options: { triggerRunId?: string } = {},
): string | undefined {
  const bundle = loadPageEvidence(pageId);
  if (!bundle) return undefined;
  const body = readPage(bundle.page.path);
  if (!body) return undefined;
  if (!bundle.facts.length) {
    const meta = readPageMeta(bundle.page.path);
    const managedPaths = new Set(allPageContributions(pageId).map((item) => item.source_path));
    const manualSources = Array.isArray(meta.sources)
      ? meta.sources.map(String).filter((source: string) => !managedPaths.has(source))
      : [];
    const manual = extractEntityManualSections(
      body.content,
      bundle.page.title,
      allPageContributions(pageId),
    );
    writePage(bundle.page.path, renderEntitySections(manual), {
      summary: '',
      sources: [...new Set([
        ...manualSources,
        ...bundle.contributions.map((item) => item.source_path),
      ])],
      retrieved: now().slice(0, 10),
    });
    db.prepare(
      `UPDATE page_syntheses SET status='superseded',updated_at=?
       WHERE page_id=? AND status='active'`
    ).run(now(), pageId);
    enqueue('process', { pageId, synthesisCleared: true });
    return undefined;
  }
  if (!llmReady()) return undefined;
  const state = inputState(bundle, body.content);
  const existing = db.prepare(
    `SELECT * FROM page_syntheses WHERE page_id=? AND input_hash=?`
  ).get(pageId, state.inputHash) as StoredPageSynthesis | undefined;
  if (existing?.status === 'active') return existing.id;
  if (existing?.status === 'pending') return existing.id;
  const timestamp = now();
  const synthesisId = existing?.id || newId();
  if (existing) {
    db.prepare(
      `UPDATE page_syntheses
       SET status='pending',trigger_run_id=?,evidence_hash=?,source_version_ids=?,
           manual_changed=?,error='',updated_at=?
       WHERE id=?`
    ).run(
      options.triggerRunId || null,
      bundle.evidenceHash,
      JSON.stringify(bundle.sourceVersionIds),
      state.manualChanged ? 1 : 0,
      timestamp,
      synthesisId,
    );
  } else {
    db.prepare(
      `INSERT INTO page_syntheses(
         id,page_id,input_hash,evidence_hash,trigger_run_id,status,source_version_ids,
         manual_changed,created_at,updated_at
       ) VALUES(?,?,?,?,?,'pending',?,?,?,?)`
    ).run(
      synthesisId,
      pageId,
      state.inputHash,
      bundle.evidenceHash,
      options.triggerRunId || null,
      JSON.stringify(bundle.sourceVersionIds),
      state.manualChanged ? 1 : 0,
      timestamp,
      timestamp,
    );
  }
  enqueue('page_recompose', {
    pageId,
    synthesisId,
    inputHash: state.inputHash,
  });
  return synthesisId;
}

export async function recomposePage(
  pageId: string,
  synthesisId: string,
  expectedInputHash: string,
): Promise<{ changed: boolean; synthesisId: string }> {
  const pending = db.prepare(
    `SELECT * FROM page_syntheses WHERE id=? AND page_id=?`
  ).get(synthesisId, pageId) as StoredPageSynthesis | undefined;
  if (!pending) throw new Error('页面综合任务不存在');
  const bundle = loadPageEvidence(pageId);
  if (!bundle?.facts.length) throw new Error('页面没有可用于综合的有效事实');
  const body = readPage(bundle.page.path);
  if (!body) throw new Error('页面文件不存在');
  const state = inputState(bundle, body.content);
  if (state.inputHash !== expectedInputHash || pending.input_hash !== expectedInputHash) {
    db.prepare(`UPDATE page_syntheses SET status='superseded',updated_at=? WHERE id=?`)
      .run(now(), synthesisId);
    queuePageRecompose(pageId, { triggerRunId: pending.trigger_run_id || undefined });
    return { changed: false, synthesisId };
  }
  if (state.markerMissing) {
    return failSynthesis(
      bundle,
      synthesisId,
      new PageSynthesisConflict('上一版综合区边界已被移除，无法自动判断人工修改范围'),
      true,
    );
  }

  const allowedEvidence = new Set(bundle.facts.map((fact) => fact.id));
  const roster = knownRoster();
  const manualEdited = state.manualChanged ? state.extracted : null;
  let output: SynthesisOutput;
  try {
    const rawOutput = await runSemanticStage({
      scope: 'page-synthesis',
      refId: pageId,
      stage: 'compose',
      tag: 'page-synthesis-compose',
      schema: synthesisOutputSchema,
      system: pageSynthesisPrompt(bundle.page.title, bundle.page.type, roster.text, state.manualChanged),
      input: {
        page: bundle.page,
        activeEvidence: bundle.facts,
        relations: bundle.relations,
        manualSections: state.manualSections,
        previousSynthesis: state.active ? {
          current: state.active.current_content,
          related: state.active.related_content,
          timeline: state.active.timeline_content,
        } : null,
        currentEditedSynthesis: manualEdited,
      },
      temperature: 0.1,
      maxTokens: 12000,
      retries: 1,
    });
    output = synthesisOutputSchema.parse(rawOutput);
    validateEvidenceIds(output, allowedEvidence);
    output = filterTimelineEvidence(output, bundle.facts);
    if (output.unresolvedConflicts.length) {
      throw new PageSynthesisConflict(output.unresolvedConflicts.join('；'));
    }
    if (state.manualChanged && !output.manualChangesPreserved) {
      throw new PageSynthesisConflict('模型无法确认人工修改已被完整保留');
    }
    const rendered = renderOutput(output, roster.titles, bundle.facts);
    rendered.sections.id = synthesisId;
    if (!rendered.sections.current.trim()) throw new Error('整页综合没有生成有效正文');
    const rawVerify = await runSemanticStage({
      scope: 'page-synthesis',
      refId: pageId,
      stage: 'verify',
      tag: 'page-synthesis-verify',
      schema: synthesisVerifySchema,
      system: pageSynthesisVerifyPrompt(state.manualChanged),
      input: {
        page: bundle.page,
        activeEvidence: bundle.facts,
        draft: {
          current: rendered.sections.current,
          related: rendered.sections.related,
          timeline: rendered.sections.timeline,
          evidenceMap: rendered.evidenceMap,
        },
        previousSynthesis: state.active ? {
          current: state.active.current_content,
          related: state.active.related_content,
          timeline: state.active.timeline_content,
        } : null,
        currentEditedSynthesis: manualEdited,
      },
      temperature: 0,
      maxTokens: 2500,
      retries: 1,
    });
    const verify: SynthesisVerifyOutput = synthesisVerifySchema.parse(rawVerify);
    if (!verify.pass || verify.unsupported.length || verify.conflicts.length) {
      const details = [...verify.unsupported, ...verify.conflicts];
      throw new PageSynthesisConflict(details.join('；') || '最终证据验证未通过');
    }
    if (state.manualChanged && !verify.manualChangesPreserved) {
      throw new PageSynthesisConflict('最终验证无法确认人工修改已保留');
    }

    const latestBody = readPage(bundle.page.path);
    if (!latestBody) throw new Error('写入前页面文件不存在');
    const latestState = inputState(bundle, latestBody.content);
    if (latestState.inputHash !== expectedInputHash) {
      db.prepare(`UPDATE page_syntheses SET status='superseded',updated_at=? WHERE id=?`)
        .run(now(), synthesisId);
      queuePageRecompose(pageId, { triggerRunId: pending.trigger_run_id || undefined });
      return { changed: false, synthesisId };
    }

    const projected = renderEntitySynthesisProjection(
      latestBody.content,
      bundle.page.title,
      allPageContributions(pageId),
      rendered.sections,
    );
    const priorMeta = readPageMeta(bundle.page.path);
    try {
      writePage(bundle.page.path, projected, {
        summary: output.summary,
        domain: output.domain,
        confidence: output.confidence,
        sources: [...new Set(bundle.contributions.map((item) => item.source_path))],
        retrieved: now().slice(0, 10),
      });
      db.transaction(() => {
        db.prepare(
          `UPDATE page_syntheses SET status='superseded',updated_at=?
           WHERE page_id=? AND status IN ('active','failed','conflict') AND id<>?`
        ).run(now(), pageId, synthesisId);
        db.prepare(
          `UPDATE page_syntheses SET
             status='active',summary=?,domain=?,confidence=?,current_content=?,
             related_content=?,timeline_content=?,evidence_map=?,source_version_ids=?,
             manual_changed=?,error='',updated_at=?
           WHERE id=?`
        ).run(
          output.summary,
          output.domain,
          output.confidence,
          rendered.sections.current,
          rendered.sections.related,
          rendered.sections.timeline,
          JSON.stringify(rendered.evidenceMap),
          JSON.stringify(bundle.sourceVersionIds),
          state.manualChanged ? 1 : 0,
          now(),
          synthesisId,
        );
      })();
    } catch (error) {
      try {
        writePage(bundle.page.path, latestBody.content, {
          title: priorMeta.title,
          type: priorMeta.type,
          tags: priorMeta.tags,
          summary: priorMeta.summary,
          sources: priorMeta.sources,
          domain: priorMeta.domain,
          confidence: priorMeta.confidence,
        });
      } catch { /* best-effort restore */ }
      throw error;
    }
    resolveSynthesisReport(pageId);
    return { changed: true, synthesisId };
  } catch (error) {
    return failSynthesis(bundle, synthesisId, error, error instanceof PageSynthesisConflict);
  }
}

function evidenceMapFor(row: StoredPageSynthesis | null): EvidenceMap {
  if (!row) return { sections: [], related: [], timeline: [] };
  try {
    const parsed = JSON.parse(row.evidence_map);
    return {
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      related: Array.isArray(parsed.related) ? parsed.related : [],
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
    };
  } catch {
    return { sections: [], related: [], timeline: [] };
  }
}

function evidenceIdsFromMap(map: EvidenceMap): string[] {
  return [...new Set([
    ...map.sections.flatMap((section) => section.claims.flatMap((claim) => claim.evidenceIds)),
    ...map.related.flatMap((item) => item.evidenceIds),
    ...map.timeline.flatMap((item) => item.evidenceIds),
  ])];
}

function historicalEvidenceFact(pageId: string, id: string): PageEvidenceFact | null {
  const separator = id.indexOf(':');
  if (separator <= 0) return null;
  const runId = id.slice(0, separator);
  const factId = id.slice(separator + 1);
  const row = db.prepare(
    `SELECT f.statement,f.sources,pc.source_version_id,pc.source_ref,sv.path source_path
     FROM ingest_facts f
     JOIN page_contributions pc ON pc.run_id=f.run_id AND pc.page_id=?
     JOIN source_versions sv ON sv.id=pc.source_version_id
     WHERE f.run_id=? AND f.fact_id=?
     ORDER BY pc.updated_at DESC LIMIT 1`
  ).get(pageId, runId, factId) as any;
  if (!row) return null;
  return {
    id,
    runId,
    factId,
    statement: row.statement,
    sourcePath: row.source_path,
    sourceRef: row.source_ref || row.source_path,
    sourceVersionId: row.source_version_id,
    quotes: parseArray<{ chunkId: string; quote: string }>(row.sources)
      .filter((source) => source.chunkId && source.quote),
  };
}

export function pageEvidenceResponse(pageId: string): Record<string, unknown> | null {
  const bundle = loadPageEvidence(pageId);
  if (!bundle) return null;
  const active = activePageSynthesis(pageId);
  const body = readPage(bundle.page.path);
  const state = body ? inputState(bundle, body.content) : null;
  const evidenceMap = evidenceMapFor(active);
  const activeFactIds = new Set(bundle.facts.map((fact) => fact.id));
  const displayedFacts = new Map(bundle.facts.map((fact) => [fact.id, fact]));
  for (const id of evidenceIdsFromMap(evidenceMap)) {
    if (displayedFacts.has(id)) continue;
    const historical = historicalEvidenceFact(pageId, id);
    if (historical) displayedFacts.set(id, historical);
  }
  const sourcePageIds = new Map(
    (db.prepare(
      `SELECT id,path FROM pages WHERE deleted=0 AND path LIKE '原始资料/%'`
    ).all() as Array<{ id: string; path: string }>).map((page) => [page.path, page.id]),
  );
  const sources = new Map<string, {
    path: string;
    ref: string;
    pageId: string | null;
    versionIds: Set<string>;
    runIds: Set<string>;
    factIds: string[];
    active: boolean;
  }>();
  for (const fact of displayedFacts.values()) {
    const source = sources.get(fact.sourcePath) || {
      path: fact.sourcePath,
      ref: fact.sourceRef,
      pageId: sourcePageIds.get(fact.sourcePath) || null,
      versionIds: new Set<string>(),
      runIds: new Set<string>(),
      factIds: [],
      active: false,
    };
    source.versionIds.add(fact.sourceVersionId);
    source.runIds.add(fact.runId);
    source.factIds.push(fact.id);
    source.active ||= activeFactIds.has(fact.id);
    sources.set(fact.sourcePath, source);
  }
  return {
    page: bundle.page,
    synthesis: active ? {
      id: active.id,
      status: active.status,
      updatedAt: active.updated_at,
      summary: active.summary,
      confidence: active.confidence,
      manualModified: Boolean(state?.manualChanged || state?.markerMissing),
      evidenceHash: active.evidence_hash,
      outdated: active.evidence_hash !== bundle.evidenceHash,
    } : null,
    evidenceMap,
    facts: [...displayedFacts.values()],
    sources: [...sources.values()].map((source) => ({
      ...source,
      versionIds: [...source.versionIds],
      runIds: [...source.runIds],
      factIds: [...new Set(source.factIds)],
    })),
  };
}

export function queueMissingPageSyntheses(): number {
  if (!llmReady()) return 0;
  const pages = db.prepare(
    `SELECT DISTINCT p.id FROM pages p
     JOIN page_contributions pc ON pc.page_id=p.id AND pc.active=1
     WHERE p.deleted=0 AND p.type IN ('person','project','org')`
  ).all() as Array<{ id: string }>;
  let queued = 0;
  for (const page of pages) {
    const before = db.prepare(
      `SELECT COUNT(*) count FROM jobs WHERE kind='page_recompose' AND status IN ('pending','running')`
    ).get() as { count: number };
    queuePageRecompose(page.id);
    const after = db.prepare(
      `SELECT COUNT(*) count FROM jobs WHERE kind='page_recompose' AND status IN ('pending','running')`
    ).get() as { count: number };
    if (after.count > before.count) queued++;
  }
  return queued;
}
