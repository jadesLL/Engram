import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { readPage, writePage, movePage, safeJoin } from './vault.js';
import { ARCHIVE_DIR } from '../config.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';

/** 年月日时分秒时间戳（日志标注用） */
export function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 操作日志写入 AIWorks/log/<file> */
export function appendLog(file: string, title: string, line: string) {
  try {
    const rel = `AIWorks/log/${file}`;
    const rd = readPage(rel);
    const content = rd ? `${rd.content}\n${line}` : `# ${title}\n\n${line}`;
    writePage(rel, content + '\n', { title });
  } catch { /* 日志失败不阻塞主流程 */ }
}

/** 合并参数/数据错误，携带 HTTP 状态码供路由映射 */
export class MergeError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * 合并两页：keep 吸收 other 的内容（追加为其时间线事件），other 归档，写合并日志。
 * 由 /api/pages/merge 路由与 Dream 分类批量处置共用。
 */
export function mergePages(keepId: string, otherId: string): void {
  if (!keepId || !otherId || keepId === otherId) throw new MergeError('参数错误');
  const keep = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(keepId) as any;
  const other = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(otherId) as any;
  if (!keep || !other) throw new MergeError('页面不存在', 404);
  const kc = readPage(keep.path);
  const oc = readPage(other.path);
  if (!kc || !oc) throw new MergeError('文件读取失败', 404);

  const day = new Date().toISOString().slice(0, 10);
  // keep 追加合并事件（实体页进时间线，其他页加补充小节）
  let newContent: string;
  if (/##\s*时间线/.test(kc.content)) {
    newContent = kc.content.replace(
      /(##\s*时间线[\s\S]*)$/,
      (tl) => `${tl.trim()}\n- ${day}: 合并吸收了 [[${other.title}]] 的内容\n`
    );
    // 把 other 的核心内容并入"当前理解"
    newContent = newContent.replace(
      /(##\s*当前理解[\s\S]*?)(\n##\s*时间线)/,
      `$1\n\n> 合并自 [[${other.title}]]（${day}）：\n${oc.content.replace(/^#\s+.+$/m, '').slice(0, 800)}\n$2`
    );
  } else {
    newContent = `${kc.content}\n\n## 合并自 [[${other.title}]]（${day}）\n\n${oc.content.replace(/^#\s+.+$/m, '').slice(0, 800)}\n`;
  }
  writePage(keep.path, newContent, {});

  // other 移入归档
  let archiveRel = path.posix.join(ARCHIVE_DIR, path.posix.basename(other.path));
  let i = 1;
  while (fs.existsSync(safeJoin(archiveRel))) {
    archiveRel = path.posix.join(ARCHIVE_DIR, `${path.posix.basename(other.path, '.md')}-${i++}.md`);
  }
  movePage(other.path, archiveRel);

  // 重定向引用：其他页面里的 [[other.title]] 改成 [[keep.title]]
  const referrers = db
    .prepare(`SELECT src_page FROM edges WHERE dst_page = ? AND rel = 'link'`)
    .all(other.id) as any[];
  for (const r of referrers) {
    const rp = db.prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`).get(r.src_page) as any;
    if (!rp || rp.id === keep.id) continue;
    const rd = readPage(rp.path);
    if (!rd) continue;
    const replaced = rd.content
      .split(`[[${other.title}]]`).join(`[[${keep.title}]]`)
      .replace(new RegExp(`\\[\\[${other.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`, 'g'), `[[${keep.title}|`);
    if (replaced !== rd.content) writePage(rp.path, replaced, {});
  }

  appendLog('merges.md', '合并日志', `- ${stamp()} 「${other.title}」合并入「${keep.title}」（原页已归档）`);
  appendWikiLog('合并', `[[${other.title}]] 合并入 [[${keep.title}]]`);
  enqueuePagePipeline(keep.id);
}
