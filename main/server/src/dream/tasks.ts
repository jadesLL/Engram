import { z } from 'zod';
import { db, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { readPage, readPageMeta } from '../lib/vault.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { runUpgrades } from '../pipeline/mentions.js';
import { addReports } from './reports.js';
import { classifyEntityName, type EntityRosterEntry } from '../pipeline/entityAmbiguity.js';

interface ReportItem { kind: string; payload: Record<string, any> }

const pairAuditSchema = z.object({
  duplicate: z.boolean(),
  preserveBoth: z.boolean(),
  duplicateReason: z.string(),
  recommendedAction: z.enum(['keep_a', 'keep_b', 'keep_both']),
  contradiction: z.boolean(),
  contradictionDetail: z.string(),
});

const deadlinkSchema = z.object({
  suggestedType: z.enum(['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other', 'doc', 'note']),
  reason: z.string(),
});

const pageHealthSchema = z.object({
  needsEnrichment: z.boolean(),
  enrichmentReason: z.string(),
  stale: z.boolean(),
  staleReason: z.string(),
});

function knowledgePages(): Array<{
  id: string;
  title: string;
  path: string;
  type: string;
  summary: string;
  updated_at: string;
  word_count: number;
}> {
  return db.prepare(
    `SELECT id,title,path,type,summary,updated_at,word_count FROM pages
     WHERE deleted=0
       AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
     ORDER BY updated_at DESC`
  ).all() as any[];
}

/** 死链存在性由代码检查；目标页面类型建议由模型判断。 */
export async function taskDeadlinks(signal?: AbortSignal): Promise<number> {
  const rows = db.prepare(
    `SELECT e.id,e.dst_title,p.title src_title,p.id src_id,p.path src_path,p.updated_at src_updated
     FROM edges e JOIN pages p ON p.id=e.src_page
     WHERE e.rel='link' AND e.dst_page IS NULL AND p.deleted=0`
  ).all() as any[];
  const items: ReportItem[] = [];
  for (const row of rows) {
    signal?.throwIfAborted();
    const source = readPage(row.src_path);
    let suggestedType = '';
    let suggestionReason = '未配置模型，请人工选择页面类型';
    if (llmReady() && source) {
      try {
        const decision = await runSemanticStage({
          scope: 'dream',
          refId: `${row.src_id}:${row.dst_title}`,
          stage: 'deadlink-classification',
          tag: 'dream-deadlink-type',
          schema: deadlinkSchema,
          system: `你是知识库页面类型判断模型。根据来源页面上下文，判断死链标题最适合创建为何种页面。
concept=概念/方法/技术，person=人物（真实姓名），customer=客户（购买产品/服务的客户企业），org=组织（非客户的机构/团体/公司），place=地点（地名/区域/地址），work=作品（书/文章/文档/艺术作品），project=产品（产品/项目名），other=其他（不属于以上类型的实体），doc=正式文档，note=普通笔记。
只输出 JSON：{"suggestedType":"concept|person|customer|org|place|work|project|other|doc|note","reason":""}。`,
          input: {
            deadTitle: row.dst_title,
            sourceTitle: row.src_title,
            sourceContent: source.content.slice(0, 5000),
          },
          maxTokens: 700,
          signal,
        });
        suggestedType = decision.suggestedType;
        suggestionReason = decision.reason;
      } catch (error: any) {
        if (signal?.aborted) throw error;
        suggestionReason = `模型类型判断失败，请人工选择：${String(error?.message || error).slice(0, 180)}`;
      }
    }
    items.push({
      kind: 'deadlink',
      payload: {
        key: `${row.src_id}:${row.dst_title}`,
        srcId: row.src_id,
        srcTitle: row.src_title,
        srcPath: row.src_path,
        deadTitle: row.dst_title,
        srcUpdated: row.src_updated || '',
        suggestedType,
        suggestionReason,
      },
    });
  }
  return addReports(items);
}

function pairCandidates(): Array<{ a: any; b: any; retrievalDistance: number | null }> {
  const pages = knowledgePages();
  const byId = new Map(pages.map((page) => [page.id, page]));
  const pairs = new Map<string, { a: any; b: any; retrievalDistance: number | null }>();
  const vecCount = (db.prepare(`SELECT COUNT(*) n FROM vec_chunks`).get() as any).n;
  if (vecCount > 0) {
    const reps = db.prepare(
      `SELECT c.ref_id page_id,c.id chunk_id FROM chunks c
       WHERE c.ref_type='page' AND c.idx=0
         AND c.ref_id IN (
           SELECT id FROM pages WHERE deleted=0
             AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
         )`
    ).all() as any[];
    for (const rep of reps) {
      const vector = db.prepare(`SELECT embedding FROM vec_chunks WHERE rowid=?`).get(rep.chunk_id) as any;
      if (!vector?.embedding) continue;
      const neighbors = db.prepare(
        `SELECT c.ref_id page_id,v.distance FROM vec_chunks v
         JOIN chunks c ON c.id=v.rowid
         WHERE v.embedding MATCH ? AND k=6
           AND c.ref_type='page' AND c.ref_id<>?`
      ).all(vector.embedding, rep.page_id) as any[];
      for (const neighbor of neighbors) {
        const a = byId.get(rep.page_id);
        const b = byId.get(neighbor.page_id);
        if (!a || !b) continue;
        const key = [a.id, b.id].sort().join(':');
        if (!pairs.has(key)) pairs.set(key, { a, b, retrievalDistance: neighbor.distance });
      }
    }
  }
  // 无向量时仍让模型审查同类型页面对，避免工程层静默放弃语义检查。
  if (!pairs.size) {
    for (let left = 0; left < pages.length; left++) {
      for (let right = left + 1; right < pages.length; right++) {
        if (pages[left].type !== pages[right].type) continue;
        pairs.set(`${pages[left].id}:${pages[right].id}`, {
          a: pages[left],
          b: pages[right],
          retrievalDistance: null,
        });
      }
    }
  }
  return [...pairs.values()];
}

function pairPrompt(): string {
  return `你是知识库质量审计模型。判断两个页面在知识语义上是否重复，以及是否存在事实性矛盾。

向量距离只是召回线索，不能直接作为结论。你必须阅读两页正文和元数据后判断：
- duplicate：是否描述同一知识对象且应合并。
- preserveBoth：即使主题接近，是否因时间快照、不同角色、不同范围或独立语义而应保留两页。
- contradiction：是否对同一事实给出互相不能同时成立的描述。

不要因为表达相似、共同提到同一对象或信息详略不同就判重复/矛盾。
只输出 JSON：
{"duplicate":false,"preserveBoth":true,"duplicateReason":"","recommendedAction":"keep_a|keep_b|keep_both","contradiction":false,"contradictionDetail":""}。`;
}

export async function taskPairAudit(signal?: AbortSignal): Promise<{ duplicate: number; contradiction: number }> {
  if (!llmReady()) return { duplicate: 0, contradiction: 0 };
  let duplicate = 0;
  let contradiction = 0;
  for (const pair of pairCandidates()) {
    signal?.throwIfAborted();
    const left = readPage(pair.a.path);
    const right = readPage(pair.b.path);
    if (!left || !right) continue;
    try {
      const decision = await runSemanticStage({
        scope: 'dream',
        refId: [pair.a.id, pair.b.id].sort().join(':'),
        stage: 'page-pair-audit',
        tag: 'dream-pair-audit',
        schema: pairAuditSchema,
        system: pairPrompt(),
        input: {
          retrievalDistance: pair.retrievalDistance,
          pageA: {
            ...pair.a,
            sources: readPageMeta(pair.a.path).sources || [],
            content: left.content.slice(0, 8000),
          },
          pageB: {
            ...pair.b,
            sources: readPageMeta(pair.b.path).sources || [],
            content: right.content.slice(0, 8000),
          },
        },
        maxTokens: 1800,
        signal,
      });
      const key = [pair.a.id, pair.b.id].sort().join(':');
      if (decision.duplicate && !decision.preserveBoth) {
        duplicate += addReports([{
          kind: 'duplicate',
          payload: {
            key,
            a: pair.a,
            b: pair.b,
            detail: decision.duplicateReason,
            recommendedAction: decision.recommendedAction,
            retrievalDistance: pair.retrievalDistance,
          },
        }]);
      }
      if (decision.contradiction) {
        contradiction += addReports([{
          kind: 'contradiction',
          payload: {
            key,
            a: pair.a,
            b: pair.b,
            detail: decision.contradictionDetail,
          },
        }]);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      /* 单对失败不影响其他页面审计。 */
    }
  }
  return { duplicate, contradiction };
}

function backlinks(pageId: string): Array<{ title: string; path: string; content: string }> {
  const rows = db.prepare(
    `SELECT DISTINCT p.title,p.path FROM edges e
     JOIN pages p ON p.id=e.src_page
     WHERE e.dst_page=? AND p.deleted=0
     ORDER BY p.updated_at DESC LIMIT 12`
  ).all(pageId) as Array<{ title: string; path: string }>;
  return rows.flatMap((row) => {
    const page = readPage(row.path);
    return page ? [{ ...row, content: page.content.slice(0, 1500) }] : [];
  });
}

function pageHealthPrompt(currentDate: string): string {
  return `你是知识库页面健康审计模型。当前日期是 ${currentDate}。
请阅读页面正文、来源、更新时间、最后复核时间和引用页上下文，判断：
1. 页面当前是否缺少支撑其用途的关键信息，需要丰富。
2. 页面中的事实是否具有时效性，并且现在是否可能已经过期，需要复核。

字数、引用次数和天数只是元数据，不得直接作为结论。抽象概念可能长期有效；近期页面也可能因状态变化而过期。
只输出 JSON：
{"needsEnrichment":false,"enrichmentReason":"","stale":false,"staleReason":""}。`;
}

export async function taskPageHealth(signal?: AbortSignal): Promise<{ enrich: number; stale: number }> {
  if (!llmReady()) return { enrich: 0, stale: 0 };
  let enrich = 0;
  let stale = 0;
  const currentDate = new Date().toISOString().slice(0, 10);
  for (const page of knowledgePages()) {
    signal?.throwIfAborted();
    const body = readPage(page.path);
    if (!body) continue;
    const meta = readPageMeta(page.path);
    try {
      const decision = await runSemanticStage({
        scope: 'dream',
        refId: page.id,
        stage: 'page-health',
        tag: 'dream-page-health',
        schema: pageHealthSchema,
        system: pageHealthPrompt(currentDate),
        input: {
          page: {
            ...page,
            sources: meta.sources || [],
            reviewedAt: meta.reviewed_at || '',
            content: body.content.slice(0, 10_000),
          },
          backlinks: backlinks(page.id),
        },
        maxTokens: 1600,
        signal,
      });
      if (decision.needsEnrichment) {
        enrich += addReports([{
          kind: 'enrich',
          payload: {
            pageId: page.id,
            title: page.title,
            path: page.path,
            detail: decision.enrichmentReason,
            pageUpdated: page.updated_at,
          },
        }]);
      }
      if (decision.stale) {
        stale += addReports([{
          kind: 'stale',
          payload: {
            pageId: page.id,
            title: page.title,
            path: page.path,
            detail: decision.staleReason,
            pageUpdated: page.updated_at,
            reviewedAt: meta.reviewed_at || '',
          },
        }]);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      /* 单页失败不影响其他页面。 */
    }
  }
  return { enrich, stale };
}

/** 来源数量是用户明确的业务规则，因此由代码精确计数。 */
export function taskSingleSource(): number {
  const items: ReportItem[] = [];
  for (const page of knowledgePages()) {
    const sources = readPageMeta(page.path).sources;
    if (Array.isArray(sources) && sources.length === 1) {
      items.push({
        kind: 'single_source',
        payload: {
          pageId: page.id,
          title: page.title,
          path: page.path,
          source: sources[0],
          pageUpdated: page.updated_at,
        },
      });
    }
  }
  return addReports(items);
}

/** 固定页面骨架属于数据契约，由代码检查。 */
export function taskSectionAudit(): number {
  const items: ReportItem[] = [];
  for (const page of knowledgePages().filter((item) => item.path.startsWith('Wiki/实体/'))) {
    const body = readPage(page.path);
    if (!body) continue;
    const missing: string[] = [];
    if (!/##\s*当前理解/.test(body.content)) missing.push('当前理解');
    if (!/##\s*时间线/.test(body.content)) missing.push('时间线');
    if (missing.length) {
      items.push({
        kind: 'missing_sections',
        payload: {
          pageId: page.id,
          title: page.title,
          path: page.path,
          missing,
          pageUpdated: page.updated_at,
        },
      });
    }
  }
  return addReports(items);
}

/**
 * 已入库实体/概念身份歧义全量扫描。
 * 对每个已入库实体或概念页，用 classifyEntityName 判断其名称是否与名录中其他页面身份混淆
 * （同名异实、异名同实、别名/转写、称谓不完整）。发现歧义即产出 identity_ambiguity 报告，
 * 交人工选择合并、重命名澄清或标记误报。
 */
export async function taskEntityIdentityAudit(signal?: AbortSignal): Promise<number> {
  if (!llmReady()) return 0;
  const pages = knowledgePages();
  const rosterAll: EntityRosterEntry[] = pages.map((page) => ({
    id: page.id,
    title: page.title,
    type: page.type,
    summary: page.summary || '',
  }));
  const items: ReportItem[] = [];
  for (const page of pages) {
    signal?.throwIfAborted();
    const roster = rosterAll.filter((entry) => entry.id !== page.id);
    const body = readPage(page.path);
    const meta = readPageMeta(page.path);
    try {
      const decision = await classifyEntityName(
        page.title,
        page.type,
        roster,
        [page.summary || '', body?.content.slice(0, 2000) || ''].join('\n'),
        page.id,
        undefined,
        {},
        signal,
      );
      if (!decision.ambiguity) continue;
      const target = decision.mergeTarget
        ? roster.find((entry) => entry.title === decision.mergeTarget)
        : undefined;
      items.push({
        kind: 'identity_ambiguity',
        payload: {
          key: page.id,
          pageId: page.id,
          title: page.title,
          path: page.path,
          type: page.type,
          pageUpdated: page.updated_at,
          ambiguity: decision.ambiguity,
          suggestedTargetId: target?.id || '',
          suggestedTargetTitle: decision.mergeTarget || '',
          canonicalName: decision.canonicalName,
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      /* 单页身份检查失败不影响其他页面。 */
    }
  }
  return addReports(items);
}

/** 仅扫描指定新建页面 vs 全量名录，用于入库后增量检测。 */
export async function scanIdentityAmbiguityForPages(pageIds: string[], signal?: AbortSignal): Promise<number> {
  if (!llmReady() || !pageIds.length) return 0;
  const pages = knowledgePages();
  const byId = new Map(pages.map((page) => [page.id, page]));
  const rosterAll: EntityRosterEntry[] = pages.map((page) => ({
    id: page.id,
    title: page.title,
    type: page.type,
    summary: page.summary || '',
  }));
  const items: ReportItem[] = [];
  for (const pageId of pageIds) {
    signal?.throwIfAborted();
    const page = byId.get(pageId);
    if (!page) continue;
    const roster = rosterAll.filter((entry) => entry.id !== page.id);
    const body = readPage(page.path);
    try {
      const decision = await classifyEntityName(
        page.title,
        page.type,
        roster,
        [page.summary || '', body?.content.slice(0, 2000) || ''].join('\n'),
        page.id,
        undefined,
        {},
        signal,
      );
      if (!decision.ambiguity) continue;
      const target = decision.mergeTarget
        ? roster.find((entry) => entry.title === decision.mergeTarget)
        : undefined;
      items.push({
        kind: 'identity_ambiguity',
        payload: {
          key: page.id,
          pageId: page.id,
          title: page.title,
          path: page.path,
          type: page.type,
          pageUpdated: page.updated_at,
          ambiguity: decision.ambiguity,
          suggestedTargetId: target?.id || '',
          suggestedTargetTitle: decision.mergeTarget || '',
          canonicalName: decision.canonicalName,
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return addReports(items);
}

export async function runDreamCycle(signal?: AbortSignal): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  result.deadlink = await taskDeadlinks(signal);
  signal?.throwIfAborted();
  result.single_source = taskSingleSource();
  result.missing_sections = taskSectionAudit();
  const pair = await taskPairAudit(signal);
  result.duplicate = pair.duplicate;
  result.contradiction = pair.contradiction;
  const health = await taskPageHealth(signal);
  result.enrich = health.enrich;
  result.stale = health.stale;
  result.identity_ambiguity = await taskEntityIdentityAudit(signal);
  try {
    signal?.throwIfAborted();
    result.upgrades = (await runUpgrades()).length;
  } catch {
    result.upgrades = 0;
  }
  const timestamp = now();
  db.prepare(
    `INSERT INTO settings(key,value) VALUES('dream_last_run',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(timestamp);
  try {
    const total = Object.values(result).reduce((sum, value) => sum + value, 0);
    appendWikiLog(
      '智能整理',
      `死链 ${result.deadlink}｜疑似重复 ${result.duplicate}｜矛盾 ${result.contradiction}｜待丰富 ${result.enrich}｜过期 ${result.stale}｜来源单一 ${result.single_source}｜待补章节 ${result.missing_sections}｜实体歧义 ${result.identity_ambiguity}｜实体升级 ${result.upgrades}｜共 ${total} 项${total ? '，见整理报告' : '，无待处理'}`,
    );
  } catch {
    /* 日志失败不影响审计结果。 */
  }
  return result;
}
