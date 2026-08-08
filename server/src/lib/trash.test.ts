import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-trash-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let ensureDirs: () => void;
let TRASH_DIR: string;
let createPage: (dir: string, title: string) => any;
let safeJoin: (relPath: string) => string;
let syncPageFile: (relPath: string) => any;
let moveToTrash: (relPath: string) => any;
let listTrashItems: () => any[];
let restoreTrashItem: (id: string) => any;
let permanentlyDeleteTrashItem: (id: string) => any;
let emptyTrash: () => any;

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ ensureDirs, TRASH_DIR } = await import('../config.js'));
  ({ createPage, safeJoin, syncPageFile } = await import('./vault.js'));
  ({
    moveToTrash,
    listTrashItems,
    restoreTrashItem,
    permanentlyDeleteTrashItem,
    emptyTrash,
  } = await import('./trash.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM vec_chunks;
    DELETE FROM chunks;
    DELETE FROM edges;
    DELETE FROM pages_fts;
    DELETE FROM files_fts;
    DELETE FROM pages;
    DELETE FROM files;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('page deletion writes metadata and restores the original path', () => {
  const page = createPage('Wiki/概念', '可恢复页面');
  const trashed = moveToTrash(page.path);
  assert.equal(trashed.kind, 'page');
  assert.equal(fs.existsSync(safeJoin(page.path)), false);
  assert.equal(db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(page.id).deleted, 1);
  assert.equal(listTrashItems()[0].originalPath, page.path);

  const restored = restoreTrashItem(trashed.id);
  assert.equal(restored.path, page.path);
  assert.equal(restored.pageId, page.id);
  assert.equal(fs.existsSync(safeJoin(page.path)), true);
  assert.equal(db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(page.id).deleted, 0);
  assert.equal(listTrashItems().length, 0);
});

test('binary files restore with a conflict suffix and a fresh database id', () => {
  const rel = '原始资料/报价单.pdf';
  fs.writeFileSync(safeJoin(rel), Buffer.from('first'));
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES('file-old', ?, '报价单.pdf', 'pdf', 5, '报价', '2026-01-01T00:00:00.000Z', 0)`
  ).run(rel);
  const trashed = moveToTrash(rel);
  fs.writeFileSync(safeJoin(rel), Buffer.from('replacement'));

  const restored = restoreTrashItem(trashed.id);
  assert.equal(restored.path, '原始资料/报价单-恢复-1.pdf');
  assert.notEqual(restored.fileId, 'file-old');
  assert.equal(fs.readFileSync(safeJoin(restored.path), 'utf8'), 'first');
  assert.equal(db.prepare(`SELECT deleted FROM files WHERE id = 'file-old'`).get().deleted, 1);
});

test('legacy markdown prefers its database path and falls back to raw materials', () => {
  const page = createPage('Wiki/实体', '历史实体');
  const legacyName = `1786000000000-${path.basename(page.path)}`;
  fs.renameSync(safeJoin(page.path), path.join(TRASH_DIR, legacyName));
  db.prepare(`UPDATE pages SET deleted = 1 WHERE id = ?`).run(page.id);

  const noteName = '1786000000001-旧纪要.md';
  fs.writeFileSync(
    path.join(TRASH_DIR, noteName),
    matter.stringify('# 旧纪要\n', { id: 'legacy-note', title: '旧纪要', type: 'note' }),
    'utf8'
  );

  const items = listTrashItems();
  const entity = items.find((item) => item.storedName === legacyName);
  const note = items.find((item) => item.storedName === noteName);
  assert.equal(entity.originalPath, page.path);
  assert.equal(entity.pageId, page.id);
  assert.equal(note.originalPath, '原始资料/旧纪要.md');
  assert.equal(note.legacy, true);
});

test('restoring an older page beside an active copy assigns a new page id', () => {
  const page = createPage('Wiki/概念', '重复页面');
  const trashed = moveToTrash(page.path);
  fs.writeFileSync(
    safeJoin(page.path),
    matter.stringify('# 当前版本\n', { id: 'active-copy', title: '重复页面', type: 'concept' }),
    'utf8'
  );
  syncPageFile(page.path);

  const restored = restoreTrashItem(trashed.id);
  assert.equal(restored.path, 'Wiki/概念/重复页面-恢复-1.md');
  assert.notEqual(restored.pageId, page.id);
  const restoredData = matter(fs.readFileSync(safeJoin(restored.path), 'utf8')).data;
  assert.equal(restoredData.id, restored.pageId);
});

test('permanent deletion removes page search records, chunks, vectors and edges', () => {
  const page = createPage('Wiki/概念', '永久删除页面');
  const chunk = db.prepare(
    `INSERT INTO chunks(ref_type, ref_id, idx, heading, content) VALUES('page', ?, 0, '', '内容')`
  ).run(page.id);
  db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES(?, ?)`)
    .run(BigInt(chunk.lastInsertRowid), JSON.stringify(Array(1536).fill(0)));
  db.prepare(
    `INSERT INTO edges(src_page, dst_title, rel, created_at) VALUES(?, '目标', 'link', '2026-01-01')`
  ).run(page.id);
  const trashed = moveToTrash(page.path);

  permanentlyDeleteTrashItem(trashed.id);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages WHERE id = ?`).get(page.id).n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts WHERE page_id = ?`).get(page.id).n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM chunks WHERE ref_id = ?`).get(page.id).n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM vec_chunks`).get().n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM edges WHERE src_page = ?`).get(page.id).n, 0);
});

test('permanent deletion of a historical copy does not clear an active page index', () => {
  const page = createPage('Wiki/概念', '活动页面');
  const legacyName = `1786000000002-${path.basename(page.path)}`;
  fs.copyFileSync(safeJoin(page.path), path.join(TRASH_DIR, legacyName));
  const beforeFts = db.prepare(`SELECT count(*) n FROM pages_fts WHERE page_id = ?`).get(page.id).n;
  const legacy = listTrashItems().find((item) => item.storedName === legacyName);

  permanentlyDeleteTrashItem(legacy.id);
  assert.equal(db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(page.id).deleted, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts WHERE page_id = ?`).get(page.id).n, beforeFts);
});

test('empty trash removes new and legacy items', () => {
  const page = createPage('Wiki/概念', '批量清空');
  moveToTrash(page.path);
  fs.writeFileSync(path.join(TRASH_DIR, '1786000000010-遗留.txt'), 'legacy', 'utf8');

  const result = emptyTrash();
  assert.equal(result.errors.length, 0);
  assert.equal(result.deleted.length, 2);
  assert.deepEqual(fs.readdirSync(TRASH_DIR), []);
});
