import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-events-'));
process.env.DATA_DIR = temp;
let app: ReturnType<typeof Fastify>, base: string;
let hub: typeof import('../sync/hub.js');
const memberToken = `lsync_${'b'.repeat(48)}`;
before(async () => {
  const mod = await import('../lib/db.js'); mod.migrate();
  (await import('../config.js')).ensureDirs();
  hub = await import('../sync/hub.js');
  (await import('../sync/store.js')).createPeer('重连验收成员', memberToken);
  app = Fastify();
  await app.register(jwt, { secret: 'sync-events-route-fixture' });
  await app.register((await import('./sync.js')).syncRoutes);
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(async () => {
  await app.close();
  (await import('../lib/db.js')).db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});

test('订阅接续补拉游标：空档内的页面和随后的实时页面均按顺序到达', async () => {
  const headers = { authorization: `Bearer ${memberToken}` };
  const changes = await (await fetch(`${base}/api/sync/changes?since=0`, { headers })).json() as { ops: Array<{seq:number}> };
  const since = changes.ops.at(-1)?.seq || 0;
  // 明确让这条提交发生在补拉已经结束、订阅尚未建立的空档中。
  const first = await hub.applyPush({ node_id: 'hub', kind: 'page', target: 'Wiki/概念/交接空档.md', content: '订阅建立前的内容', base_revision: 0 }, 'hub');
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 3000);
  const response = await fetch(`${base}/api/sync/events?node_id=fixture&since=${since}`, { headers, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  async function nextOp() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const part = await reader.read();
        assert.equal(part.done, false, '事件流不应提前结束');
        buffer += decoder.decode(part.value, { stream: true });
      }
    }
  }
  try {
    const replay = await nextOp();
    assert.equal(replay.seq, first.seq);
    assert.match(replay.content, /订阅建立前的内容$/m);
    const second = await hub.applyPush({ node_id: 'hub', kind: 'page', target: 'Wiki/概念/交接空档.md', content: '订阅建立后的内容', base_revision: first.revision }, 'hub');
    const live = await nextOp();
    assert.equal(live.seq, second.seq);
    assert.match(live.content, /订阅建立后的内容$/m);
  } finally {
    clearTimeout(timeout); abort.abort(); await reader.cancel().catch(() => {});
  }
});

test('无效游标在建立 SSE 前拒绝', async () => {
  const res = await fetch(`${base}/api/sync/events?since=-1`, { headers: { authorization: `Bearer ${memberToken}` } });
  try { assert.equal(res.status, 400); }
  finally { await res.body?.cancel(); }
});
