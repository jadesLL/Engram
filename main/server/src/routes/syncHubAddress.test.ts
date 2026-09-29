import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * 中枢「成员绑定地址」接口回归。
 *
 * 真机场景：用户在 Windows 桌面版里把本机设为同步中枢，设置页原来把浏览器 `location.origin`
 * 当绑定地址显示与复制——桌面版的内嵌服务只监听 127.0.0.1，于是中枢给出去的地址就是
 * http://127.0.0.1:18180，手机照着填永远连不上。
 *
 * 这里把配置钉在「桌面版默认」那一档：HOST=127.0.0.1、PORT=18180、请求来自 127.0.0.1 页面，
 * 断言接口一条可用地址都不给、并如实记录被剔除的回环地址（界面据此解释与引导）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-hub-address-'));
process.env.DATA_DIR = temp;
process.env.HOST = '127.0.0.1';
process.env.PORT = '18180';
delete process.env.LAN_ACCESS_URL;
delete process.env.LAN_PORT;
delete process.env.DIRECT_ACCESS_URL;

let app: ReturnType<typeof Fastify>;
let ownerToken = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  dbModule.migrate();
  const { syncRoutes } = await import('./sync.js');
  app = Fastify();
  await app.register(jwt, { secret: 'sync-hub-address-route-test-secret' });
  await app.register(syncRoutes);
  await app.ready();
  ownerToken = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  const dbModule = await import('../lib/db.js');
  try { dbModule.db.close(); } catch { /* 已关闭 */ }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});

test('未认证：401（地址清单等于本机网络拓扑，不给访客看）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sync/hub-addresses' });
  assert.equal(res.statusCode, 401);
});

test('桌面版默认（只监听 127.0.0.1）：不给出任何成员地址，回环地址进 skippedLoopback', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/sync/hub-addresses?origin=http%3A%2F%2F127.0.0.1%3A18180',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ok: boolean;
    bindHost: string;
    bindScope: string;
    addresses: { url: string }[];
    skippedLoopback: string[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.bindHost, '127.0.0.1');
  assert.equal(body.bindScope, 'loopback');
  assert.deepEqual(body.addresses, [], '只监听回环时不能给出任何成员地址');
  assert.deepEqual(body.skippedLoopback, ['http://127.0.0.1:18180'], '要说清 127.0.0.1 为什么不再出现');
  assert.ok(!JSON.stringify(body.addresses).includes('127.0.0.1'));
});
