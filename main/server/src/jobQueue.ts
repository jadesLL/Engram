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
