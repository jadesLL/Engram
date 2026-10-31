import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * v1.5.1：作业指南 /api/guide 从 owner-only 放宽到 owner + 同步成员令牌。
 * 手机（绑定中枢后）设置页「工具与手册」要经窄代理读这份只读指南；它不含任何配置或密钥。
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-guide-access-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
const memberToken = 'lsync_guide_fixture';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android 指南验收', memberToken);
  const { guideRoutes } = await import('./guide.js');
  app = Fastify();
  await app.register(jwt, { secret: 'guide-access-route-test-secret' });
  await app.register(guideRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('同步成员令牌可读作业指南（手机工具与手册）', async () => {
  const member = await app.inject({
    method: 'GET',
    url: '/api/guide',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(member.statusCode, 200, '手机成员令牌读不到 /api/guide：工具与手册会整块报错');
  assert.equal(typeof member.json().guide, 'string');
  assert.ok(member.json().guide.length > 0);

  const owner = await app.inject({
    method: 'GET',
    url: '/api/guide',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(owner.statusCode, 200);

  const denied = await app.inject({ method: 'GET', url: '/api/guide', headers: { authorization: 'Bearer nope' } });
  assert.equal(denied.statusCode, 401);
});
