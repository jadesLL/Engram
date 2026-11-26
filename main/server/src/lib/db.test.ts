import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先设 DATA_DIR 再动态导入（db.js 在导入时按 DATA_DIR 建库，避免污染 worktree）
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-db-migrate-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  migrate();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/**
 * 回归：extractor 的死链回填（resolveDeadLinks）与 wikilink 解析（wirePageEdges）都按
 * lower(title) 匹配，而 pages 上原先只有 path 唯一索引——每次页面索引都要全表扫，
 * rebuildAll 逐页跑会放大成 O(页 × 链 × 页)。迁移必须建出 lower(title) 表达式索引。
 */
test('migrate 建立 pages(lower(title)) 表达式索引，标题匹配不再全表扫', () => {
  const index = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_pages_title_lower'`)
    .get() as { sql?: string } | undefined;
  assert.ok(index, '缺少 pages(title) 的 lower(title) 表达式索引');
  assert.match(String(index?.sql).toLowerCase(), /lower\(title\)/);

  // 塞几行再看向量：标题等值匹配（extractor 的写法）必须走这个索引而不是扫表
  const insert = db.prepare(
    `INSERT INTO pages(id, path, title, created_at, updated_at) VALUES(?, ?, ?, '2026-01-01', '2026-01-01')`
  );
  for (let i = 0; i < 30; i += 1) insert.run(`p-${i}`, `Wiki/概念/页${i}.md`, `页${i}`);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`)
    .all('页7') as Array<{ detail?: string }>;
  assert.ok(
    plan.some((row) => String(row.detail).includes('idx_pages_title_lower')),
    `标题等值匹配应走表达式索引：${JSON.stringify(plan)}`
  );
});

/**
 * 回归：移除 sqlite-vec 扩展后，存量数据库仍保留 vec_chunks 虚表及其影子表；
 * better-sqlite3 默认开启 SQLITE_DBCONFIG_DEFENSIVE，单设 writable_schema = ON
 * 不会生效，migrate() 会直接抛 SQLITE_ERROR: table sqlite_master may not be modified。
 */
test('migrate 能安全清理无 vec0 扩展的遗留 vec_chunks 虚表与影子表，并恢复防御模式', () => {
  db.unsafeMode(true);
  try {
    db.pragma('writable_schema = ON');
    db.prepare(
      `INSERT INTO sqlite_master(type, name, tbl_name, rootpage, sql)
       VALUES('table', 'vec_chunks', 'vec_chunks', 0, 'CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[1536])')`
    ).run();
  } finally {
    try {
      db.pragma('writable_schema = RESET');
    } finally {
      db.unsafeMode(false);
    }
  }

  db.exec(`CREATE TABLE vec_chunks_info (key TEXT PRIMARY KEY, value ANY)`);
  db.exec(`CREATE TABLE vec_chunks_chunks (chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, size INTEGER NOT NULL, validity BLOB NOT NULL, rowids BLOB NOT NULL)`);
  db.exec(`CREATE TABLE vec_chunks_rowids (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id, chunk_id INTEGER, chunk_offset INTEGER)`);
  db.exec(`CREATE TABLE vec_chunks_vector_chunks00 (rowid PRIMARY KEY, vectors BLOB NOT NULL)`);
  db.prepare(`INSERT INTO vec_chunks_info(key, value) VALUES('test', '1')`).run();
  db.prepare(`INSERT INTO vec_chunks_chunks(size, validity, rowids) VALUES(1, X'01', X'01')`).run();

  migrate();

  const leftover = db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_chunks' OR name LIKE 'vec_chunks_%'`)
    .all() as Array<{ name: string }>;
  assert.deepEqual(leftover, [], `应清理全部 vec_chunks 及影子表，残留: ${JSON.stringify(leftover)}`);

  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  assert.deepEqual(integrity, [{ integrity_check: 'ok' }]);

  assert.equal(db.pragma('writable_schema', { simple: true }), 0);
  assert.throws(
    () => {
      db.pragma('writable_schema = ON');
      db.prepare(`DELETE FROM sqlite_master WHERE name = 'nonexistent'`).run();
    },
    /may not be modified/
  );

  // 幂等：再次迁移无副作用
  migrate();
});
