import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-page-id-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let ensureDirs: () => void;
let createPage: (dir: string, title: string) => any;
let safeJoin: (relPath: string) => string;
let syncPageFile: (relPath: string) => any;

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ ensureDirs } = await import('../config.js'));
  ({ createPage, safeJoin, syncPageFile } = await import('./vault.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM vec_chunks;
    DELETE FROM chunks;
    DELETE FROM edges;
    DELETE FROM pages_fts;
    DELETE FROM page_contributions;
    DELETE FROM page_syntheses;
    DELETE FROM source_versions;
    DELETE FROM pages;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 造齐旧 id 的子表引用：contributions/syntheses（带 FK）+ chunks/edges（逻辑引用） */
function seedReferences(oldId: string) {
  db.prepare(
    `INSERT INTO source_versions(id, path, content_hash, created_at)
     VALUES('sv-1', '原始资料/源.md', 'hash-1', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO page_contributions(id, page_id, source_version_id, run_id, contribution_key, created_at, updated_at)
     VALUES('pc-1', ?, 'sv-1', 'run-1', 'key-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(oldId);
  db.prepare(
    `INSERT INTO page_syntheses(id, page_id, input_hash, evidence_hash, status, created_at, updated_at)
     VALUES('ps-1', ?, 'hash-a', 'hash-e', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(oldId);
  const chunk = db.prepare(
    `INSERT INTO chunks(ref_type, ref_id, idx, heading, content) VALUES('page', ?, 0, '', '内容')`
  ).run(oldId);
  db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES(?, ?)`)
    .run(BigInt(chunk.lastInsertRowid), JSON.stringify(Array(1536).fill(0)));
  db.prepare(
    `INSERT INTO edges(src_page, dst_title, rel, created_at) VALUES(?, '目标', 'link', '2026-01-01')`
  ).run(oldId);
  db.prepare(
    `INSERT INTO edges(src_page, dst_title, dst_page, rel, created_at) VALUES('其他页', '标题', ?, 'link', '2026-01-01')`
  ).run(oldId);
}

test('frontmatter id diverging from the row id migrates child references instead of crashing', () => {
  const page = createPage('Wiki/实体', '京卓信');
  const oldId = page.id;
  seedReferences(oldId);

  // 复现线上事故：文件 frontmatter id 被改成新值，DB 行仍持旧 id 且被子表引用
  const newId = 'afe4e07c-48d1-45cf-a817-6ba154945472';
  fs.writeFileSync(
    safeJoin(page.path),
    matter.stringify('# 京卓信 正文', { id: newId, 标题: '京卓信', 类型: 'org' }),
    'utf8'
  );

  const meta = syncPageFile(page.path);
  assert.equal(meta.id, newId);
  assert.equal(db.prepare(`SELECT id FROM pages WHERE path = ?`).get(page.path).id, newId);

  // 带外键的两张表随行 id 迁移，不再触发 SQLITE_CONSTRAINT_FOREIGNKEY
  assert.equal(db.prepare(`SELECT page_id FROM page_contributions WHERE id = 'pc-1'`).get().page_id, newId);
  assert.equal(db.prepare(`SELECT page_id FROM page_syntheses WHERE id = 'ps-1'`).get().page_id, newId);
  // 逻辑引用同步迁移，向量与图谱不悬空
  assert.equal(db.prepare(`SELECT ref_id FROM chunks WHERE ref_type = 'page'`).get().ref_id, newId);
  assert.equal(db.prepare(`SELECT count(*) n FROM edges WHERE src_page = ?`).get(newId).n, 1);
  assert.equal(db.prepare(`SELECT count(*) n FROM edges WHERE dst_page = ?`).get(newId).n, 1);
  // fts 按新 id 重建
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts WHERE page_id = ?`).get(newId).n > 0, true);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts WHERE page_id = ?`).get(oldId).n, 0);
  // 迁移只改引用列，chunk 行本身（向量 rowid）不动
  assert.equal(db.prepare(`SELECT count(*) n FROM vec_chunks`).get().n, 1);
});

test('id unchanged path stays a no-op and old references are untouched', () => {
  const page = createPage('Wiki/概念', '稳定页面');
  seedReferences(page.id);
  const meta = syncPageFile(page.path);
  assert.equal(meta.id, page.id);
  assert.equal(db.prepare(`SELECT page_id FROM page_contributions WHERE id = 'pc-1'`).get().page_id, page.id);
});

/**
 * 回归：页面行 upsert、DELETE pages_fts、INSERT pages_fts 原先分三条裸执行，
 * 中途失败（如 FTS 写失败）会留下「行更新了、FTS 没更新（或没有）」的半套状态。
 * 三条必须在同一事务里：任一步失败整体回滚。
 */
test('syncPageFile：FTS 写入失败时页面行 upsert 一并回滚（同事务）', () => {
  const page = createPage('Wiki/概念', '事务回滚测试页');
  const before = db.prepare(`SELECT word_count, updated_at FROM pages WHERE id = ?`).get(page.id);

  // 改磁盘正文（保留 frontmatter 的 id/标题），让 syncPageFile 需要更新行与 FTS
  const parsed = matter(fs.readFileSync(safeJoin(page.path), 'utf8'));
  fs.writeFileSync(
    safeJoin(page.path),
    matter.stringify(
      '# 事务回滚测试页\n\n改过的正文：这一段用来确认页面行确实需要更新（词数与原来明显不同）。\n',
      parsed.data
    ),
    'utf8'
  );

  // 让 FTS 写入那一步必失败：临时移走 pages_fts；事务中途出错必须整体回滚
  db.exec(`DROP TABLE pages_fts`);
  try {
    assert.throws(() => syncPageFile(page.path), /pages_fts/);
  } finally {
    db.exec(
      `CREATE VIRTUAL TABLE pages_fts USING fts5(title, content, tags, page_id UNINDEXED, tokenize = 'unicode61')`
    );
  }

  const after = db.prepare(`SELECT word_count, updated_at FROM pages WHERE id = ?`).get(page.id);
  assert.deepEqual(after, before, 'FTS 写失败时同一事务里的页面行 upsert 必须回滚');
});
