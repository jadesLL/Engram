import { db, newId, now } from '../lib/db.js';
import { invalidateGraphCache } from '../lib/graphCache.js';
import { wirePageEdges, resolveDeadLinks } from './extractor.js';
import { ftsSegment } from '../lib/fts.js';
import { readPage, scanVault } from '../lib/vault.js';

/**
 * 纯 FTS 索引层：向量/embedding 已随模型适配层移除。
 * 页面正文 FTS（pages_fts）由 vault.writePage 同步完成，这里只负责
 * 图谱边重建与兜底补写；文件提取文本 FTS（files_fts）在本层维护。
 */

/** 索引一个 md 页面：重建 wikilink 边 + 兜底补写 pages_fts（幂等） */
export async function indexPage(
  pageId: string,
  signal?: AbortSignal,
): Promise<{ indexed: boolean }> {
  signal?.throwIfAborted();
  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as any;
  if (!page) return { indexed: false };
  const rd = readPage(page.path);
  if (!rd) return { indexed: false };

  wirePageEdges(pageId, rd.content);
  resolveDeadLinks();
  // 边已重建，图谱缓存必须失效，否则用户刚保存就看不到新链接
  invalidateGraphCache();

  const fts = db.prepare(`SELECT 1 FROM pages_fts WHERE page_id = ?`).get(pageId);
  if (!fts) {
    db.prepare(`INSERT INTO pages_fts(title, content, tags, page_id) VALUES(?, ?, ?, ?)`).run(
      ftsSegment(page.title),
      ftsSegment(rd.content),
      ftsSegment((rd.meta.tags || []).join(' ')),
      pageId,
    );
  }
  return { indexed: true };
}

/** 清空一个文件的索引（fts），用于文本被清空或删除时 */
export function clearFileIndex(fileId: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM files_fts WHERE file_id = ?`).run(fileId);
    db.prepare(`DELETE FROM index_states WHERE ref_type='file' AND ref_id=?`).run(fileId);
  })();
}

/** 索引非 md 文件的提取文本（docx / pdf 文本层 / txt 等） */
export async function indexFileText(
  fileId: string,
  signal?: AbortSignal,
): Promise<{ indexed: boolean }> {
  signal?.throwIfAborted();
  const file = db.prepare(`SELECT * FROM files WHERE id = ? AND deleted = 0`).get(fileId) as any;
  if (!file) return { indexed: false };
  if (!file.text) {
    // 提取文本为空（如新版 PDF 全页失败）：必须清掉旧索引，
    // 否则 FTS 继续返回已失效的旧内容，且 rebuildAll 跳过空文本文件、无自愈路径。
    clearFileIndex(fileId);
    return { indexed: false };
  }
  db.transaction(() => {
    db.prepare(`DELETE FROM files_fts WHERE file_id = ?`).run(fileId);
    db.prepare(`INSERT INTO files_fts(name, content, file_id) VALUES(?, ?, ?)`).run(
      ftsSegment(file.name),
      ftsSegment(file.text),
      fileId,
    );
  })();
  return { indexed: true };
}

/** 全量重建：扫描 vault → 逐页重建边与 FTS、逐文件重建 files_fts。返回统计。 */
export async function rebuildAll(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<{ pages: number; files: number; errors: string[] }> {
  await scanVault();
  // 空文本文件不进重建列表，但要清掉可能残留的旧索引（历史版本提取过、新版提取为空）
  const emptyFiles = db
    .prepare(`SELECT id FROM files WHERE deleted = 0 AND (text IS NULL OR text = '')`)
    .all() as { id: string }[];
  for (const f of emptyFiles) clearFileIndex(f.id);
  const pages = db.prepare(`SELECT id FROM pages WHERE deleted = 0`).all() as { id: string }[];
  const files = db
    .prepare(`SELECT id FROM files WHERE deleted = 0 AND text != ''`)
    .all() as { id: string }[];
  const errors: string[] = [];
  for (const p of pages) {
    signal?.throwIfAborted();
    try {
      await indexPage(p.id, signal);
      onProgress?.(`page ${p.id}`);
    } catch (e: any) {
      errors.push(`page ${p.id}: ${e.message}`);
    }
  }
  for (const f of files) {
    signal?.throwIfAborted();
    try {
      await indexFileText(f.id, signal);
      onProgress?.(`file ${f.id}`);
    } catch (e: any) {
      errors.push(`file ${f.id}: ${e.message}`);
    }
  }
  return { pages: pages.length, files: files.length, errors };
}

/** 注册/更新一个非 md 文件记录 */
export function ensureFileRecord(relPath: string, size: number): string {
  const name = relPath.split('/').pop() || relPath;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const existing = db.prepare(`SELECT id, text FROM files WHERE path = ?`).get(relPath) as any;
  const id = existing?.id || newId();
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(path) DO UPDATE SET name=excluded.name, ext=excluded.ext, size=excluded.size,
       updated_at=excluded.updated_at, deleted=0`
  ).run(id, relPath, name, ext, size, existing?.text || '', now());
  return id;
}

/** 注册/更新一个非 md 文件记录，并替换其当前提取文本。 */
export function upsertFileRecord(relPath: string, text: string, size: number): string {
  const id = ensureFileRecord(relPath, size);
  db.prepare(`UPDATE files SET text = ?, updated_at = ?, deleted = 0 WHERE id = ?`)
    .run(text, now(), id);
  return id;
}
