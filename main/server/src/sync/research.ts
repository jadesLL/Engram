import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';

/**
 * 客户调研（客户洞察）的跨端同步。
 *
 * 与页面/文件、会话的差别都写在这里：
 *  - 调研任务是 DATA_DIR/wiki.db 里的一行记录，不在 brain 目录下，safeJoin 到不了，
 *    所以单独一类而不是复用 file；
 *  - 只同步**完成态**：`report` 非空（已生成报告，含未保存草稿）才跨端；进行中/失败/排队中的
 *    任务留在本机执行端——半截内容跨端没有意义，也会让对端出现一条点开没内容的记录；
 *  - 不做字符级合并：任务行创建后基本不可变（报告一旦生成只读），按同一 id 以 updatedAt
 *    新者胜整体覆盖即可；
 *  - 不做墓碑：客户洞察目前没有删除入口，不发明删除协议（页面/会话的墓碑是因为有删除动作）；
 *  - sessionId/runId 不同步：对端没有对应的执行轮次，带过去只会多出一个点开就空的「查看执行过程」；
 *  - 报告原始资料文件本身已由「原始资料」分类同步，这里不重复搬文件；任务快照仍带 report 正文，
 *    保证对端客户洞察页可直接翻阅（即使原始资料分类关闭）。
 *
 * 流程模板（customer_research_rules）不在这里：它复用既有 preference 同步管道（最新写入者胜）。
 *
 * 模块只依赖 db 与 crypto（不 import 同步层其他模块），供 hub/client/index/routes 共用，
 * 避免接线时出现循环依赖。
 */

/** 对账清单最多列多少条调研记录（按最近更新倒序），避免记录很多时清单本身变成负担 */
export const RESEARCH_MANIFEST_LIMIT = 200;
/** 清单里客户名的最大长度（只用于展示，不必带全文） */
const CUSTOMER_LIMIT = 80;

/** 客户调研任务快照：只含跨端有意义的字段（不含 sessionId/runId） */
export interface ResearchSnapshot {
  id: string;
  customer: string;
  scope: string;
  client: string;
  /** 任务创建时的流程快照（JSON 字符串，原样跨端，保证历史报告的「流程 vN」可显示） */
  rules: string;
  saveRequested: number;
  /** 报告 Markdown 正文；空 = 未完成，不参与同步 */
  report: string;
  /** 已保存的原始资料路径（空 = 未保存草稿） */
  path: string;
  createdAt: string;
  updatedAt: string;
  reportDate: string;
  timeZone: string;
}

/** 与 customer_research_tasks 表列同名（snake_case）的行 */
interface ResearchRow {
  id: string;
  customer: string;
  scope: string;
  client: string;
  rules: string;
  save_requested: number;
  session_id: string;
  run_id: string;
  report: string;
  path: string;
  created_at: string;
  updated_at: string;
  report_date: string;
  time_zone: string;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 流程快照必须是可解析的 JSON 对象：`customerResearchTasks()` 直接 `JSON.parse(task.rules).version`
 * 渲染客户洞察页，一条坏 rules 会让整个 `GET /api/customer-research` 500。远端数据不可信，
 * 合并前先在此拦住（本模块不能 import research/customerResearch 兜底默认模板：那条链会与本模块成环）。
 */
function rulesParsable(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && typeof (parsed as { version?: unknown }).version === 'number';
  } catch {
    return false;
  }
}

/** DB 行 → 快照：所有字符串字段统一归一，避免 NULL/数字混入使两端算出不同的 hash */
function snapshotOf(row: ResearchRow): ResearchSnapshot {
  return {
    id: str(row.id),
    customer: str(row.customer),
    scope: str(row.scope),
    client: str(row.client),
    rules: str(row.rules),
    saveRequested: Number(row.save_requested || 0),
    report: str(row.report),
    path: str(row.path),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    reportDate: str(row.report_date),
    timeZone: str(row.time_zone),
  };
}

