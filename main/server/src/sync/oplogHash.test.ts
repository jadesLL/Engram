import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * oplog 的 file hash 回归（S1）。
 *
 * 成员端重连补拉（/api/sync/changes、SSE since）拿到的 file op 必须带内容 hash：
 * 成员按 hash 判断要不要拉文件。旧实现在 sync_oplog 里不存 hash，回放出来的 file op
 * 没有 hash 会被成员端静默跳过——离线期间中枢更新的文件永远不落地（用户报
 * 「有的客户端不同步」的直接原因之一）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-oplog-hash-'));
process.env.DATA_DIR = temp;

let appendOplog: (kind: any, target: string, revision: number, nodeId: string, oldPath?: string, hash?: string) => number;
let getOpsSince: (since: number, limit?: number) => any[];
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ appendOplog, getOpsSince } = await import('./store.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 系统清理 */ }
});

test('sync_oplog 有 hash 列（新库建表 + 旧库 ensureColumn 两条路径都覆盖）', () => {
  const columns = db.prepare('PRAGMA table_info(sync_oplog)').all() as { name: string }[];
  assert.ok(columns.some((c) => c.name === 'hash'), 'sync_oplog 必须有 hash 列，否则 file op 回放拿不到内容 hash');
});

test('appendOplog(file) 写入 hash，getOpsSince 回读得到同一份 hash', () => {
  const hash = 'a'.repeat(64);
  const seq = appendOplog('file', '原始资料/回放哈希.bin', 1, 'node-a', '', hash);
  const op = getOpsSince(seq - 1, 10).find((item) => item.seq === seq);
  assert.ok(op, '应能按 seq 读回刚写入的 op');
  assert.equal(op.kind, 'file');
  assert.equal(op.hash, hash, 'file op 回读必须带 hash（成员端据此决定是否拉文件）');
});

test('非 file 的 op hash 为空串（旧行/其它 kind 兼容）', () => {
  const seq = appendOplog('page', 'Wiki/概念/哈希测试.md', 2, 'node-a');
  const op = getOpsSince(seq - 1, 10).find((item) => item.seq === seq);
  assert.ok(op);
  assert.equal(op.hash, '', 'page/delete/move 等 op 不需要 hash，应保持空串而不是 undefined');
});
