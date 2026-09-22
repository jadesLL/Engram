import path from 'node:path';
import { db } from './db.js';
import { readPage, writePage, movePage, pagePathTaken } from './vault.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';

export class RenameError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface RenamePageOptions {
  /** 正文 H1 是否同步为新标题（默认同步：Agent rename_page 的既定语义）。
   *  编辑器里改标题时正文由用户掌控，服务端改写 H1 会和浏览器里未保存的内容打架，传 false。 */
  syncH1?: boolean;
  /** 标题变了、但规范化后的文件名与现路径相同（只差非法字符）时，是否降级为「只改标题不改名」。
   *  默认 false：Agent 改名要拿到明确的新路径，路径没变属于异常。 */
  allowSamePath?: boolean;
}

export interface RenamePageResult {
  id: string;
  /** 重命名后的路径 */
  path: string;
  title: string;
  /** false = 路径没变（只有标题变化） */
  moved: boolean;
}

/**
 * 把其他页面里引用 [[oldTitle]] 的双链改成 [[newTitle]]。
 * 重命名（本文件）与带外改名的认领（lib/vaultWatch.ts）共用：标题是双链的身份，
 * 改了标题不重定向就会留下死链。
 */
export function redirectWikiLinks(pageId: string, oldTitle: string, newTitle: string): number {
  const referrers = db
    .prepare(`SELECT src_page FROM edges WHERE dst_page = ? AND rel = 'link'`)
    .all(pageId) as any[];
  let redirected = 0;
  for (const r of referrers) {
    const rp = db.prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`).get(r.src_page) as any;
    if (!rp) continue;
    const rd = readPage(rp.path);
    if (!rd) continue;
    const replaced = rd.content
      .split(`[[${oldTitle}]]`).join(`[[${newTitle}]]`)
      .replace(new RegExp(`\\[\\[${oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`, 'g'), `[[${newTitle}|`);
    if (replaced !== rd.content) {
      writePage(rp.path, replaced, {});
      enqueuePagePipeline(rp.id);
      redirected++;
    }
  }
  return redirected;
}

/**
 * 安全重命名页面：移动文件到同目录新标题、更新 frontmatter 标题、重定向所有引用双链。
 * 与 movePage 的区别：movePage 只移动文件不改正文引用，重命名会产生死链；
 * 本函数照 mergePages 的双链重定向逻辑，把其他页面里的 [[oldTitle]] 改成 [[newTitle]]。
 */
export function renamePageSafely(
  pageId: string,
  newTitle: string,
  options: RenamePageOptions = {}
): RenamePageResult {
  const title = String(newTitle || '').trim();
  if (!title) throw new RenameError('新标题不能为空');
  if (/[\\/:*?"<>|]/.test(title)) throw new RenameError('标题含非法字符');

  const page = db.prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as any;
  if (!page) throw new RenameError('页面不存在', 404);
  if (page.title === title) throw new RenameError('标题未变化');

  const oldTitle = page.title;
  const dir = path.posix.dirname(page.path);
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').trim();
  let newRel = path.posix.join(dir, `${safeTitle}.md`);
  if (newRel === page.path) {
    // 文件名相同但标题不同（极端字符归一化）：默认按异常处理；编辑器保存路径传 allowSamePath
    // 降级为「只改标题」，免得用户只改了标点就保存失败。
    if (!options.allowSamePath) throw new RenameError('路径未变化');
    const samePathBody = readPage(page.path);
    if (!samePathBody) throw new RenameError('文件读取失败', 404);
    writePage(page.path, samePathBody.content, { title });
    redirectWikiLinks(pageId, oldTitle, title);
    appendWikiLog('重命名', `[[${oldTitle}]] → [[${title}]]（双链已重定向）`);
    enqueuePagePipeline(pageId);
    return { id: pageId, path: page.path, title, moved: false };
  }
  if (path.posix.basename(newRel) === path.posix.basename(page.path)) {
    // 文件名相同但标题不同（极端字符归一化），仍需改正文标题，用 -1 后缀避免覆盖
    newRel = path.posix.join(dir, `${safeTitle}-1.md`);
  }
  // 同目录已有同名文件或 pages 记录（含回收站软删除行）时依次加 -N 后缀：
  // movePage 底层是 renameSync，撞名会静默覆盖它页数据（pages.path 冲突报错发生在覆盖之后）。
  let suffix = 1;
  while (pagePathTaken(newRel)) {
    newRel = path.posix.join(dir, `${safeTitle}-${++suffix}.md`);
  }

  const body = readPage(page.path);
  if (!body) throw new RenameError('文件读取失败', 404);

  // 正文 H1 同步为新标题（无 H1 时在开头补一行）；syncH1=false 时正文原样带走
  const nextBody = options.syncH1 === false
    ? body.content
    : /^#\s+[^\n]*/m.test(body.content)
      ? body.content.replace(/^#\s+[^\n]*/m, () => `# ${title}`)
      : `# ${title}\n\n${body.content}`;

  movePage(page.path, newRel);
  writePage(newRel, nextBody, { title });
  redirectWikiLinks(pageId, oldTitle, title);

  appendWikiLog('重命名', `[[${oldTitle}]] → [[${title}]]（双链已重定向）`);
  enqueuePagePipeline(pageId);
  return { id: pageId, path: newRel, title, moved: true };
}
