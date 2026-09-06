import path from 'node:path';
import fs from 'node:fs';
import { db } from './db.js';
import { readPage, readPageMeta, writePage, movePage, safeJoin } from './vault.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';

export class RenameError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * 安全重命名页面：移动文件到同目录新标题、更新 frontmatter 标题、重定向所有引用双链。
 * 与 movePage 的区别：movePage 只移动文件不改正文引用，重命名会产生死链；
 * 本函数照 mergePages 的双链重定向逻辑，把其他页面里的 [[oldTitle]] 改成 [[newTitle]]。
 */
export function renamePageSafely(pageId: string, newTitle: string): void {
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
  if (newRel === page.path) throw new RenameError('路径未变化');
  if (path.posix.basename(newRel) === path.posix.basename(page.path)) {
    // 文件名相同但标题不同（极端字符归一化），仍需改正文标题，用 -1 后缀避免覆盖
    newRel = path.posix.join(dir, `${safeTitle}-1.md`);
  }
  // 同目录已有同名文件（同题页面/历史残留）时依次加 -N 后缀：
  // movePage 底层是 renameSync，撞名会静默覆盖它页数据（pages.path 冲突报错发生在覆盖之后）。
  let suffix = 1;
  while (fs.existsSync(safeJoin(newRel))) {
    newRel = path.posix.join(dir, `${safeTitle}-${++suffix}.md`);
  }

  const body = readPage(page.path);
  if (!body) throw new RenameError('文件读取失败', 404);

  // 正文 H1 同步为新标题（无 H1 时在开头补一行）
  const h1Synced = /^#\s+[^\n]*/m.test(body.content)
    ? body.content.replace(/^#\s+[^\n]*/m, () => `# ${title}`)
    : `# ${title}\n\n${body.content}`;

  movePage(page.path, newRel);
  writePage(newRel, h1Synced, { title });

  // 重定向引用：其他页面里的 [[oldTitle]] 改成 [[newTitle]]
  const referrers = db
    .prepare(`SELECT src_page FROM edges WHERE dst_page = ? AND rel = 'link'`)
    .all(pageId) as any[];
  for (const r of referrers) {
    const rp = db.prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`).get(r.src_page) as any;
    if (!rp) continue;
    const rd = readPage(rp.path);
    if (!rd) continue;
    const replaced = rd.content
      .split(`[[${oldTitle}]]`).join(`[[${title}]]`)
      .replace(new RegExp(`\\[\\[${oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`, 'g'), `[[${title}|`);
    if (replaced !== rd.content) {
      writePage(rp.path, replaced, {});
      enqueuePagePipeline(rp.id);
    }
  }

  appendWikiLog('重命名', `[[${oldTitle}]] → [[${title}]]（双链已重定向）`);
  enqueuePagePipeline(pageId);
}
