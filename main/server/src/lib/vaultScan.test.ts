import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

// 先设 DATA_DIR 再动态导入：config/db 在导入时按 DATA_DIR 建目录与打开库
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-vault-scan-'));
process.env.DATA_DIR = temp;

interface ScanResult { pages: number; skipped: number; changed: number }

let db: any;
let migrate: () => void;
let ensureDirs: () => void;
let BRAIN_DIR: string;
let scanVault: () => Promise<void>;
let scanVaultPages: () => Promise<ScanResult>;
let scanVaultDeferred: () => Promise<void>;
let writePage: (rel: string, content: string, extra?: Record<string, any>) => any;
let movePage: (oldRel: string, newRel: string) => any;
let safeJoin: (rel: string) => string;

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ ensureDirs, BRAIN_DIR } = await import('../config.js'));
  ({ scanVault, scanVaultPages, scanVaultDeferred, writePage, movePage, safeJoin } = await import('./vault.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM pages_fts;
    DELETE FROM pages;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 直接落盘一个页面文件（不走 writePage），模拟外部拷入/历史文件 */
function writeRaw(rel: string, body: string, frontmatter?: Record<string, any>): string {
  const abs = path.join(BRAIN_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const raw = frontmatter ? matter.stringify(body, frontmatter) : body;
  fs.writeFileSync(abs, raw, 'utf8');
  return abs;
}

function rowByPath(rel: string): any {
  return db.prepare(`SELECT * FROM pages WHERE path = ?`).get(rel);
}

function ftsRows(pageId: string): any[] {
  return db.prepare(`SELECT title, content FROM pages_fts WHERE page_id = ?`).all(pageId);
}

/* ---------------- 增量判定 ---------------- */

test('首次扫描全量建指纹（含 frontmatter 归一化后的新 mtime），第二次全部跳过且不改文件/行', async () => {
  writeRaw('Wiki/概念/甲.md', '# 甲\n\n第一页正文。\n');
  writeRaw('Wiki/概念/乙.md', '# 乙\n\n第二页正文，稍微长一点的内容。\n');
  writeRaw('Wiki/实体/丙.md', '# 丙实体\n\n第三页。\n', { 标题: '丙实体', 类型: 'org' });

  const first = await scanVaultPages();
  assert.deepEqual(first, { pages: 3, skipped: 0, changed: 3 });

  const rows = db.prepare(`SELECT id, path, updated_at, file_mtime_ms, file_size FROM pages ORDER BY path`).all() as any[];
  assert.equal(rows.length, 3);
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts`).get().n, 3);
  for (const row of rows) {
    const stat = fs.statSync(path.join(BRAIN_DIR, row.path));
    // 首扫会回写 frontmatter（补 id/创建日期），指纹必须取在回写之后，否则下次启动仍会重算
    assert.equal(typeof row.file_mtime_ms, 'number');
    assert.equal(row.file_mtime_ms, stat.mtimeMs, `${row.path} 指纹 mtime 应为归一化后的新 mtime`);
    assert.equal(row.file_size, stat.size);
  }

  const before = rows.map((row) => ({
    id: row.id,
    path: row.path,
    updated_at: row.updated_at,
    content: fs.readFileSync(path.join(BRAIN_DIR, row.path), 'utf8'),
    mtimeMs: fs.statSync(path.join(BRAIN_DIR, row.path)).mtimeMs,
  }));

  const second = await scanVaultPages();
  assert.deepEqual(second, { pages: 3, skipped: 3, changed: 0 });

  for (const snap of before) {
    const row = rowByPath(snap.path);
    assert.equal(row.id, snap.id);
    assert.equal(row.updated_at, snap.updated_at, `${snap.path} 跳过时不应更新行`);
    assert.equal(fs.readFileSync(path.join(BRAIN_DIR, snap.path), 'utf8'), snap.content, '跳过时不应重写文件');
    assert.equal(fs.statSync(path.join(BRAIN_DIR, snap.path)).mtimeMs, snap.mtimeMs, '跳过时不应触碰文件');
  }
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts`).get().n, 3, '跳过时 FTS 行数不变');
});

test('文件内容改动后重算一次并刷新行/FTS/指纹', async () => {
  const abs = writeRaw('Wiki/概念/改动.md', '# 改动\n\n原始正文。\n');
  await scanVaultPages();
  const before = rowByPath('Wiki/概念/改动.md');
  const oldId = before.id;

  // 外部追加正文（保留 frontmatter）：mtime、size 都变
  fs.appendFileSync(abs, '\n追加的新正文：独有关键词「海马体」。\n', 'utf8');

  const res = await scanVaultPages();
  assert.deepEqual(res, { pages: 1, skipped: 0, changed: 1 });
  const after = rowByPath('Wiki/概念/改动.md');
  assert.equal(after.id, oldId);
  assert.ok(after.word_count > before.word_count, '词数应随正文更新');
  const fts = ftsRows(oldId);
  assert.equal(fts.length, 1);
  // ftsSegment 会把中文切成 bigram（"海马体" → "海马 马体 ..."），断言前缀词即可
  assert.match(fts[0].content, /海马/, 'FTS 应写入新正文');

  // 指纹已写回（与当前 stat 一致）：下一次扫描跳过
  const stat = fs.statSync(abs);
  assert.equal(after.file_mtime_ms, stat.mtimeMs);
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });
});

