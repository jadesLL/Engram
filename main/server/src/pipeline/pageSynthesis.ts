import crypto from 'node:crypto';
import { z } from 'zod';
import { db, newId, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { readPage, readPageMeta, writePage } from '../lib/vault.js';
import { isEntity, isSynthesizable } from '../lib/pageTypes.js';
import { enqueue } from '../jobQueue.js';
import { addReports } from '../dream/reports.js';
import {
  conceptSynthesisPrompt,
  conceptSynthesisVerifyPrompt,
  pageSynthesisPrompt,
  pageSynthesisVerifyPrompt,
} from '../prompts/pageSynthesis.js';
import { acsPageSynthesisPrompt, acsPageSynthesisVerifyPrompt } from '../prompts/acs.js';
import { isAcsMode, pageIsCustomer } from '../lib/acs.js';
import { allPageContributions, contributionsForProjection, type StoredContribution } from './sourceLedger.js';
import {
  extractConceptManualSections,
  extractConceptSynthesis,
  extractEntityManualSections,
  extractEntitySynthesis,
  renderConceptSynthesisProjection,
  renderEntitySynthesisProjection,
  renderEntitySections,
  type EntitySections,
  type EntitySynthesisSections,
} from './knowledgePage.js';

const evidenceClaimSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1)).min(1).max(30),
});

/** ACS 模式下的「缺失资料」条目：证据缺口本身无 evidenceIds，因此独立成字段，不进入证据门禁。 */
const gapItemSchema = z.object({
  item: z.string().trim().min(1).max(300),
  priority: z.string().trim().max(20).default(''),
  use: z.string().trim().max(300).default(''),
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
  gaps: z.array(gapItemSchema).max(40).default([]),
  manualChangesPreserved: z.boolean().default(true),
});

/** 模型有时会把 unsupported/conflicts 输出成对象数组（含 candidateId/reason 等结构）而非
 *  提示词要求的字符串数组；逐元素序列化为可读文本，避免整轮校验被 schema 拒绝后重试仍失败。 */
function stringifyIssueItems(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const parts = Object.entries(item as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      return parts.join('；') || JSON.stringify(item);
    }
    return String(item);
  });
}

const synthesisVerifySchema = z.object({
  pass: z.boolean(),
  unsupported: z.preprocess(stringifyIssueItems, z.array(z.string()).max(50).default([])),
  conflicts: z.preprocess(stringifyIssueItems, z.array(z.string()).max(50).default([])),
  manualChangesPreserved: z.boolean().default(true),
});

type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;
type SynthesisVerifyOutput = z.infer<typeof synthesisVerifySchema>;

/** synthesisOutputSchema 对应的工具参数 JSON schema（手写，运行时由 Zod 兜底校验）。
 *  用于 function calling 式结构化输出，规避 JSON mode 下推理模型返回纯文本。 */
const synthesisToolParameters: Record<string, unknown> = {
  type: 'object',
  required: ['summary', 'sections', 'manualChangesPreserved'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: '整页摘要' },
    domain: { type: 'string', description: '领域' },
    confidence: { type: 'string', enum: ['高', '中', '低'], description: '置信度' },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          heading: { type: 'string', description: '首段留空，后续为章节名' },
          paragraphs: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              required: ['text', 'evidenceIds'],
              additionalProperties: false,
              properties: {
                text: { type: 'string' },
                evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
              },
            },
          },
          bullets: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              required: ['text', 'evidenceIds'],
              additionalProperties: false,
              properties: {
                text: { type: 'string' },
                evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
              },
            },
          },
        },
      },
    },
    related: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        required: ['title', 'note', 'evidenceIds'],
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          note: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
        },
      },
    },
    timeline: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        required: ['date', 'event', 'evidenceIds'],
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          event: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
        },
      },
    },
    unresolvedConflicts: { type: 'array', items: { type: 'string' } },
    gaps: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        required: ['item'],
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          priority: { type: 'string' },
          use: { type: 'string' },
        },
      },
    },
    manualChangesPreserved: { type: 'boolean' },
  },
};

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
  page: { id: string; path: string; title: string; type: string; tags: string[] };
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
/** 失败/冲突的合成在此冷却期内不重新排队，避免启动时狂调 LLM 拖垮事件循环。 */
const SYNTHESIS_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
/** 单次补齐合成的入队上限，避免一次性全量入队压垮队列与事件循环。 */
const SYNTHESIS_BATCH_LIMIT = 10;

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

