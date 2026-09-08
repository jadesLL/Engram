import { db } from '../lib/db.js';
import { moveToTrash } from '../lib/trash.js';
import { appendWikiLog } from './indexFile.js';

/**
 * 外部 Agent 删除知识页的确定性内核，三端共用：
 *  - MCP `delete_page` 工具
 *  - REST `POST /api/agent/page/delete`（CLI `engram pages delete` 使用）
 *  - 后续其他 Agent 入口
 *
 * 约束（与《Agent 作业指南》一致）：
 *  - **只做软删除**：页面移入回收站（用户可在 设置 → 存储空间 → 回收站 恢复）；
 *    不提供永久删除或清空回收站能力，Agent 无法真正销毁内容
 *  - **只允许删 Wiki/ 下的页面**：原始资料/ 与 AIWorks/ 是只读区，Agent 不得删除
 *  - **定位支持路径 / ID / 标题**：标题不唯一时拒绝，要求改用页面 ID 或路径，避免删错同名页
 *  - 删除由服务端自动追加 AIWorks/log/log.md 操作日志，Agent 无需重复记录
 */

/** 可删前缀：Wiki 树（原始资料、AIWorks 为只读区） */
const DELETABLE_PREFIX = 'Wiki/';
/** 日志里的删除原因长度上限 */
const REASON_LIMIT = 200;

export class DeletePageError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface PageRow {
  id: string;
  path: string;
  title: string;
}

export interface DeletePageResult {
  id: string;
  path: string;
  title: string;
  /** 回收站条目 id（用户在回收站恢复时定位用） */
  trashId: string;
  deletedAt: string;
}

/** 按页面路径、页面 ID 或标题定位页面（路径含 / 或以 .md 结尾，标题经 createPage 清洗过不含这些字符） */
function resolvePage(titleOrId: string): PageRow {
  const ref = String(titleOrId ?? '').trim();
  if (!ref) throw new DeletePageError('需要页面标题、页面 ID 或页面路径');

  if (ref.includes('/') || /\.md$/i.test(ref)) {
    const byPath = db
      .prepare(`SELECT id, path, title FROM pages WHERE path = ? AND deleted = 0`)
      .get(ref) as PageRow | undefined;
    if (byPath) return byPath;
  }

  const byId = db
    .prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`)
    .get(ref) as PageRow | undefined;
  if (byId) return byId;

  const byTitle = db
    .prepare(`SELECT id, path, title FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`)
    .all(ref) as PageRow[];
  if (byTitle.length === 0) throw new DeletePageError(`页面不存在: ${ref}`, 404);
  if (byTitle.length > 1) {
    throw new DeletePageError(
      `标题「${ref}」对应 ${byTitle.length} 个页面（${byTitle.map((p) => p.path).join('、')}），请改用页面 ID 或页面路径指定`
    );
  }
  return byTitle[0];
}

/** 把单个 Wiki 页面移入回收站；只软删除，不做永久删除 */
export function deletePageAsAgent(titleOrId: string, options: { reason?: string } = {}): DeletePageResult {
  const page = resolvePage(titleOrId);
  if (!page.path.startsWith(DELETABLE_PREFIX)) {
    throw new DeletePageError(
      `只能删除 Wiki/ 下的页面；${page.path} 属于只读区（原始资料 / AIWorks），Agent 不可删除`,
      403
    );
  }

  const item = moveToTrash(page.path);
  const reason = String(options.reason ?? '').trim().replace(/\s+/g, ' ').slice(0, REASON_LIMIT);
  appendWikiLog(
    '删除',
    `[[${page.title}]]（${page.path}，已入回收站${reason ? ` · 原因：${reason}` : ''}）`
  );

  return {
    id: page.id,
    path: page.path,
    title: page.title,
    trashId: item.id,
    deletedAt: item.deletedAt,
  };
}
