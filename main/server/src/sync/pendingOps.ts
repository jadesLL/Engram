import { db, now } from '../lib/db.js';

/**
 * 成员端待推送 outbox（只覆盖会改变目录结构的 page/file/delete/move）。
 *
 * 为什么必须落库：旧实现只有内存数组，离线删除/改名后进程一重启队列就没了；
 * 下一次全量对账看到「中枢还有这个路径、本机没有」，会把它当成“本机缺这一份”
 * 拉回来——用户看到的就是「删了又回来」「改名后新旧两份」。
 *
 * 会话删除走 assistant_session_tombstones（对账时补推）；偏好/看板/调研由各自的
 * LWW 时间戳兜底，不在这里重复存。
 */

export interface PendingOp {
  id: number;
  kind: string;
  target: string;
  oldPath: string;
  deleted: boolean;
  deletedAt: string;
  createdAt: string;
}

const PERSISTED_KINDS = new Set(['page', 'file', 'delete', 'move']);

export function isPersistedKind(kind: string): boolean {
  return PERSISTED_KINDS.has(kind);
}

/**
 * 写入一条待推送操作，返回 outbox 行 id。
 * page/file 按 kind+target 去重（同一份内容反复保存只留一行）；move/delete 保序，不合并。
 */
export function persistPendingOp(
  kind: string,
  target: string,
  oldPath = '',
  deleted = false,
  deletedAt = ''
): number | null {
  if (!isPersistedKind(kind)) return null;
  if (kind === 'page' || kind === 'file') {
    const existing = db
      .prepare(`SELECT id FROM sync_pending_ops WHERE kind = ? AND target = ? LIMIT 1`)
      .get(kind, target) as { id: number } | undefined;
    if (existing) return Number(existing.id);
  }
  const result = db
    .prepare(
      `INSERT INTO sync_pending_ops(kind, target, old_path, deleted, deleted_at, created_at)
       VALUES(?,?,?,?,?,?)`
    )
    .run(kind, target, oldPath, deleted ? 1 : 0, deletedAt, now());
  return Number(result.lastInsertRowid);
}

/** 推送收口（成功 / 永久失败 / 本地已无内容）后删行 */
export function removePendingOp(id: number | null | undefined): void {
  if (!id) return;
  db.prepare(`DELETE FROM sync_pending_ops WHERE id = ?`).run(id);
}

/** 客户端启动时恢复：按入队顺序还原 outbox */
export function loadPendingOps(): PendingOp[] {
  const rows = db
    .prepare(
      `SELECT id, kind, target, old_path, deleted, deleted_at, created_at
       FROM sync_pending_ops ORDER BY id`
    )
    .all() as any[];
  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    target: String(row.target),
    oldPath: String(row.old_path || ''),
    deleted: Number(row.deleted || 0) === 1,
    deletedAt: String(row.deleted_at || ''),
    createdAt: String(row.created_at || ''),
  }));
}

/** 换中枢 / 解除绑定：旧关系里的待推操作不再带到新中枢 */
export function clearPendingOps(): void {
  db.prepare(`DELETE FROM sync_pending_ops`).run();
}

/** 对账时跳过中枢旧路径：本机待删除的路径、本机已改名移走的旧路径 */
export function pendingPathGuards(): { deleteTargets: Set<string>; moveOldPaths: Set<string> } {
  const deleteTargets = new Set<string>();
  const moveOldPaths = new Set<string>();
  const rows = db.prepare(`SELECT kind, target, old_path FROM sync_pending_ops`).all() as any[];
  for (const row of rows) {
    const kind = String(row.kind || '');
    if (kind === 'delete') deleteTargets.add(String(row.target || ''));
    if (kind === 'move' && row.old_path) moveOldPaths.add(String(row.old_path));
  }
  return { deleteTargets, moveOldPaths };
}
