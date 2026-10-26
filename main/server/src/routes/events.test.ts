import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * GET /api/events/state：前端兜底对账探针（见 web 的 lib/freshness）。
 *  - 需要鉴权（与 /api/events 同一道 requireAuth）；
 *  - 返回内容版本号，内容事件后递增。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-events-routes-'));
process.env.DATA_DIR = temp;

let app: FastifyInstance;
let db: any;
let token = '';

before(async () => {
  // requireAuth 会查 mcp_tokens 表：先把库建起来，否则带 Bearer 的请求直接 500
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { eventRoutes } = await import('./events.js');
  const { emit } = await import('../lib/events.js');
  app = Fastify();
  await app.register(jwt, { secret: 'events-route-test-secret' });
  await app.register(eventRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
  emit('file-changed', { path: '原始资料/文档/探针.txt' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

test('/api/events/state 返回内容版本号', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/events/state', headers: { authorization: 'Bearer ' + token } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(typeof body.revision, 'number');
  assert.ok(body.revision >= 1, '有内容事件后版本号应 ≥ 1');
  assert.deepEqual(Object.keys(body).sort(), ['revision'], '只回版本号：这是每几秒一次的高频探针');
});

test('/api/events/state 同样要鉴权', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/events/state' });
  assert.equal(res.statusCode, 401);
});
