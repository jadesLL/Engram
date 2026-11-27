import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pending-ops-'));
process.env.DATA_DIR = temp;

let pending: typeof import('./pendingOps.js');
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  pending = await import('./pendingOps.js');
});

after(() => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('page/file 按 kind+target 去重：反复保存只留一行', () => {
  const a = pending.persistPendingOp('page', 'Wiki/同一页.md');
  const b = pending.persistPendingOp('page', 'Wiki/同一页.md');
  assert.equal(a, b);
  assert.equal(pending.loadPendingOps().length, 1);

  pending.persistPendingOp('file', '原始资料/a.txt');
  assert.equal(pending.loadPendingOps().length, 2);
});

test('move/delete 保序且不去重：对账靠它们跳过中枢旧路径', () => {
  const move1 = pending.persistPendingOp('move', 'Wiki/新名.md', 'Wiki/旧名.md');
  const move2 = pending.persistPendingOp('move', 'Wiki/再改名.md', 'Wiki/新名.md');
  const del = pending.persistPendingOp('delete', 'Wiki/要删.md', '', true, '2026-01-01T00:00:00.000Z');
  assert.ok(move1 && move2 && del);
  assert.notEqual(move1, move2);

  const guards = pending.pendingPathGuards();
  assert.ok(guards.moveOldPaths.has('Wiki/旧名.md'));
  assert.ok(guards.moveOldPaths.has('Wiki/新名.md'));
  assert.ok(guards.deleteTargets.has('Wiki/要删.md'));

  pending.removePendingOp(move1);
  assert.ok(!pending.loadPendingOps().some((op) => op.id === move1));
});

test('卸载/换中枢可以整体清空', () => {
  pending.persistPendingOp('delete', 'Wiki/另一页.md');
  assert.ok(pending.loadPendingOps().length > 0);
  pending.clearPendingOps();
  assert.equal(pending.loadPendingOps().length, 0);
});
