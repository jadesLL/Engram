import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * compact 回放的页面 op 必须带「当前正文 hash」：
 * 成员端（尤其手机补积压）据此跳过本地已一致的内容，不再逐条拉已经同步过的页面。
 * hash 必须和 /api/sync/page-content 给的正文完全对得上，否则成员会误判成「已同步」而漏掉内容。
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-compact-hash-'));
process.env.DATA_DIR = temp;
let app: ReturnType<typeof Fastify>, base: string;
let hub: typeof import('../sync/hub.js');
let brainDir = '';
const memberToken = `lsync_${'c'.repeat(48)}`;
before(async () => {
  const dbModule = await import('../lib/db.js');
  dbModule.migrate();
  const config = await import('../config.js');
  config.ensureDirs();
  brainDir = config.BRAIN_DIR;
  hub = await import('../sync/hub.js');
  (await import('../sync/store.js')).createPeer('紧凑回放验收成员', memberToken);
  app = Fastify();
  await app.register(jwt, { secret: 'sync-compact-hash-fixture' });
  await app.register((await import('./sync.js')).syncRoutes);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => {
  await app.close();
  (await import('../lib/db.js')).db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});

test('compact 页面 op 带当前正文 hash，且与 page-content 一致', async () => {
  const headers = { authorization: `Bearer ${memberToken}` };
  const target = 'Wiki/概念/紧凑回放哈希.md';
  const pushed = await hub.applyPush(
    { node_id: 'hub', kind: 'page', target, content: '第一版正文\n第二行', base_revision: 0 },
    'hub'
  );
  const changes = (await (
    await fetch(`${base}/api/sync/changes?since=${pushed.seq - 1}&limit=10&compact=1`, { headers })
  ).json()) as { ops: Array<{ seq: number; kind: string; target: string; hash?: string; content?: string }> };
  const op = changes.ops.find(item => item.seq === pushed.seq);
  assert.ok(op, '应能取回刚推送的页面 op');
  assert.equal(op!.kind, 'page');
  assert.equal(typeof op!.hash, 'string');
  assert.match(op!.hash!, /^[0-9a-f]{64}$/);
  assert.equal(op!.content, undefined, 'compact 回放不应内嵌正文');

  const contentResponse = (await (
    await fetch(`${base}/api/sync/page-content?path=${encodeURIComponent(target)}`, { headers })
  ).json()) as { content: string };
  const expected = crypto.createHash('sha256').update(Buffer.from(contentResponse.content, 'utf8')).digest('hex');
  assert.equal(op!.hash, expected, 'op.hash 必须等于页面正文的 sha256');
});

test('中枢已不存在的旧页面 op 仍标 missing 且不带 hash', async () => {
  const headers = { authorization: `Bearer ${memberToken}` };
  const target = 'Wiki/概念/已被移走.md';
  const pushed = await hub.applyPush(
    { node_id: 'hub', kind: 'page', target, content: '会被移走的正文', base_revision: 0 },
    'hub'
  );
  fs.rmSync(path.join(brainDir, target), { force: true });
  const changes = (await (
    await fetch(`${base}/api/sync/changes?since=${pushed.seq - 1}&limit=10&compact=1`, { headers })
  ).json()) as { ops: Array<{ seq: number; missing?: boolean; hash?: string }> };
  const op = changes.ops.find(item => item.seq === pushed.seq);
  assert.ok(op, '旧 op 仍应在回放清单里');
  assert.equal(op!.missing, true);
  assert.equal(op!.hash, '');
});