/**
 * 收集一个调研任务的完成态快照。
 * 任务不存在、或还没有报告（进行中/失败/排队）时返回 null——这些状态留在本机，不参与同步。
 */
export function collectResearchSnapshot(taskId: string): ResearchSnapshot | null {
  const row = db.prepare(`SELECT * FROM customer_research_tasks WHERE id = ?`).get(taskId) as
    | ResearchRow
    | undefined;
  if (!row) return null;
  const snapshot = snapshotOf(row);
  return snapshot.report ? snapshot : null;
}

/**
 * 参与 hash 的投影：只含会同步的字段，按**固定顺序**排列。
 * 两端（推送方与中枢/另一成员）必须算出同一个 hash——对账清单靠它判断「这一条要不要拉」，
 * 所以：不含 sessionId/runId（不同步），字段顺序写死，不依赖对象键顺序或 SQL 列顺序。
 */
function projectionOf(snapshot: ResearchSnapshot): string {
  return JSON.stringify([
    snapshot.id,
    snapshot.customer,
    snapshot.scope,
    snapshot.client,
    snapshot.rules,
    Number(snapshot.saveRequested || 0),
    snapshot.report,
    snapshot.path,
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.reportDate,
    snapshot.timeZone,
  ]);
}

export function researchSnapshotHash(snapshot: ResearchSnapshot): string {
  return crypto.createHash('sha256').update(projectionOf(snapshot)).digest('hex');
}

/** 本端某条调研记录的内容 hash（精确，只用于单条）；不存在/未完成返回空串 */
export function researchContentHash(taskId: string): string {
  const snapshot = collectResearchSnapshot(taskId);
  return snapshot ? researchSnapshotHash(snapshot) : '';
}

/** 本端某条调研记录的更新时间（与远端快照比较新旧）；不存在返回空串 */
export function researchUpdatedAt(taskId: string): string {
  const row = db.prepare(`SELECT updated_at FROM customer_research_tasks WHERE id = ?`).get(taskId) as
    | { updated_at: string }
    | undefined;
  return str(row?.updated_at);
}

export interface ResearchMergeResult {
  created: boolean;
  updated: boolean;
}

/**
 * 合并一份远端调研快照：按同一 id、以 updatedAt 新者胜整体覆盖。
 *
 * 任务行创建后基本不可变（报告生成后只读），所以不做字符级合并。
 * updatedAt 相等时只补本端空着的 report/path/rules（同一时刻两边各自写出的内容，
 * 补空不会覆盖已有内容）；真的补上了才报告 updated，让 hub 知道需要广播。
 * 幂等：同一份快照应用两次，第二次 created/updated 都是 false。
 */
