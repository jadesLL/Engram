import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-conflict-broadcast-'));
process.env.DATA_DIR = temp;
let hub: typeof import('./hub.js');
let vault: typeof import('../lib/vault.js');
let db: typeof import('../lib/db.js');
before(async () => {
  db = await import('../lib/db.js'); db.migrate();
  (await import('../config.js')).ensureDirs();
  hub = await import('./hub.js'); vault = await import('../lib/vault.js');
});
after(() => { db.db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
test('中枢生成的冲突副本也广播给发起推送的成员；正本仍用 ack 回传', async () => {
  const target = 'Wiki/概念/配对后冲突.md';
  vault.writePage(target, '结论：待定', { type: 'concept' });
  const baseline = hub.commitLocalChange('page', target);
  vault.writePage(target, '结论：方案 A', { type: 'concept' });
  hub.commitLocalChange('page', target);
  const events: any[] = [];
  const remove = hub.addNodeSubscriber({ peerId: 'source-member', send: (_event, data) => events.push(data) });
  try {
    const result = await hub.applyPush({ node_id: 'source-member', kind: 'page', target,
      base_revision: Number(baseline.revision), content: '结论：方案 B', mtime: Date.now() + 1000 }, 'source-member');
    assert.equal(result.merge, 'conflict');
    assert.ok(result.copyPath);
    assert.ok(events.some((event) => event.target === result.copyPath && event.content.includes('方案 A')));
    assert.ok(!events.some((event) => event.target === target));
  } finally { remove(); }
});

test('同一秒内连续冲突不会忙等卡住，副本文件名自动顺延序号', async () => {
  const target = 'Wiki/概念/同秒连冲.md';
  vault.writePage(target, 'v0', { type: 'concept' });
  const base = hub.commitLocalChange('page', target);
  vault.writePage(target, 'hub-1', { type: 'concept' });
  hub.commitLocalChange('page', target);

  const startedAt = Date.now();
  const r1 = await hub.applyPush({
    node_id: 'm1', kind: 'page', target, base_revision: Number(base.revision), content: 'm1-1', mtime: Date.now() + 1000,
  }, 'm1');
  vault.writePage(target, 'hub-2', { type: 'concept' });
  const b2 = hub.commitLocalChange('page', target);
  const r2 = await hub.applyPush({
    node_id: 'm2', kind: 'page', target, base_revision: Number(base.revision), content: 'm2-1', mtime: Date.now() + 2000,
  }, 'm2');
  assert.ok(Number(b2.revision) > Number(base.revision));
  assert.equal(r1.merge, 'conflict');
  assert.equal(r2.merge, 'conflict');
  assert.ok(r1.copyPath && r2.copyPath && r1.copyPath !== r2.copyPath);
  assert.ok(Date.now() - startedAt < 900, '同秒冲突不应阻塞等待下一秒');
});