test('touch 但内容不变：重算一次（无害），随后恢复跳过', async () => {
  const abs = writeRaw('Wiki/概念/触摸.md', '# 触摸\n\n内容固定不变。\n');
  await scanVaultPages();

  // 只改 mtime（内容与 size 都不变），模拟同步工具/备份还原的 touch
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(abs, future, future);

  const res = await scanVaultPages();
  assert.deepEqual(res, { pages: 1, skipped: 0, changed: 1 });
  assert.equal(ftsRows(rowByPath('Wiki/概念/触摸.md').id).length, 1);
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });
});

/* ---------------- FTS 一致性与自愈 ---------------- */

test('单页 FTS 行缺失：强制重算并补索引', async () => {
  writeRaw('Wiki/概念/索引.md', '# 索引\n\n需要索引的正文。\n');
  await scanVaultPages();
  const row = rowByPath('Wiki/概念/索引.md');
  db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(row.id);

  const res = await scanVaultPages();
  assert.deepEqual(res, { pages: 1, skipped: 0, changed: 1 });
  assert.equal(ftsRows(row.id).length, 1, 'FTS 缺行必须补回');
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });
});

test('FTS 分词版本迁移清空索引后自动全量重建（指纹不能掩盖空索引）', async () => {
  writeRaw('Wiki/概念/一.md', '# 一\n\n内容一。\n');
  writeRaw('Wiki/概念/二.md', '# 二\n\n内容二。\n');
  await scanVaultPages();
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts`).get().n, 2);

  // migrate() 在分词版本变化时会清空 pages_fts，但指纹仍命中——扫描必须靠 FTS 集合判定重建
  db.exec(`DELETE FROM pages_fts`);
  const res = await scanVaultPages();
  assert.deepEqual(res, { pages: 2, skipped: 0, changed: 2 });
  assert.equal(db.prepare(`SELECT count(*) n FROM pages_fts`).get().n, 2);
});

/* ---------------- 软删 / 老库升级 / id 迁移 ---------------- */

test('行被软删但文件还在：扫描复活行并写回指纹', async () => {
  writeRaw('Wiki/概念/复活.md', '# 复活\n\n正文。\n');
  await scanVaultPages();
  const row = rowByPath('Wiki/概念/复活.md');
  db.prepare(`UPDATE pages SET deleted = 1 WHERE id = ?`).run(row.id);

  const res = await scanVaultPages();
  assert.equal(res.changed, 1, 'deleted 行即使指纹命中也不能跳过');
  assert.equal(rowByPath('Wiki/概念/复活.md').deleted, 0);
});

test('老库升级（file_mtime_ms 为 NULL）：首次全量一次，写完指纹后恢复增量', async () => {
  writeRaw('Wiki/概念/老库一.md', '# 老库一\n\n正文。\n');
  writeRaw('Wiki/概念/老库二.md', '# 老库二\n\n正文。\n');
  await scanVaultPages();

  // 模拟升级前的存量库：列已加上但还没有指纹基线
  db.prepare(`UPDATE pages SET file_mtime_ms = NULL, file_size = NULL`).run();
  const upgrade = await scanVaultPages();
  assert.deepEqual(upgrade, { pages: 2, skipped: 0, changed: 2 });
  const missing = db
    .prepare(`SELECT count(*) n FROM pages WHERE file_mtime_ms IS NULL OR file_size IS NULL`)
    .get() as { n: number };
  assert.equal(missing.n, 0, '一次扫描内必须写回全部指纹（不能自己扫完还判为变更）');
  assert.deepEqual(await scanVaultPages(), { pages: 2, skipped: 2, changed: 0 });
});

test('带外改 frontmatter id：扫描走原迁移逻辑并更新指纹', async () => {
  writePage('Wiki/概念/改id.md', '# 改id\n\n正文。\n');
  const oldId = rowByPath('Wiki/概念/改id.md').id;
  const abs = safeJoin('Wiki/概念/改id.md');
  const parsed = matter(fs.readFileSync(abs, 'utf8'));
  parsed.data.id = 'vault-scan-new-id';
  fs.writeFileSync(abs, matter.stringify(parsed.content, parsed.data), 'utf8');

  const res = await scanVaultPages();
  assert.equal(res.changed, 1);
  assert.equal(rowByPath('Wiki/概念/改id.md').id, 'vault-scan-new-id');
  assert.equal(db.prepare(`SELECT count(*) n FROM pages WHERE id = ?`).get(oldId).n, 0, '旧 id 行应已迁走');
  assert.equal(ftsRows('vault-scan-new-id').length, 1);
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });
});

/* ---------------- 删除对账与 App 自身写入 ---------------- */

test('文件删除后 reconcile 照常标删，其余页面仍走跳过', async () => {
  const goneAbs = writeRaw('Wiki/概念/待删.md', '# 待删\n\n正文。\n');
  writeRaw('Wiki/概念/保留.md', '# 保留\n\n正文。\n');
  await scanVaultPages();

  fs.rmSync(goneAbs);
  const res = await scanVaultPages();
  assert.equal(res.pages, 1, '只剩磁盘上还存在的一页');
  assert.equal(res.skipped, 1);
  assert.equal(rowByPath('Wiki/概念/待删.md').deleted, 1, '缺失文件仍应标删');
  assert.equal(rowByPath('Wiki/概念/保留.md').deleted, 0);
});

test('App 自身写入（writePage / movePage）会写回指纹，下次启动扫描直接跳过', async () => {
  writePage('Wiki/概念/自写.md', '# 自写\n\n正文。\n');
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });

  movePage('Wiki/概念/自写.md', 'Wiki/概念/自写改.md');
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });
  assert.ok(rowByPath('Wiki/概念/自写改.md'));
  assert.equal(rowByPath('Wiki/概念/自写.md'), undefined);
});

/* ---------------- 两阶段拆分与兼容入口 ---------------- */

test('scanVaultDeferred 幂等（listen 后与 startVaultWatch 并发路径）', async () => {
  writeRaw('Wiki/概念/页面.md', '# 页面\n\n正文。\n');
  await scanVaultPages();
  await scanVaultDeferred();
  await scanVaultDeferred();
  assert.deepEqual(await scanVaultPages(), { pages: 1, skipped: 1, changed: 0 });
});

test('scanVault() 保持旧语义：两阶段串行、可重复执行', async () => {
  writeRaw('Wiki/概念/兼容.md', '# 兼容\n\n正文。\n');
  await scanVault();
  const row = rowByPath('Wiki/概念/兼容.md');
  assert.ok(row && row.deleted === 0);
  assert.equal(typeof row.file_mtime_ms, 'number');

  await scanVault();
  assert.equal(db.prepare(`SELECT count(*) n FROM pages WHERE deleted = 0`).get().n, 1, '重复扫描不应产生重复行');
});

test('migrate() 幂等：指纹列存在且重复执行不报错、不重复加列', () => {
  const columns = () => (db.prepare(`PRAGMA table_info(pages)`).all() as any[]).map((column) => column.name);
  assert.ok(columns().includes('file_mtime_ms'));
  assert.ok(columns().includes('file_size'));
  assert.doesNotThrow(() => migrate());
  assert.doesNotThrow(() => migrate());
  assert.equal(columns().filter((name) => name === 'file_mtime_ms').length, 1);
});
