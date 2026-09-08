import path from 'node:path';
import { db } from '../lib/db.js';
import { moveToTrash } from '../lib/trash.js';
import { appendWikiLog } from './indexFile.js';
import { movePage, readPage, writePage, pagePathTaken } from '../lib/vault.js';
import { renamePageSafely, RenameError } from '../lib/renamePage.js';
import { isPageDir, normalizeDir } from '../config.js';

/**
 * 外部 Agent 页面操作（删除/重命名/移动）的确定性内核，三端共用：
 *  - MCP `delete_page` / `rename_page` / `move_page` 工具
 *  - REST `POST /api/agent/page/delete|rename|move`（CLI `engram pages delete|rename|move` 使用）
 *  - 后续其他 Agent 入口
 *
 * 约束（与《Agent 作业指南》一致）：
 *  - **只做软删除**：页面移入回收站（用户可在 设置 → 存储空间 → 回收站 恢复）；
 *    不提供永久删除或清空回收站能力，Agent 无法真正销毁内容
 *  - **只允许操作 Wiki/ 下的页面**：原始资料/ 与 AIWorks/ 是只读区，Agent 不得删除/改名/移动
 *  - **定位支持路径 / ID / 标题**：标题不唯一时拒绝，要求改用页面 ID 或路径，避免操作错同名页
 *  - 操作由服务端自动追加 AIWorks/log/log.md 操作日志，Agent 无需重复记录
 */

/** 可操作前缀：Wiki 树（原始资料、AIWorks 为只读区） */
const WIKI_PREFIX = 'Wiki/';
/** 日志里的删除原因长度上限 */
const REASON_LIMIT = 200;

/** Agent 页面操作门禁错误 */
export class AgentPageError extends Error {
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
export function resolvePageRef(titleOrId: string): PageRow {
  const ref = String(titleOrId ?? '').trim();
  if (!ref) throw new AgentPageError('需要页面标题、页面 ID 或页面路径');

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
  if (byTitle.length === 0) throw new AgentPageError(`页面不存在: ${ref}`, 404);
  if (byTitle.length > 1) {
    throw new AgentPageError(
      `标题「${ref}」对应 ${byTitle.length} 个页面（${byTitle.map((p) => p.path).join('、')}），请改用页面 ID 或页面路径指定`
    );
  }
  return byTitle[0];
}

/** 只读区守卫：原始资料 / AIWorks 下的页面不允许 Agent 删除/改名/移动 */
function assertWikiPage(page: PageRow): void {
  if (!page.path.startsWith(WIKI_PREFIX)) {
    throw new AgentPageError(
      `只能操作 Wiki/ 下的页面；${page.path} 属于只读区（原始资料 / AIWorks），Agent 不可操作`,
      403
    );
  }
}

/** 把单个 Wiki 页面移入回收站；只软删除，不做永久删除 */
export function deletePageAsAgent(titleOrId: string, options: { reason?: string } = {}): DeletePageResult {
  const page = resolvePageRef(titleOrId);
  assertWikiPage(page);

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

export interface RenamePageResult {
  id: string;
  /** 重命名后的路径（文件随标题移动） */
  path: string;
  title: string;
}

/** 重命名 Wiki 页面：文件随标题移动 + 改标题 + 重定向引用双链（内核 renamePageSafely） */
export function renamePageAsAgent(titleOrId: string, newTitle: string): RenamePageResult {
  const page = resolvePageRef(titleOrId);
  assertWikiPage(page);

  try {
    renamePageSafely(page.id, String(newTitle ?? ''));
  } catch (error) {
    if (error instanceof RenameError) throw new AgentPageError(error.message, error.status);
    throw error;
  }
  const fresh = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(page.id) as PageRow;
  return { id: page.id, path: fresh.path, title: fresh.title };
}

export interface MovePageResult {
  id: string;
  /** 移动后的路径 */
  path: string;
  title: string;
  /** false 表示目标与原路径相同，未做任何改动 */
  moved: boolean;
}

/** 移动 Wiki 页面到 Wiki 树内的目标目录，可顺带改标题（不改写引用双链，与用户侧 /api/pages/:id/move 同语义） */
export function movePageAsAgent(
  titleOrId: string,
  options: { dir?: string; newTitle?: string } = {}
): MovePageResult {
  const page = resolvePageRef(titleOrId);
  assertWikiPage(page);

  const targetDir = options.dir !== undefined ? (normalizeDir(options.dir) || 'Wiki') : path.posix.dirname(page.path);
  if (!isPageDir(targetDir)) {
    throw new AgentPageError(`页面只能移动到 Wiki 目录内（如 Wiki/概念、Wiki/实体）：${targetDir}`, 400);
  }
  const newTitle = String(options.newTitle ?? '').trim();
  const filename = ((newTitle || page.title).replace(/[\\/:*?"<>|]/g, '-') || '未命名页面') + '.md';
  let newRel = path.posix.join(targetDir, filename);
  if (newRel === page.path) {
    return { id: page.id, path: page.path, title: page.title, moved: false };
  }
  // 与 renamePageSafely 同一撞名防线：文件或 pages 记录（含回收站软删除行）已占用即加 -N 后缀，
  // 否则 movePage 底层的 renameSync / path 唯一约束会出事
  let suffix = 1;
  while (pagePathTaken(newRel)) {
    suffix += 1;
    newRel = path.posix.join(targetDir, filename.replace(/\.md$/, `-${suffix}.md`));
  }

  movePage(page.path, newRel);
  if (newTitle && newTitle !== page.title) {
    const rd = readPage(newRel);
    if (rd) writePage(newRel, rd.content, { title: newTitle });
  }
  appendWikiLog('移动', `[[${page.title}]] → ${newRel}`);
  return { id: page.id, path: newRel, title: newTitle || page.title, moved: true };
}
