import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { TRASH_DIR, typeToDir } from '../config.js';
import { db, newId, now } from './db.js';
import { emit } from './events.js';
import { invalidateGraphCache } from './graphCache.js';
import { safeJoin, syncPageFile } from './vault.js';

export type TrashKind = 'page' | 'file';

interface TrashMetadata {
  version: 1;
  id: string;
  kind: TrashKind;
  originalPath: string;
  name: string;
  deletedAt: string;
  storedName: string;
  pageId?: string;
  fileId?: string;
}

export interface TrashItem {
  id: string;
  kind: TrashKind;
  name: string;
  originalPath: string;
  deletedAt: string;
  size: number;
  legacy: boolean;
  pageId?: string;
  fileId?: string;
  storedName: string;
  metadataName?: string;
}

export interface RestoredTrashItem {
  id: string;
  kind: TrashKind;
  name: string;
  path: string;
  pageId?: string;
  fileId?: string;
}

function normalizedRel(relPath: string): string {
  return relPath.replace(/^[/\\]+/, '').split('\\').join('/');
}

function trashFilePath(name: string): string {
  const abs = path.resolve(TRASH_DIR, name);
  if (abs !== TRASH_DIR && !abs.startsWith(TRASH_DIR + path.sep)) throw new Error('无效的回收站项目');
  return abs;
}

function metadataPath(name: string): string {
  return trashFilePath(name);
}

function safeTrashId(): string {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function fileSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

function rowForPagePath(relPath: string): any {
  return db.prepare(`SELECT id, path, title, type, deleted FROM pages WHERE path = ?`).get(relPath) as any;
}

function rowForFilePath(relPath: string): any {
  return db.prepare(`SELECT id, path, name, deleted FROM files WHERE path = ?`).get(relPath) as any;
}

/** 将 brain 内的页面或资料移动到回收站，并写入可恢复的元数据。 */
export function moveToTrash(relPath: string): TrashItem {
  const originalPath = normalizedRel(relPath);
  const source = safeJoin(originalPath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('文件不存在');

  const page = rowForPagePath(originalPath);
  const file = rowForFilePath(originalPath);
  const kind: TrashKind = page ? 'page' : 'file';
  const id = safeTrashId();
  const name = path.basename(originalPath);
  const storedName = `${id}-${name}`;
  const metadataName = `${id}.json`;
  const tmpMetadataName = `${metadataName}.tmp`;
  const destination = trashFilePath(storedName);
  const tmpMetadata = metadataPath(tmpMetadataName);
  const finalMetadata = metadataPath(metadataName);
  const deletedAt = now();
  const metadata: TrashMetadata = {
    version: 1,
    id,
    kind,
    originalPath,
    name: page?.title || file?.name || name,
    deletedAt,
    storedName,
    ...(page?.id ? { pageId: String(page.id) } : {}),
    ...(file?.id ? { fileId: String(file.id) } : {}),
  };

  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.writeFileSync(tmpMetadata, JSON.stringify(metadata, null, 2), 'utf8');
  try {
    fs.renameSync(source, destination);
    fs.renameSync(tmpMetadata, finalMetadata);
    const updateDb = db.transaction(() => {
      if (page?.id) {
        db.prepare(`UPDATE pages SET deleted = 1, updated_at = ? WHERE id = ?`).run(deletedAt, page.id);
        db.prepare(`DELETE FROM edges WHERE src_page = ? OR dst_page = ?`).run(page.id, page.id);
      }
      if (file?.id) {
        db.prepare(`UPDATE files SET deleted = 1, updated_at = ? WHERE id = ?`).run(deletedAt, file.id);
      }
    });
    updateDb();
  } catch (error) {
    try {
      if (fs.existsSync(destination)) fs.renameSync(destination, source);
    } catch {
      /* preserve the original failure */
    }
    try { fs.unlinkSync(tmpMetadata); } catch { /* noop */ }
    try { fs.unlinkSync(finalMetadata); } catch { /* noop */ }
    throw error;
  }

  if (page?.id) {
    invalidateGraphCache();
    emit('page-deleted', { path: originalPath, id: page.id });
  }

  return {
    ...metadata,
    size: fileSize(destination),
    legacy: false,
    metadataName,
  };
}

function readMetadata(fileName: string): TrashMetadata | null {
  try {
    const value = JSON.parse(fs.readFileSync(metadataPath(fileName), 'utf8')) as Partial<TrashMetadata>;
    if (
      value.version !== 1 ||
      !value.id ||
      !value.storedName ||
      !value.originalPath ||
      (value.kind !== 'page' && value.kind !== 'file')
    ) return null;
    return value as TrashMetadata;
  } catch {
    return null;
  }
}

function frontmatterInfo(abs: string): { id?: string; title?: string; type?: string } {
  try {
    const data = matter(fs.readFileSync(abs, 'utf8')).data as Record<string, any>;
    return {
      id: typeof data.id === 'string' ? data.id : undefined,
      title: typeof (data['标题'] ?? data.title) === 'string' ? String(data['标题'] ?? data.title) : undefined,
      type: typeof (data['类型'] ?? data.type) === 'string' ? String(data['类型'] ?? data.type) : undefined,
    };
  } catch {
    return {};
  }
}

function legacyTimestamp(storedName: string, abs: string): string {
  const match = storedName.match(/^(\d{10,})-/);
  const value = match ? Number(match[1]) : NaN;
  if (Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  try {
    return fs.statSync(abs).mtime.toISOString();
  } catch {
    return now();
  }
}

function legacyName(storedName: string): string {
  return storedName.replace(/^\d{10,}-/, '');
}

function legacyItem(storedName: string): TrashItem {
  const abs = trashFilePath(storedName);
  const name = legacyName(storedName);
  const ext = path.extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') {
    const info = frontmatterInfo(abs);
    const row = info.id
      ? db.prepare(`SELECT id, path, title, type FROM pages WHERE id = ?`).get(info.id) as any
      : undefined;
    const inferredDir = ['concept', 'person', 'project', 'org'].includes(info.type || '')
      ? typeToDir(info.type!)
      : '原始资料';
    return {
      id: `legacy:${Buffer.from(storedName, 'utf8').toString('base64url')}`,
      kind: 'page',
      name: row?.title || info.title || path.basename(name, ext),
      originalPath: row?.path || path.posix.join(inferredDir, name),
      deletedAt: legacyTimestamp(storedName, abs),
      size: fileSize(abs),
      legacy: true,
      pageId: row?.id || info.id,
      storedName,
    };
  }

  const fileRows = db
    .prepare(`SELECT id, path, name FROM files WHERE deleted = 1 AND name = ? ORDER BY updated_at DESC`)
    .all(name) as any[];
  const file = fileRows[0];
  return {
    id: `legacy:${Buffer.from(storedName, 'utf8').toString('base64url')}`,
    kind: 'file',
    name: file?.name || name,
    originalPath: file?.path || path.posix.join('原始资料', name),
    deletedAt: legacyTimestamp(storedName, abs),
    size: fileSize(abs),
    legacy: true,
    fileId: file?.id,
    storedName,
  };
}

/** 扫描新元数据项目和历史扁平文件，按删除时间倒序返回。 */
export function listTrashItems(): TrashItem[] {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const entries = fs.readdirSync(TRASH_DIR, { withFileTypes: true });
  const claimed = new Set<string>();
  const metadataFiles = new Set<string>();
  const items: TrashItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const metadata = readMetadata(entry.name);
    if (!metadata) continue;
    metadataFiles.add(entry.name);
    const stored = trashFilePath(metadata.storedName);
    if (!fs.existsSync(stored) || !fs.statSync(stored).isFile()) continue;
    claimed.add(metadata.storedName);
    items.push({
      ...metadata,
      size: fileSize(stored),
      legacy: false,
      metadataName: entry.name,
    });
  }

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      claimed.has(entry.name) ||
      metadataFiles.has(entry.name) ||
      entry.name.endsWith('.tmp')
    ) continue;
    items.push(legacyItem(entry.name));
  }

  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

