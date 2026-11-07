import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * 内置 Agent 权限模式（owner 配置面）：
 *  - 未登录 / 同步成员令牌一律 401（权限是中枢级配置，手机端不改）；
 *  - owner 保存合法值后 GET /api/assistant/status 立即回显；
 *  - 非法值 400，且不改变已经保存的模式。
 *
 * 这里不启动 dsh：控制台未运行时保存权限只落配置，不会拉起子进程；聊天运行时按配置指纹在下一轮自然重开。
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-assistant-permission-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
/** 手机（Android 本地服务）只持同步成员令牌：可以聊会话，但不能改内置 Agent 权限 */
const memberToken = 'lsync_assistant_permission_fixture';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android 权限验收', memberToken);
  const { assistantRoutes } = await import('./assistant.js');
  app = Fastify();
  await app.register(jwt, { secret: 'assistant-permission-route-test-secret' });
  await app.register(assistantRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function authHeaders() {
  return { authorization: `Bearer ${token}` };
}

test('权限接口未登录 / 成员令牌一律 401', async () => {
  const anonymous = await app.inject({
    method: 'PUT',
    url: '/api/assistant/permission',
    payload: { mode: 'read-only' },
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error, '未授权');

  const member = await app.inject({
    method: 'PUT',
    url: '/api/assistant/permission',
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { mode: 'read-only' },
  });
  assert.equal(member.statusCode, 401, '同步成员令牌不该能改中枢的内置 Agent 权限');
});

test('默认权限是「完全访问」，状态接口同时给出选项', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: authHeaders() });
  assert.equal(res.statusCode, 200);
  const permission = res.json().permission;
  assert.ok(permission, '状态接口缺 permission 字段：设置页拿不到当前权限与选项');
  assert.equal(permission.mode, 'danger-full-access');
  assert.deepEqual(
    permission.options.map((option: any) => option.value),
    ['danger-full-access', 'workspace-write', 'read-only'],
  );
});

test('owner 保存合法模式后状态立即回显，控制台未被拉起', async () => {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/assistant/permission',
    headers: authHeaders(),
    payload: { mode: 'workspace-write' },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json();
  assert.equal(body.ok, true);
  assert.equal(body.permission.mode, 'workspace-write');
  assert.equal(body.console.running, false, '控制台本来没在跑，改权限不该把它拉起来');

  const status = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: authHeaders() });
  assert.equal(status.json().permission.mode, 'workspace-write');
});

test('非法模式 400，且不改变已保存的模式', async () => {
  const bad = await app.inject({
    method: 'PUT',
    url: '/api/assistant/permission',
    headers: authHeaders(),
    payload: { mode: 'everything' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, '不支持的权限模式');

  const status = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: authHeaders() });
  assert.equal(status.json().permission.mode, 'workspace-write');
});

test('切回完全访问：默认值也能显式保存', async () => {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/assistant/permission',
    headers: authHeaders(),
    payload: { mode: 'danger-full-access' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().permission.mode, 'danger-full-access');
});