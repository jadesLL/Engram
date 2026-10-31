import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * v1.5.1：「自动整理（梦境思考）」配置对手机开放。
 *
 * 梦境思考跑在中枢上，手机绑定中枢后在 设置 → Agent 与自动化 里改的必须是中枢那一份配置。
 * 原实现给这四条路又叠了 owner 的 requireAuth（成员令牌 401），这里锁住新的门禁口径：
 * 成员令牌可看/改/停，未知令牌 401，owner 登录态不变。
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dream-access-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
const memberToken = 'lsync_dream_config_fixture';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android 梦境验收', memberToken);
  const { assistantRoutes } = await import('./assistant.js');
  app = Fastify();
  await app.register(jwt, { secret: 'dream-access-route-test-secret' });
  await app.register(assistantRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('同步成员令牌可读取、修改并停止梦境思考配置（手机端远程配置）', async () => {
  const headers = { authorization: `Bearer ${memberToken}` };
  const status = await app.inject({ method: 'GET', url: '/api/assistant/dream', headers });
  assert.equal(status.statusCode, 200, '手机成员令牌读不到梦境思考状态：设置页「自动整理」会整块报错');
  assert.ok(status.json().config, '状态里缺 config');

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/assistant/dream',
    headers,
    payload: { enabled: true, frequency: 'daily', time: '03:00' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().ok, true);
  assert.equal(saved.json().config.enabled, true);
  assert.equal(saved.json().config.time, '03:00');

  const stopped = await app.inject({ method: 'POST', url: '/api/assistant/dream/stop', headers });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().ok, true);
});

test('未知令牌 401；owner 登录态仍可访问', async () => {
  const denied = await app.inject({ method: 'GET', url: '/api/assistant/dream', headers: { authorization: 'Bearer nope' } });
  assert.equal(denied.statusCode, 401);
  const owner = await app.inject({
    method: 'GET',
    url: '/api/assistant/dream',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(owner.statusCode, 200);
});