/**
 * 批量预取本页证据事实，避免对每条 contribution 逐个 factLookup 的 N+1 查询。
 * 同步 DB 读会独占主线程，contribution 多时冻结事件循环、拖垮 /health 探针；
 * 改为按 run_id 分组的少量查询，兼容 factLookup 的 runId:factId 冒号回退格式。
 */
function preloadEvidenceFacts(
  contributions: ReadonlyArray<{ run_id: string; fact_ids: string; relations: string }>,
): Map<string, { runId: string; factId: string; statement: string; sources: string }> {
  const byRun = new Map<string, Set<string>>();
  const add = (runId: string, factId: string) => {
    if (!runId || !factId) return;
    let set = byRun.get(runId);
    if (!set) { set = new Set(); byRun.set(runId, set); }
    set.add(factId);
  };
  for (const c of contributions) {
    for (const fid of parseArray<string>(c.fact_ids)) {
      add(c.run_id, fid);
      const sep = fid.indexOf(':');
      if (sep > 0) add(fid.slice(0, sep), fid.slice(sep + 1));
    }
    for (const rel of parseArray<{ src: string; word: string; dst: string; factId: string }>(c.relations)) {
      if (!rel.factId) continue;
      add(c.run_id, rel.factId);
      const sep = rel.factId.indexOf(':');
      if (sep > 0) add(rel.factId.slice(0, sep), rel.factId.slice(sep + 1));
    }
  }
  const map = new Map<string, { runId: string; factId: string; statement: string; sources: string }>();
  for (const [runId, fids] of byRun) {
    const idList = [...fids];
    if (!idList.length) continue;
    const ph = idList.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT run_id runId,fact_id factId,statement,sources
       FROM ingest_facts WHERE run_id=? AND fact_id IN (${ph})`
    ).all(runId, ...idList) as Array<{ runId: string; factId: string; statement: string; sources: string }>;
    for (const r of rows) map.set(`${r.runId}\0${r.factId}`, r);
  }
  return map;
}

function loadPageEvidence(pageId: string): PageEvidenceBundle | null {
  const row = db.prepare(
    `SELECT id,path,title,type,tags FROM pages WHERE id=? AND deleted=0`
  ).get(pageId) as { id: string; path: string; title: string; type: string; tags: string | null } | undefined;
  if (!row || !isSynthesizable(row.type)) return null;
  const page: PageEvidenceBundle['page'] = {
    id: row.id,
    path: row.path,
    title: row.title,
    type: row.type,
    tags: parseArray<string>(row.tags || '[]'),
  };
  const contributions = contributionsForProjection(pageId);
  const factMap = preloadEvidenceFacts(contributions);
  const factRow = (runId: string, rawFactId: string) => {
    const direct = factMap.get(`${runId}\0${rawFactId}`);
    if (direct) return direct;
    const sep = rawFactId.indexOf(':');
    if (sep <= 0) return null;
    return factMap.get(`${rawFactId.slice(0, sep)}\0${rawFactId.slice(sep + 1)}`) || null;
  };
  const facts = new Map<string, PageEvidenceFact>();
  const relations: PageEvidenceBundle['relations'] = [];
  for (const contribution of contributions) {
    for (const rawFactId of parseArray<string>(contribution.fact_ids)) {
      const row = factRow(contribution.run_id, rawFactId);
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
      const fact = factRow(contribution.run_id, relation.factId);
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
  const semanticFactKeys = new Map(factList.map((fact) => [
    fact.id,
    sha({
      statement: fact.statement,
      sourcePath: fact.sourcePath,
      quotes: fact.quotes.slice().sort((a, b) =>
        `${a.chunkId}\0${a.quote}`.localeCompare(`${b.chunkId}\0${b.quote}`)
      ),
    }),
  ]));
  const evidenceHash = sha({
    facts: factList.map((fact) => ({
      key: semanticFactKeys.get(fact.id),
      statement: fact.statement,
      sourcePath: fact.sourcePath,
      quotes: fact.quotes,
    })),
    relations: relations.map((relation) => ({
      src: relation.src,
      word: relation.word,
      dst: relation.dst,
      evidenceKey: semanticFactKeys.get(relation.evidenceId) || '',
    })).sort((a, b) =>
      `${a.src}\0${a.word}\0${a.dst}\0${a.evidenceKey}`.localeCompare(
        `${b.src}\0${b.word}\0${b.dst}\0${b.evidenceKey}`,
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

/** 重建概念页综合块内容：current 与 related（若有）按 ## 相关页面 拼接，与投影写入时一致 */
function conceptBlockContent(current: string, related: string): string {
  const c = clean(current);
  const r = clean(related);
  return r ? clean(`${c}\n\n## 相关页面\n\n${r}`) : c;
}

/** 概念页综合状态：单块标记，不分 current/related/timeline；manualChanged 比较整块内容 */
function conceptInputState(bundle: PageEvidenceBundle, body: string, active: StoredPageSynthesis | null): SynthesisInputState {
  const extracted = extractConceptSynthesis(body);
  const manualText = extractConceptManualSections(
    body,
    bundle.page.title,
    allPageContributions(bundle.page.id),
  );
  const markerMissing = Boolean(active && (!extracted || extracted.id !== active.id));
  const activeBlock = active ? conceptBlockContent(active.current_content, active.related_content) : '';
  const manualChanged = Boolean(
    active && extracted && extracted.id === active.id && !sameContent(extracted.content, activeBlock),
  );
  const edited = manualChanged && extracted ? {
    current: extracted.content,
    related: '',
    timeline: '',
  } : null;
  return {
    active,
    extracted: extracted ? { id: extracted.id, current: extracted.content, related: '', timeline: '' } : null,
    manualSections: { title: bundle.page.title, current: manualText, related: '', timeline: '' },
    manualChanged,
    markerMissing,
    inputHash: sha({
      synthesisVersion: PAGE_SYNTHESIS_VERSION,
      concept: true,
      evidenceHash: bundle.evidenceHash,
      manual: { current: manualText },
      edited,
      markerMissing,
    }),
  };
}

function inputState(bundle: PageEvidenceBundle, body: string): SynthesisInputState {
  const active = activePageSynthesis(bundle.page.id);
  if (!isEntity(bundle.page.type)) {
    return conceptInputState(bundle, body, active);
  }
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

/**
 * 把 ACS 综合产出的 gaps 追加到已渲染结果上。
 *
 * 刻意在证据校验通过之后调用：gaps 是「框架预期但证据未覆盖」的缺口，本身无 evidenceIds，
 * 不应进入 verify 草稿（否则可能被判 unsupported 触发自纠错回路、最终判失败）。
 * 因此 renderOutput 不渲染 gaps，校验通过后再用本函数补到正文与 evidenceMap。
 */
function appendGaps(
  rendered: ReturnType<typeof renderOutput>,
  output: SynthesisOutput,
): void {
  if (!output.gaps?.length) return;
  const gapClaims: EvidenceMap['sections'][number]['claims'] = [];
  const lines = rendered.sections.current.split('\n');
  lines.push('', '### 缺失资料与待验证', '');
  for (const gap of output.gaps) {
    const item = normalizeText(gap.item);
    if (!item) continue;
    const meta = [gap.priority, gap.use].filter(Boolean).join(' · ');
    const line = meta ? `${item}（${meta}）` : item;
    lines.push(`- ${line}`);
    gapClaims.push({ kind: 'bullet', text: line, evidenceIds: [] });
  }
  if (gapClaims.length) {
    lines.push('');
    rendered.evidenceMap.sections.push({ heading: '缺失资料与待验证', claims: gapClaims });
  }
  rendered.sections.current = clean(lines.join('\n'));
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
  options: { triggerRunId?: string; force?: boolean } = {},
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
    const allManaged = allPageContributions(pageId);
    const sources = [...new Set([
      ...manualSources,
      ...bundle.contributions.map((item) => item.source_path),
    ])];
    if (isEntity(bundle.page.type)) {
      const manual = extractEntityManualSections(body.content, bundle.page.title, allManaged);
      writePage(bundle.page.path, renderEntitySections(manual), {
        summary: '',
        sources,
        retrieved: now().slice(0, 10),
      });
    } else {
      const manualText = extractConceptManualSections(body.content, bundle.page.title, allManaged);
      writePage(bundle.page.path, manualText || `# ${bundle.page.title}\n`, {
        summary: '',
        sources,
        retrieved: now().slice(0, 10),
      });
    }
    db.prepare(
      `UPDATE page_syntheses SET status='superseded',updated_at=?
       WHERE page_id=? AND status='active'`
    ).run(now(), pageId);
    enqueue('process', { pageId, synthesisCleared: true });
    return undefined;
  }
  if (!llmReady()) return undefined;
  // force：强制重新综合，先把旧 active 置 superseded，使后续 state 与 recompose 看到一致的 active=null
  if (options.force) {
    db.prepare(
      `UPDATE page_syntheses SET status='superseded',updated_at=?
       WHERE page_id=? AND status='active'`
    ).run(now(), pageId);
  }
  const state = inputState(bundle, body.content);
  const existing = db.prepare(
    `SELECT * FROM page_syntheses WHERE page_id=? AND input_hash=?`
  ).get(pageId, state.inputHash) as StoredPageSynthesis | undefined;
  if (!options.force) {
    if (existing?.status === 'active') return existing.id;
    if (existing?.status === 'pending') return existing.id;
    // 失败/冲突的合成在冷却期内不重新排队，避免每次启动都重排注定失败的合成、
    // 狂调 LLM 并密集同步写 DB 拖垮事件循环。force 可绕过冷却。
    if ((existing?.status === 'failed' || existing?.status === 'conflict') && existing.updated_at) {
      const cooldownMs = SYNTHESIS_FAILURE_COOLDOWN_MS;
      const elapsed = Date.now() - new Date(existing.updated_at.replace(' ', 'T') + 'Z').getTime();
      if (elapsed < cooldownMs) return existing.id;
    }
  }
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
  signal?: AbortSignal,
  onProgress?: (stage: string, round: number) => void,
): Promise<{ changed: boolean; synthesisId: string }> {
  signal?.throwIfAborted();
  onProgress?.('load-evidence', 0);
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
  // 信捷（ACS）模式仅对 customer 客户实体页生效；非客户页保持标准综合。
  const acs = isAcsMode() && pageIsCustomer(bundle.page);
  const isConceptPage = !isEntity(bundle.page.type);
  let output: SynthesisOutput;
  try {
    // 自纠错回路：compose 生成草稿 → verify 校验；校验失败时把证据校验反馈注入 compose 重新生成，
    // 最多重试 maxCorrectionRounds 次。反馈注入系统提示（而非 input）使 runSemanticStage 的
    // 缓存键随 system 变化而 miss，避免 job 重试时 compose 命中缓存返回同一份失败草稿。
    const maxCorrectionRounds = 2;
    let correctionFeedback: string[] | undefined;
    let rendered!: ReturnType<typeof renderOutput>;
    for (let round = 0; ; round++) {
      onProgress?.('compose', round);
      const rawOutput = await runSemanticStage({
        scope: 'page-synthesis',
        refId: pageId,
        stage: 'compose',
        tag: 'page-synthesis-compose',
        schema: synthesisOutputSchema,
        // correctionFeedback 移入 input 而非 system：system 稳定后 provider 前缀缓存可命中，
        // 不同轮次 input 含不同 feedback → cacheKey 仍不同，不会误命中上一轮失败草稿。
        system: acs
          ? acsPageSynthesisPrompt(bundle.page.title, bundle.page.type, roster.text, state.manualChanged)
          : isConceptPage
            ? conceptSynthesisPrompt(bundle.page.title, roster.text, state.manualChanged)
            : pageSynthesisPrompt(bundle.page.title, bundle.page.type, roster.text, state.manualChanged),
        promptVersion: acs
          ? 'page-synthesis-compose:acs-2'
          : isConceptPage ? 'page-synthesis-compose:concept-2' : 'page-synthesis-compose:5',
        cacheScope: 'page-synthesis:compose',
        dependencyHash: state.inputHash,
        resultCache: true,
        onRetry: () => onProgress?.('compose', round),
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
          correctionFeedback,
        },
        temperature: 0.1,
        maxTokens: 12000,
        retries: 1,
        signal,
        toolMode: {
          toolName: 'compose_page',
          toolDescription: '生成本页的整页综合结果。按各字段结构填写，evidenceIds 必须逐字使用 activeEvidence 中的 id。',
          parameters: synthesisToolParameters,
        },
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
      rendered = renderOutput(output, roster.titles, bundle.facts);
      rendered.sections.id = synthesisId;
      if (!rendered.sections.current.trim()) throw new Error('整页综合没有生成有效正文');
      onProgress?.('verify', round);
      const rawVerify = await runSemanticStage({
        scope: 'page-synthesis',
        refId: pageId,
        stage: 'verify',
        tag: 'page-synthesis-verify',
        schema: synthesisVerifySchema,
      system: acs
        ? acsPageSynthesisVerifyPrompt(state.manualChanged)
        : isConceptPage
          ? conceptSynthesisVerifyPrompt(state.manualChanged)
          : pageSynthesisVerifyPrompt(state.manualChanged),
      promptVersion: acs
        ? 'page-synthesis-verify:acs-1'
        : isConceptPage ? 'page-synthesis-verify:concept-1' : 'page-synthesis-verify:3',
      cacheScope: 'page-synthesis:verify',
      dependencyHash: state.inputHash,
      onRetry: () => onProgress?.('verify', round),
      // verify 是证据校验关卡，不缓存结果：自纠错回路每轮都要对当前草稿重新校验，
      // 缓存校验结论会在草稿不变时命中旧结论、跳过本轮校验，导致回路短路。
      resultCache: false,
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
        signal,
      });
      const verify: SynthesisVerifyOutput = synthesisVerifySchema.parse(rawVerify);
      if (!verify.pass || verify.unsupported.length || verify.conflicts.length) {
        const details = [...verify.unsupported, ...verify.conflicts];
        if (round >= maxCorrectionRounds) {
          throw new PageSynthesisConflict(details.join('；') || '最终证据验证未通过');
        }
        // 收集反馈进入下一轮 compose 重写，而非立即判 conflict
        correctionFeedback = details;
        continue;
      }
      if (state.manualChanged && !verify.manualChangesPreserved) {
        throw new PageSynthesisConflict('最终验证无法确认人工修改已保留');
      }
      break;
    }

    // 校验通过后再补 ACS 的「缺失资料」章节——gaps 无证据，不能进入 verify 草稿。
    appendGaps(rendered, output);

    signal?.throwIfAborted();
    const latestBody = readPage(bundle.page.path);
    if (!latestBody) throw new Error('写入前页面文件不存在');
    const latestState = inputState(bundle, latestBody.content);
    if (latestState.inputHash !== expectedInputHash) {
      db.prepare(`UPDATE page_syntheses SET status='superseded',updated_at=? WHERE id=?`)
        .run(now(), synthesisId);
      queuePageRecompose(pageId, { triggerRunId: pending.trigger_run_id || undefined });
      return { changed: false, synthesisId };
    }

    const allManaged = allPageContributions(pageId);
    const projected = isEntity(bundle.page.type)
      ? renderEntitySynthesisProjection(latestBody.content, bundle.page.title, allManaged, rendered.sections)
      : renderConceptSynthesisProjection(latestBody.content, bundle.page.title, allManaged, rendered.sections);
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
    if (signal?.aborted) throw error;
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
  // 任意状态的最新一行：前端据此区分「排队中（pending）」与「失败/冲突（failed/conflict）」，
  // 而不是把所有无 active 综合的页面一律显示成「综合中」。
  const latest = db.prepare(
    `SELECT status, error, updated_at FROM page_syntheses
     WHERE page_id=? ORDER BY updated_at DESC LIMIT 1`
  ).get(pageId) as { status: string; error: string; updated_at: string } | undefined;
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
    latestSynthesis: latest ? {
      status: latest.status,
      error: latest.error,
      updatedAt: latest.updated_at,
    } : null,
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

/** 可综合页面类型（与 isSynthesizable 对齐：概念 + 全部实体类型） */
const SYNTHESIZABLE_PAGE_TYPES = [
  'concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other',
] as const;

export function queueMissingPageSyntheses(): number {
  if (!llmReady()) return 0;
  const pages = db.prepare(
    `SELECT DISTINCT p.id FROM pages p
     JOIN page_contributions pc ON pc.page_id=p.id AND pc.active=1
     WHERE p.deleted=0 AND p.type IN (${SYNTHESIZABLE_PAGE_TYPES.map(() => '?').join(',')})`
  ).all(...SYNTHESIZABLE_PAGE_TYPES) as Array<{ id: string }>;
  let queued = 0;
  for (const page of pages) {
    if (queued >= SYNTHESIS_BATCH_LIMIT) break;
    const before = db.prepare(
      `SELECT COUNT(*) count FROM jobs WHERE kind='page_recompose' AND status IN ('pending','running','paused')`
    ).get() as { count: number };
    queuePageRecompose(page.id);
    const after = db.prepare(
      `SELECT COUNT(*) count FROM jobs WHERE kind='page_recompose' AND status IN ('pending','running','paused')`
    ).get() as { count: number };
    if (after.count > before.count) queued++;
  }
  return queued;
}

/**
 * 异步、不阻塞地补齐缺失合成。供 listen 之后定时调用，
 * 每入队一个就让出事件循环，避免同步 DB 写冻结主线程。
 * 单批上限 SYNTHESIS_BATCH_LIMIT，剩余页由下轮定时补齐。
 */
export async function queueMissingPageSynthesesAsync(): Promise<number> {
  if (!llmReady()) return 0;
  const pages = db.prepare(
    `SELECT DISTINCT p.id FROM pages p
     JOIN page_contributions pc ON pc.page_id=p.id AND pc.active=1
     WHERE p.deleted=0 AND p.type IN (${SYNTHESIZABLE_PAGE_TYPES.map(() => '?').join(',')})`
  ).all(...SYNTHESIZABLE_PAGE_TYPES) as Array<{ id: string }>;
  let queued = 0;
  for (const page of pages) {
    if (queued >= SYNTHESIS_BATCH_LIMIT) break;
    const before = db.prepare(
      `SELECT COUNT(*) count FROM jobs WHERE kind='page_recompose' AND status IN ('pending','running','paused')`
    ).get() as { count: number };
    queuePageRecompose(page.id);
    const after = db.prepare(
      `SELECT COUNT(*) count FROM jobs WHERE kind='page_recompose' AND status IN ('pending','running','paused')`
    ).get() as { count: number };
    if (after.count > before.count) queued++;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return queued;
}