function findTrashItem(id: string): TrashItem {
  const item = listTrashItems().find((candidate) => candidate.id === id);
  if (!item) throw new Error('回收站项目不存在');
  return item;
}

function targetAvailable(relPath: string, kind: TrashKind, reusableId?: string): boolean {
  if (fs.existsSync(safeJoin(relPath))) return false;
  const table = kind === 'page' ? 'pages' : 'files';
  const row = db.prepare(`SELECT id, deleted FROM ${table} WHERE path = ?`).get(relPath) as any;
  return !row || (Boolean(reusableId) && row.id === reusableId && row.deleted === 1);
}

function availableRestorePath(originalPath: string, kind: TrashKind, reusableId?: string): string {
  const normalized = normalizedRel(originalPath);
  if (!normalized || normalized.startsWith('.trash/') || normalized === '.trash') {
    throw new Error('原路径无效');
  }
  if (targetAvailable(normalized, kind, reusableId)) return normalized;
  const ext = path.posix.extname(normalized);
  const base = ext ? normalized.slice(0, -ext.length) : normalized;
  let index = 1;
  let candidate = `${base}-恢复-${index}${ext}`;
  while (!targetAvailable(candidate, kind)) candidate = `${base}-恢复-${++index}${ext}`;
  return candidate;
}

function rewritePageId(relPath: string, id: string) {
  const abs = safeJoin(relPath);
  const parsed = matter(fs.readFileSync(abs, 'utf8'));
  parsed.data.id = id;
  fs.writeFileSync(abs, matter.stringify(parsed.content, parsed.data), 'utf8');
}

