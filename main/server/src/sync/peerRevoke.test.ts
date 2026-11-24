import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-peer-revoke-'));
process.env.DATA_DIR = temp;

let db: any;
let hub: typeof import('./hub.js');

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  hub = await import('./hub.js');
});

after(() => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('撤权/重置令牌立即移除该成员的 SSE 订阅：后续广播不再发给它', () => {
  let sentP1 = 0;
  let sentP2 = 0;
  let closedP1 = 0;
  hub.addNodeSubscriber({ peerId: 'p1', send: () => { sentP1++; }, close: () => { closedP1++; } });
  hub.addNodeSubscriber({ peerId: 'p2', send: () => { sentP2++; } });

  hub.notifyCategoriesChanged();
  assert.equal(sentP1, 1);
  assert.equal(sentP2, 1);

  hub.removeNodeSubscribers('p1');
  assert.equal(closedP1, 1, '被移除成员的连接要被主动关闭');
  hub.notifyCategoriesChanged();
  assert.equal(sentP1, 1, '移除后不应再收到广播');
  assert.equal(sentP2, 2, '其他成员不受影响');
  assert.ok(!hub.connectedPeerIds().has('p1'));
});
