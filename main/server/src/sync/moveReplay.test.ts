import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 回归：move 重放撞名不得留下「幽灵页」（行还在、文件没了）。
 *
 * 新成员首次接入的顺序是「先全量对账拉当前状态 → 再从游标 0 重放整个 oplog」，
 * 历史 move（A → B）重放时 B 早已由对账落位。旧实现直接 renameSync(A → B)：
 *  1) 覆盖掉 B 的当前正文（历史版本顶替最新内容）；
 *  2) 紧接着 `UPDATE pages SET path = B WHERE path = A` 撞 pages.path 唯一约束抛错，
 *     错误被 sync 层 move 分支的 catch 吞掉 → A 留下 deleted = 0 却无文件的幽灵行：
 *     侧栏列出、点开报「文件不存在」，只有重启（scanVault → reconcileMissingPages）才清掉。
 *
 * 现在 movePage 在目标被占用（文件或 pages 行）时直接拒绝，由调用方决定旧路径的去向。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-move-'));
process.env.DATA_DIR = temp;

let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
});

after(async () => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

test('重放历史 move：目标已占用时不得覆盖目标正文，也不得留下幽灵行', async () => {
  const { createPage, writePage, readPage, movePage, safeJoin } = await import('../lib/vault.js');

  const source = createPage('Wiki/概念', '重放源页');
  writePage(source.path, '# 重放源页\n\n旧路径的历史正文', {});
  const dest = createPage('Wiki/概念', '重放目标页');
  writePage(dest.path, '# 重放目标页\n\n新路径的当前正文', {});

  // 模拟成员端重放历史 move：源 → 目标（目标已由全量对账落位）
  assert.throws(
    () => movePage(source.path, dest.path, 'sync'),
    /已被占用|已存在/,
    '目标路径已占用时必须拒绝搬移，而不是覆盖目标后撞唯一约束'
  );

  // 目标页正文必须仍是当前版本
  assert.match(readPage(dest.path)?.content || '', /新路径的当前正文/);
  // 源文件不得被搬走/覆盖（拒绝发生在任何文件系统改动之前）
  assert.match(readPage(source.path)?.content || '', /旧路径的历史正文/);
  // 目标路径的行仍指向目标文件
  const destRow = db.prepare(`SELECT id, deleted FROM pages WHERE path = ?`).get(dest.path) as { id: string; deleted: number };
  assert.equal(destRow.deleted, 0);
});

test('movePage 拒绝撞名后调用方兜底：旧路径入回收站并落删除标记，不留幽灵行', async () => {
  const { createPage, writePage, movePage, safeJoin } = await import('../lib/vault.js');
  const { moveToTrash } = await import('../lib/trash.js');

  const source = createPage('Wiki/概念', '兜底源页');
  writePage(source.path, '# 兜底源页\n\n历史残留正文', {});
  const dest = createPage('Wiki/概念', '兜底目标页');
  writePage(dest.path, '# 兜底目标页\n\n当前正文', {});

  // sync 层（client/hub）对撞名的处理：目标已就位 → 旧路径是残留，直接入回收站
  let rejected = false;
  try {
    movePage(source.path, dest.path, 'sync');
  } catch {
    rejected = true;
    moveToTrash(source.path, 'sync');
  }
  assert.equal(rejected, true);
  assert.equal(fs.existsSync(safeJoin(source.path)), false, '旧路径文件应已入回收站');
  const ghost = db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE path = ? AND deleted = 0`).get(source.path) as { n: number };
  assert.equal(ghost.n, 0, '旧路径不得留下 deleted = 0 的空壳行');
});

test('目标行存在但文件缺失（软删行占位）同样拒绝，调用方兜底后不留幽灵行', async () => {
  const { createPage, writePage, movePage, safeJoin } = await import('../lib/vault.js');
  const { moveToTrash } = await import('../lib/trash.js');

  const source = createPage('Wiki/概念', '软删占位源');
  writePage(source.path, '# 软删占位源\n\n正文', {});
  const dest = createPage('Wiki/概念', '软删占位目标');
  writePage(dest.path, '# 软删占位目标\n\n正文', {});
  // 模拟目标路径只剩软删行（文件已入回收站）：pages.path 唯一约束同样占位
  fs.rmSync(safeJoin(dest.path));
  db.prepare(`UPDATE pages SET deleted = 1 WHERE path = ?`).run(dest.path);

  assert.throws(() => movePage(source.path, dest.path, 'sync'), /已被占用|已存在/);
  // 拒绝发生在任何文件系统改动之前：源页此刻仍完好（不是幽灵页）
  assert.equal(fs.existsSync(safeJoin(source.path)), true, '拒绝搬移不得动源文件');

  // sync 层兜底：旧路径入回收站，行落删除标记
  moveToTrash(source.path, 'sync');
  const ghost = db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE path = ? AND deleted = 0`).get(source.path) as { n: number };
  assert.equal(ghost.n, 0, '源路径不得留下幽灵行');
  // 目标的软删行不得被复活
  const destRow = db.prepare(`SELECT deleted FROM pages WHERE path = ?`).get(dest.path) as { deleted: number };
  assert.equal(destRow.deleted, 1, '目标软删行不得被复活');
});