export function mergeResearchSnapshot(snapshot: ResearchSnapshot): ResearchMergeResult {
  const id = str(snapshot?.id);
  const report = str(snapshot?.report);
  // 未完成态（report 空）不进同步链路：可能是旧版本客户端推来的半截任务
  if (!id || !report) return { created: false, updated: false };
  const customer = str(snapshot.customer).trim();
  const rules = str(snapshot.rules);
  // 坏行不进库：客户名是界面上识别这条记录的唯一依据，rules 坏了会拖垮整个客户洞察列表接口
  if (!customer || !rulesParsable(rules)) return { created: false, updated: false };
  const incoming: ResearchSnapshot = {
    ...snapshot,
    id,
    customer,
    // 范围只有两个合法取值：未知值按默认的 knowledge-web 归一，避免对端渲染出「未定义范围」
    scope: snapshot.scope === 'knowledge-only' ? 'knowledge-only' : 'knowledge-web',
    client: str(snapshot.client),
    rules,
    saveRequested: Number(snapshot.saveRequested || 0),
    report,
    path: str(snapshot.path),
    createdAt: str(snapshot.createdAt),
    updatedAt: str(snapshot.updatedAt),
    reportDate: str(snapshot.reportDate),
    timeZone: str(snapshot.timeZone),
  };
  const local = db.prepare(`SELECT * FROM customer_research_tasks WHERE id = ?`).get(id) as
    | ResearchRow
    | undefined;
  if (!local) {
    // 本端没有：整条插入。sessionId/runId 留空——执行轮次只属于产生这条任务的设备
    db.prepare(
      `INSERT INTO customer_research_tasks(id, customer, scope, client, rules, save_requested, session_id, run_id,
                                           report, path, created_at, updated_at, report_date, time_zone)
       VALUES(?,?,?,?,?,?,'','',?,?,?,?,?,?)`
    ).run(
      incoming.id,
      incoming.customer,
      incoming.scope,
      incoming.client,
      incoming.rules,
      incoming.saveRequested,
      incoming.report,
      incoming.path,
      incoming.createdAt || now(),
      incoming.updatedAt || now(),
      incoming.reportDate,
      incoming.timeZone,
    );
    return { created: true, updated: false };
  }

  const localSnapshot = snapshotOf(local);
  const incomingAt = incoming.updatedAt || now();
  if (incomingAt > localSnapshot.updatedAt) {
    // 远端更新：整行覆盖（报告正文、保存路径、流程快照一起换）。
    // sessionId/runId 保持本端原值（本端空就是空，不搬对端的执行轮次）
    db.prepare(
      `UPDATE customer_research_tasks SET customer=?, scope=?, client=?, rules=?, save_requested=?,
         report=?, path=?, created_at=?, updated_at=?, report_date=?, time_zone=?
       WHERE id=?`
    ).run(
      incoming.customer,
      incoming.scope,
      incoming.client,
      incoming.rules,
      incoming.saveRequested,
      incoming.report,
      incoming.path,
      incoming.createdAt || localSnapshot.createdAt,
      incomingAt,
      incoming.reportDate,
      incoming.timeZone,
      id,
    );
    return { created: false, updated: true };
  }
  // 本端更新或一样新：不搬远端内容（任务行不可变，本地已有更完整的版本时不该被顶回去）
  if (incomingAt < localSnapshot.updatedAt) return { created: false, updated: false };

  // 同一时刻：只补本端空着的字段，不覆盖已有内容
  const reportValue = localSnapshot.report || incoming.report;
  const pathValue = localSnapshot.path || incoming.path;
  const rulesValue = localSnapshot.rules || incoming.rules;
  if (reportValue === localSnapshot.report && pathValue === localSnapshot.path && rulesValue === localSnapshot.rules) {
    return { created: false, updated: false };
  }
  db.prepare(`UPDATE customer_research_tasks SET report=?, path=?, rules=? WHERE id=?`).run(
    reportValue,
    pathValue,
    rulesValue,
    id,
  );
  return { created: false, updated: true };
}

export interface ResearchManifestEntry {
  id: string;
  customer: string;
  updatedAt: string;
  /** 快照 hash（对不上就拉这一条的完整快照） */
  hash: string;
}

/**
 * 参与同步的调研记录清单：只列完成态（有报告），按最近更新倒序、最多 RESEARCH_MANIFEST_LIMIT 条。
 *
 * 清单只带客户名与快照 hash，不搬报告正文：报告可能很长，对账时逐条比对只需要 hash。
 * hash 直接按行内容算（记录数 ≤200，一次读入内存可接受；不为此新增 DB 列）。
 */
export function researchManifest(): ResearchManifestEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM customer_research_tasks
       WHERE report <> ''
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(RESEARCH_MANIFEST_LIMIT) as ResearchRow[];
  return rows.map((row) => {
    const snapshot = snapshotOf(row);
    return {
      id: snapshot.id,
      customer: snapshot.customer.slice(0, CUSTOMER_LIMIT),
      updatedAt: snapshot.updatedAt,
      hash: researchSnapshotHash(snapshot),
    };
  });
}
