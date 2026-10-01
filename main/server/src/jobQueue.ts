import { db, now } from './lib/db.js';

export function enqueue(kind: string, payload: unknown, options: { dedupeRecent?: boolean } = {}): number | undefined {
  const payloadStr = JSON.stringify(payload);
  const duplicate = db
    .prepare(`SELECT id FROM jobs WHERE kind = ? AND payload = ? AND status IN ('pending','running','paused')`)
    .get(kind, payloadStr);
  if (duplicate) return undefined;

  const recent = options.dedupeRecent === false ? null : db
    .prepare(
      `SELECT id FROM jobs WHERE kind = ? AND payload = ? AND status = 'done'
       AND julianday(run_at) > julianday('now', '-60 seconds')`
    )
    .get(kind, payloadStr);
  if (recent) return undefined;

  const info = db
    .prepare(`INSERT INTO jobs(kind, payload, status, created_at, updated_at) VALUES(?, ?, 'pending', ?, ?)`)
    .run(kind, payloadStr, now(), now());
  return Number(info.lastInsertRowid);
}

/** 页面保存后的后台处理：FTS/图谱边（vault 层已同步写 pages_fts，这里补边与兜底） */
export function enqueuePagePipeline(pageId: string): void {
  enqueue('process', { pageId });
}

/** 灵感提炼任务类型（执行体见 lib/ideaDistill.ts，接口口径见 docs/IDEA-DISTILL-SPEC.md 第 3 节） */
export const IDEA_DISTILL_KIND = 'idea_distill';

export interface IdeaDistillJobPayload {
  id: string;
  path: string;
  /** 入队时磁盘内容的 sha256（含 frontmatter）：执行体用它判断用户有没有手改 */
  hash: string;
  createdAt?: string;
  /** 执行体收尾回填的结果（见 saveIdeaDistillResult），状态查询与前端都从这一行走 */
  result?: unknown;
}

export interface IdeaDistillJobRow {
  id: number;
  status: string;
  error: string | null;
  payload: IdeaDistillJobPayload;
}

function parseJobPayload(raw: unknown): Record<string, any> | null {
  try {
    const parsed = JSON.parse(String(raw ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 查一条灵感的提炼任务行。按页面 id 优先、路径回退：提炼成功会改名，
 * payload 里记的是**改名前**的路径，用路径当主键找第二次就找不到了。
 *
 * 过滤放在 SQL 里（json_extract）而不是取一批回 JS 里筛：任务表会一直长，
 * 「第 51 条之后的老任务查不到」这种窗口问题不该由调用方承担；`json_valid` 兜住
 * 历史脏载荷，别让一条坏数据把整个查询弄抛。
 */
export function findIdeaDistillJob(query: {
  id?: string;
  path?: string;
  /** 只看排队/在跑的任务（「重新提炼」按 path 去重时用） */
  activeOnly?: boolean;
}): IdeaDistillJobRow | undefined {
  const clauses = ['kind = ?', 'json_valid(payload)'];
  const params: unknown[] = [IDEA_DISTILL_KIND];
  if (query.activeOnly) clauses.push(`status IN ('pending','running','paused')`);
  if (query.id) {
    clauses.push(`json_extract(payload, '$.id') = ?`);
    params.push(query.id);
  }
  if (query.path) {
    clauses.push(`json_extract(payload, '$.path') = ?`);
    params.push(query.path);
  }
  const row = db
    .prepare(`SELECT id, status, error, payload FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT 1`)
    .get(...params) as { id: number; status: string; error: string | null; payload: string } | undefined;
  if (!row) return undefined;
  const payload = parseJobPayload(row.payload);
  if (!payload) return undefined;
  return { id: row.id, status: row.status, error: row.error ?? null, payload: payload as IdeaDistillJobPayload };
}

/**
 * 灵感提炼入队，返回真正要跟踪的 jobId 与「是不是复用了已有任务」（spec：**同 path 已有
 * 排队/在跑的任务就复用它**）。`reused: true` 时前端别再起一条新的跟踪链。
 */
export function enqueueIdeaDistill(payload: IdeaDistillJobPayload): { jobId: number | null; reused: boolean } {
  // 先按 path 找在跑/排队的那一份：**不能只靠 enqueue 的载荷去重**——「重新提炼」算出的
  // createdAt（或用户手改后的 hash）与旧载荷不同，载荷比对认不出这是同一条灵感，会排第二条。
  const existing = findIdeaDistillJob({ path: payload.path, activeOnly: true });
  if (existing) return { jobId: existing.id, reused: true };
  // 显式动作（记下来 / 重新提炼）不该被 enqueue 的「60 秒内做过同样的任务」窗口吞掉
  const jobId = enqueue(IDEA_DISTILL_KIND, payload, { dedupeRecent: false });
  return { jobId: jobId ?? null, reused: false };
}

/**
 * 提炼结果写回任务行 payload.result：jobs 表没有 result 列，而状态查询
 * （GET /api/ideas/:id/distill）要报出勘误明细与精炼字数。为一条任务的私有产物
 * 新增列/表要动 db.ts 的迁移，写回自己的 payload 最省事；回填发生在任务收尾，
 * enqueue 的去重只看 pending/running，不影响后续入队。
 */
export function saveIdeaDistillResult(jobId: number, result: unknown): void {
  const row = db.prepare(`SELECT payload FROM jobs WHERE id = ?`).get(jobId) as { payload: string } | undefined;
  if (!row) return;
  const payload = parseJobPayload(row.payload) ?? {};
  payload.result = result;
  db.prepare(`UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(payload), now(), jobId);
}
