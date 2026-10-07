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
