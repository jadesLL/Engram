import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * 设置 → 外设接入 →「飞书多维表格」的接口边界：
 *  - owner 登录态可用；同步成员令牌 / 无令牌一律 401（凭据是 owner 级，不下发手机）；
 *  - GET status 只回 App ID 与 hasSecret，绝不回 Secret；
 *  - 保存凭据会测连通性（本测试用 stub fetch），失败时仍保存并带回原因；
 *  - 数据源参数校验与 404 语义。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-feishu-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let ownerToken = '';
const memberToken = 'lsync_feishu_route_fixture';
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  // 凭据测试与飞书接口都走 fetch：本文件只验证接口语义，统一用桩，避免联网
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('tenant_access_token')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-route', expire: 7200 });
    }
    return jsonResponse({ code: 999404, msg: `unexpected ${url}` });
  }) as typeof fetch;

  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android 飞书路由验收', memberToken);
  const { feishuRoutes } = await import('./feishu.js');
  app = Fastify();
  await app.register(jwt, { secret: 'feishu-route-test-secret' });
  await app.register(feishuRoutes);
  await app.ready();
  ownerToken = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function ownerHeaders() {
  return { authorization: 'Bearer ' + ownerToken };
}

test('鉴权：无令牌与同步成员令牌都 401（凭据不下发手机）', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/feishu/status' });
  assert.equal(anonymous.statusCode, 401);
  const member = await app.inject({
    method: 'GET',
    url: '/api/feishu/status',
    headers: { authorization: 'Bearer ' + memberToken },
  });
  assert.equal(member.statusCode, 401);
});

test('status：空配置返回 null 源与 configured=false', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/feishu/status', headers: ownerHeaders() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.settings.configured, false);
  assert.equal(body.settings.hasSecret, false);
  assert.deepEqual(body.settings.sources, []);
  assert.deepEqual(body.live, {});
});

test('保存凭据：缺 App ID 拒绝；首次缺 Secret 拒绝；成功后不回显 Secret', async () => {
  const noId = await app.inject({
    method: 'PUT',
    url: '/api/feishu/credentials',
    headers: ownerHeaders(),
    payload: { appId: '', appSecret: 's' },
  });
  assert.equal(noId.statusCode, 400);

  const noSecret = await app.inject({
    method: 'PUT',
    url: '/api/feishu/credentials',
    headers: ownerHeaders(),
    payload: { appId: 'cli_route', appSecret: '' },
  });
  assert.equal(noSecret.statusCode, 400);

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/feishu/credentials',
    headers: ownerHeaders(),
    payload: { appId: 'cli_route', appSecret: 'top-secret' },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json();
  assert.equal(body.test.ok, true);
  assert.equal(body.settings.configured, true);
  assert.equal(body.settings.appId, 'cli_route');
  assert.equal(body.settings.hasSecret, true);
  assert.equal(JSON.stringify(body).includes('top-secret'), false, '响应里不能出现 Secret');

  const status = await app.inject({ method: 'GET', url: '/api/feishu/status', headers: ownerHeaders() });
  assert.equal(JSON.stringify(status.json()).includes('top-secret'), false);

  // 换 App ID 但 Secret 留空 → 拒绝（避免把旧 Secret 套到新应用上）
  const changedId = await app.inject({
    method: 'PUT',
    url: '/api/feishu/credentials',
    headers: ownerHeaders(),
    payload: { appId: 'cli_other', appSecret: '' },
  });
  assert.equal(changedId.statusCode, 400);
});

test('数据源参数校验：坏链接 / 不支持的间隔 / 不存在的数据源', async () => {
  const badUrl = await app.inject({
    method: 'POST',
    url: '/api/feishu/sources',
    headers: ownerHeaders(),
    payload: { url: 'https://example.com/base/bascnABC12345' },
  });
  assert.equal(badUrl.statusCode, 400);
  assert.match(badUrl.json().error, /feishu\.cn|larksuite\.com/);

  const noTable = await app.inject({
    method: 'POST',
    url: '/api/feishu/sources',
    headers: ownerHeaders(),
    payload: { url: 'https://abc.feishu.cn/base/bascnABC12345' },
  });
  assert.equal(noTable.statusCode, 400);
  assert.match(noTable.json().error, /数据表/);

  const badInterval = await app.inject({
    method: 'PATCH',
    url: '/api/feishu/sources/missing',
    headers: ownerHeaders(),
    payload: { intervalMinutes: 5 },
  });
  assert.equal(badInterval.statusCode, 400);

  const missing = await app.inject({
    method: 'PATCH',
    url: '/api/feishu/sources/missing',
    headers: ownerHeaders(),
    payload: { autoSync: true },
  });
  assert.equal(missing.statusCode, 404);

  const syncMissing = await app.inject({
    method: 'POST',
    url: '/api/feishu/sources/missing/sync',
    headers: ownerHeaders(),
  });
  assert.equal(syncMissing.statusCode, 404);
});

