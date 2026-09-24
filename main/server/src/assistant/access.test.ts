import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-assistant-access-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
const memberToken = 'lsync_mobile_agent_test';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android', memberToken);
  const { requireAssistantAccess } = await import('./access.js');
  const { requireAuth } = await import('../routes/auth.js');

  app = Fastify();
  await app.register(jwt, { secret: 'assistant-access-test' });
  app.addHook('preHandler', requireAssistantAccess);
  app.get('/member', async () => ({ ok: true }));
  app.get('/owner', { preHandler: requireAuth }, async () => ({ ok: true }));
  await app.ready();
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('同步成员 token 可以进入 Agent 交互面', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/member',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(response.statusCode, 200);
});

test('同步成员 token 不能进入叠加 owner 鉴权的配置面', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/owner',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(response.statusCode, 401);
});

test('未知 token 被拒绝', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/member',
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(response.statusCode, 401);
});