function restorePage(item: TrashItem, targetPath: string): string {
  const info = frontmatterInfo(safeJoin(targetPath));
  const desiredId = item.pageId || info.id;
  const existingById = desiredId
    ? db.prepare(`SELECT id, path, deleted FROM pages WHERE id = ?`).get(desiredId) as any
    : undefined;
  const canReuse =
    Boolean(desiredId) &&
    (!existingById || (existingById.deleted === 1 && existingById.path === targetPath));
  if (!canReuse) rewritePageId(targetPath, newId());
  const meta = syncPageFile(targetPath);
  if (!meta) throw new Error('页面索引恢复失败');
  emit('page-changed', { path: targetPath, id: meta.id });
  return meta.id;
}

function restoreFile(item: TrashItem, targetPath: string): string | undefined {
  const existing = item.fileId
    ? db.prepare(`SELECT * FROM files WHERE id = ?`).get(item.fileId) as any
    : undefined;
  if (!existing) return undefined;

  const reusable = existing.deleted === 1 && existing.path === targetPath;
  const id = reusable ? String(existing.id) : newId();
  const stat = fs.statSync(safeJoin(targetPath));
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(path) DO UPDATE SET name=excluded.name, ext=excluded.ext, size=excluded.size,
       text=excluded.text, updated_at=excluded.updated_at, deleted=0`
  ).run(
    id,
    targetPath,
    path.posix.basename(targetPath),
    path.posix.extname(targetPath).slice(1).toLowerCase(),
    stat.size,
    existing.text || '',
    now()
  );
  return id;
}

/** 恢复单个项目；文件系统失败时回滚到回收站。 */
export function restoreTrashItem(id: string): RestoredTrashItem {
  const item = findTrashItem(id);
  const source = trashFilePath(item.storedName);
  const reusableId = item.kind === 'page' ? item.pageId : item.fileId;
  const targetPath = availableRestorePath(item.originalPath, item.kind, reusableId);
  const target = safeJoin(targetPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);

  try {
    const pageId = item.kind === 'page' ? restorePage(item, targetPath) : undefined;
    const fileId = item.kind === 'file' ? restoreFile(item, targetPath) : undefined;
    if (item.metadataName) {
      try { fs.unlinkSync(metadataPath(item.metadataName)); } catch { /* stale sidecars are ignored */ }
    }
    return { id: item.id, kind: item.kind, name: item.name, path: targetPath, pageId, fileId };
  } catch (error) {
    try { fs.renameSync(target, source); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function deletePageIndex(pageId: string) {
  const page = db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(pageId) as any;
  if (!page || page.deleted !== 1) return;
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE ref_type = 'page' AND ref_id = ?)`
    ).run(pageId);
    db.prepare(`DELETE FROM chunks WHERE ref_type = 'page' AND ref_id = ?`).run(pageId);
    db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM edges WHERE src_page = ? OR dst_page = ?`).run(pageId, pageId);
    db.prepare(`DELETE FROM pages WHERE id = ? AND deleted = 1`).run(pageId);
  });
  tx();
  invalidateGraphCache();
}

function deleteFileIndex(fileId: string) {
  const file = db.prepare(`SELECT deleted FROM files WHERE id = ?`).get(fileId) as any;
  if (!file || file.deleted !== 1) return;
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE ref_type = 'file' AND ref_id = ?)`
    ).run(fileId);
    db.prepare(`DELETE FROM chunks WHERE ref_type = 'file' AND ref_id = ?`).run(fileId);
    db.prepare(`DELETE FROM files_fts WHERE file_id = ?`).run(fileId);
    db.prepare(`DELETE FROM files WHERE id = ? AND deleted = 1`).run(fileId);
  });
  tx();
}

/** 永久删除一个回收站项目及仍处于 deleted 状态的索引记录。 */
export function permanentlyDeleteTrashItem(id: string): TrashItem {
  const item = findTrashItem(id);
  fs.unlinkSync(trashFilePath(item.storedName));
  if (item.metadataName) {
    try { fs.unlinkSync(metadataPath(item.metadataName)); } catch { /* noop */ }
  }
  if (item.pageId) deletePageIndex(item.pageId);
  if (item.fileId) deleteFileIndex(item.fileId);
  return item;
}

/** 清空全部可见项目，并清理孤立 sidecar/临时文件。 */
export function emptyTrash(): { deleted: TrashItem[]; errors: { id: string; error: string }[] } {
  const deleted: TrashItem[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const item of listTrashItems()) {
    try {
      deleted.push(permanentlyDeleteTrashItem(item.id));
    } catch (error: any) {
      errors.push({ id: item.id, error: error?.message || String(error) });
    }
  }
  if (!errors.length) {
    for (const entry of fs.readdirSync(TRASH_DIR)) {
      fs.rmSync(path.join(TRASH_DIR, entry), { recursive: true, force: true });
    }
  }
  return { deleted, errors };
}

export function publicTrashItem(item: TrashItem) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    originalPath: item.originalPath,
    deletedAt: item.deletedAt,
    size: item.size,
    legacy: item.legacy,
  };
}