test('飞书授权：status 给回调地址，start 生成授权链接，坏 state 安全回设置页', async () => {
  const status = await app.inject({ method: 'GET', url: '/api/feishu/status', headers: ownerHeaders() });
  const body = status.json();
  assert.match(body.redirectUri, /\/api\/feishu\/oauth\/callback$/);
  assert.match(body.scopes, /offline_access/);
  assert.equal(JSON.stringify(body).includes('accessToken'), false);
  assert.equal(JSON.stringify(body).includes('refreshToken'), false);

  const start = await app.inject({
    method: 'GET',
    url: '/api/feishu/oauth/start',
    headers: ownerHeaders(),
  });
  assert.equal(start.statusCode, 200);
  const started = start.json();
  assert.match(started.url, /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?/);
  assert.match(started.url, /client_id=cli_route/);
  assert.match(started.url, /redirect_uri=/);
  assert.match(started.url, /scope=.*offline_access/);
  assert.match(started.url, /state=[a-f0-9]{48}/);

  const badState = await app.inject({
    method: 'GET',
    url: '/api/feishu/oauth/callback?code=abc&state=not-a-real-state',
  });
  assert.equal(badState.statusCode, 302);
  assert.match(String(badState.headers.location), /feishu=error/);
  assert.match(String(badState.headers.location), /%E6%8E%88%E6%9D%83/);

  // 桌面端：授权页在系统浏览器打开，回调必须是一张可读结果页（不能甩去登录页）
  const externalStart = await app.inject({
    method: 'GET',
    url: '/api/feishu/oauth/start?mode=external',
    headers: ownerHeaders(),
  });
  assert.equal(externalStart.statusCode, 200);
  const externalUrl = new URL(externalStart.json().url);
  const externalState = externalUrl.searchParams.get('state');
  assert.ok(externalState);
  const externalFail = await app.inject({
    method: 'GET',
    url: `/api/feishu/oauth/callback?code=abc&state=${externalState}`,
  });
  assert.equal(externalFail.statusCode, 200);
  assert.match(String(externalFail.headers['content-type']), /text\/html/);
  assert.match(externalFail.body, /飞书授权未完成/);
});

test('飞书授权：解除授权清掉绑定；未授权时搜索被拒绝', async () => {
  const { updateFeishuConfig } = await import('../lib/feishuBitableSync.js');
  updateFeishuConfig((config) => {
    config.oauth = {
      accessToken: 'u-route',
      refreshToken: 'r-route',
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      grantedAt: Date.now(),
    };
  });
  const bound = await app.inject({ method: 'GET', url: '/api/feishu/status', headers: ownerHeaders() });
  assert.equal(bound.json().settings.oauth.bound, true);
  assert.equal(JSON.stringify(bound.json()).includes('u-route'), false);

  const unbound = await app.inject({
    method: 'POST',
    url: '/api/feishu/oauth/unbind',
    headers: ownerHeaders(),
  });
  assert.equal(unbound.statusCode, 200);

  const search = await app.inject({
    method: 'POST',
    url: '/api/feishu/search',
    headers: ownerHeaders(),
    payload: { query: '台账' },
  });
  assert.equal(search.statusCode, 400);
  assert.match(search.json().error, /授权/);
});

test('清除凭据：配置与数据源一起清空', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/feishu/credentials',
    headers: ownerHeaders(),
  });
  assert.equal(res.statusCode, 200);
  const status = await app.inject({ method: 'GET', url: '/api/feishu/status', headers: ownerHeaders() });
  const body = status.json();
  assert.equal(body.settings.configured, false);
  assert.deepEqual(body.settings.sources, []);
});
