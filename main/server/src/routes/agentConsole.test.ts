import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-console-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
/** 手机（Android 本地服务）只持同步成员令牌；v1.5.1 起它也能进控制台配置面 */
const memberToken = 'lsync_agent_console_fixture';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android 控制台验收', memberToken);
  const { agentConsoleRoutes } = await import('./agentConsole.js');
  app = Fastify();
  await app.register(jwt, { secret: 'agent-console-route-test-secret' });
  await app.register(agentConsoleRoutes);
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

test('控制台配置面未登录一律 401', async () => {
  for (const [method, url] of [
    ['GET', '/api/agent-console/models'],
    ['GET', '/api/agent-console/plugins'],
    ['GET', '/api/agent-console/presets'],
    ['GET', '/api/agent-console/advanced'],
    ['GET', '/api/agent-console/settings/subagent'],
    ['PUT', '/api/agent-console/models/default'],
    ['PATCH', '/api/agent-console/plugins/toggle'],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url} 应要求登录`);
    assert.equal(res.json().error, '未授权');
  }
});

test('停止控制台（幂等）返回未运行状态', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/agent-console/stop', headers: authHeaders() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.running, false);
  assert.equal(body.upstreamReady, false);
});

test('Host 头非法时 status 返回可读错误而不是抛 500', { skip: process.platform === 'win32' ? 'Fastify inject 会拒绝非法 Host 头，Windows 下跳过' : false }, async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/agent-console/status',
    headers: { ...authHeaders(), host: 'bad/host' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().running, false);
  assert.match(res.json().error, /无法识别访问地址/);
});

test('同步成员令牌可进入控制台配置面（手机远程配置，v1.5.1）', async () => {
  // 用幂等的 /stop 验证门禁顺序：过了鉴权才会返回 200，不会真的拉起 dsh。
  const member = await app.inject({
    method: 'POST',
    url: '/api/agent-console/stop',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(member.statusCode, 200, '手机成员令牌被控制台配置面拒绝：手机端「内置 Agent 控制台」会全 401');
  assert.equal(member.json().running, false);

  const denied = await app.inject({
    method: 'POST',
    url: '/api/agent-console/stop',
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(denied.statusCode, 401);
});
