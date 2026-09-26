import { db } from '../lib/db.js';
import { GUIDE_VERSION } from '../content/agentGuide.js';
import { listRawMaterialFiles } from '../pipeline/rawFiles.js';

/**
 * 梦境思考的确定性待办信号（全部来自索引库/账本，不调模型）：
 * 定时器用它决定「这一轮值不值得跑」，作业手册用它给 Agent 一个明确的起点，
 * 界面用它显示「待提炼 N 份 · 待核查 M 处」，运行前后对比还能写进操作日志。
 *
 * 四类信号都只做「指路」，不确定的不做结论（疑似重复只是标题归一化后撞名，
 * 真正要不要合并由 Agent 读原文决定）：
 *  - pendingFiles：未提炼的原始资料（提取文本没就绪的另计 pendingUnreadable，要等提取完）；
 *  - outdatedPages：规则落后于当前《Agent 作业指南》的概念/实体页（guide_version 口径）；
 *  - deadLinks：正文里 [[双链]] 指向了没有页面的标题（edges 的 dst_page 为空）；
 *  - duplicates：标题归一化后相同的页面组（疑似同一对象建了多页）。
 */

export interface DeadLinkSample {
  /** 被双链指向但没建页的标题 */
  title: string;
  /** 哪些页面链到它（最多 3 个） */
  from: string[];
}

export interface DuplicateSample {
  titles: string[];
  paths: string[];
}

export interface OutdatedSample {
  title: string;
  path: string;
  guideVersion: number;
}

export interface DreamAudit {
  checkedAt: string;
  /** 未提炼的原始资料份数 */
  pendingFiles: number;
  /** 其中还没有可读文本的（等自动提取完成，本轮先跳过） */
  pendingUnreadable: number;
  /** 待提炼清单样例（界面与作业手册都用它点名） */
  pendingSamples: string[];
  deadLinks: number;
  deadLinkSamples: DeadLinkSample[];
  duplicates: number;
  duplicateSamples: DuplicateSample[];
  outdatedPages: number;
  outdatedSamples: OutdatedSample[];
}

/** 样例条数上限：给 Agent 的是线索不是全量清单（全量让它自己用 MCP 工具查） */
const SAMPLE_LIMIT = 5;

/** 标题归一化：去空白与常见中英标点后比大小写无关的写法（只用来发现「疑似重复」） */
export function normalizeTitle(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()（）[\]【】「」『』《》<>〈〉·・,，.。;；:：!！?？'"“”‘’`~\-—_/\\|+*#$@%^&]/g, '');
}

/** 规则落后的概念/实体页（与 list_pages 的 outdated 口径一致） */
function outdatedPages(): OutdatedSample[] {
  const rows = db.prepare(
    `SELECT title, path, guide_version FROM pages
     WHERE deleted = 0
       AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
       AND COALESCE(guide_version, 0) < ?
     ORDER BY updated_at DESC`
  ).all(GUIDE_VERSION) as Array<{ title: string; path: string; guide_version: number }>;
  return rows.map((row) => ({
    title: String(row.title || ''),
    path: String(row.path || ''),
    guideVersion: Number(row.guide_version || 0),
  }));
}

/** 死链：正文双链指向的标题没有对应页面（dst_page 为空、dst_title 有值） */
function deadLinks(): DeadLinkSample[] {
  const rows = db.prepare(
    `SELECT e.dst_title AS title, p.title AS src
     FROM edges e
     JOIN pages p ON p.id = e.src_page AND p.deleted = 0
     WHERE e.rel = 'link' AND e.dst_page IS NULL
       AND e.dst_title IS NOT NULL AND e.dst_title <> ''
     ORDER BY e.dst_title`
  ).all() as Array<{ title: string; src: string }>;
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const title = String(row.title);
    const sources = grouped.get(title) ?? [];
    if (sources.length < 3 && !sources.includes(String(row.src))) sources.push(String(row.src));
    grouped.set(title, sources);
  }
  return [...grouped.entries()].map(([title, from]) => ({ title, from }));
}

/** 疑似重复：标题归一化后撞名的页面组 */
function duplicateTitles(): DuplicateSample[] {
  const rows = db.prepare(
    `SELECT title, path FROM pages
     WHERE deleted = 0 AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).all() as Array<{ title: string; path: string }>;
  const grouped = new Map<string, Array<{ title: string; path: string }>>();
  for (const row of rows) {
    const key = normalizeTitle(row.title);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), { title: String(row.title), path: String(row.path) }]);
  }
  return [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ titles: group.map((item) => item.title), paths: group.map((item) => item.path) }));
}

/**
 * 当前待办快照。只读索引库与磁盘清单，毫秒级，可在设置页状态轮询里直接调用。
 */
export function dreamAudit(): DreamAudit {
  const files = listRawMaterialFiles({ pending: true });
  const dead = deadLinks();
  const dups = duplicateTitles();
  const outdated = outdatedPages();
  return {
    checkedAt: new Date().toISOString(),
    pendingFiles: files.length,
    pendingUnreadable: files.filter((file) => !file.readable).length,
    pendingSamples: files.slice(0, SAMPLE_LIMIT).map((file) => file.path),
    deadLinks: dead.length,
    deadLinkSamples: dead.slice(0, SAMPLE_LIMIT),
    duplicates: dups.length,
    duplicateSamples: dups.slice(0, SAMPLE_LIMIT),
    outdatedPages: outdated.length,
    outdatedSamples: outdated.slice(0, SAMPLE_LIMIT),
  };
}

/** 待核查问题总数（死链 + 疑似重复 + 规则落后）：不含待提炼份数 */
export function dreamIssueTotal(audit: DreamAudit): number {
  return audit.deadLinks + audit.duplicates + audit.outdatedPages;
}

/** 一行概览：界面状态栏与操作日志共用 */
export function dreamAuditSummary(audit: DreamAudit): string {
  return `待提炼 ${audit.pendingFiles} 份 · 待核查 ${dreamIssueTotal(audit)} 处（死链 ${audit.deadLinks} · 疑似重复 ${audit.duplicates} · 规则落后 ${audit.outdatedPages}）`;
}

/** 待办是否为空：定时跑在这种情况直接跳过，不烧 token */
export function dreamAuditIdle(audit: DreamAudit): boolean {
  return audit.pendingFiles === 0 && dreamIssueTotal(audit) === 0;
}
