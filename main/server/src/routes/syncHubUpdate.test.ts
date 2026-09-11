import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { consumeSseStream } from '../lib/sseStream.js';

/**
 * 同步中枢远程更新转发路由测试：
 *  - 本地 app 只装 hubUpdateRoutes（真实监听，SSE 不走 inject）
 *  - fake hub 为 node:http 一性实例，校验收到的成员令牌
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-hub-update-'));
process.env.DATA_DIR = temp;

const HUB_TOKEN = `lsync_${'h'.repeat(24)}`;

let app: ReturnType<typeof Fastify>;
let db: any;
let ownerToken = '';
let hubServer: http.Server;
let hubUrl = '';
/** fake hub 收到的 Authorization 头（按路径记录，校验转发确实带上了成员令牌） */
const seenAuth: Record<string, string> = {};

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));
  dbModule.setSetting('sync_role', 'member');
  dbModule.setSetting('sync_enabled', '1');
  dbModule.setSetting('sync_hub_token', HUB_TOKEN);
  // sync_hub_url 在 fake hub 就绪后再写（路由读它拼目标地址）

  hubServer = http.createServer((req, res) => {
    const url = req.url || '';
    seenAuth[url.split('?')[0]] = String(req.headers.authorization || '');
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${HUB_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权' }));
      return;
    }
    if (url === '/api/update/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ supported: true, desktop: false, currentVersion: '9.9.9', commit: 'abc1234', imageTag: 'main', busy: false }));
      return;
    }
    if (url === '/api/update/check') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hasUpdate: true, latestVersion: '9.9.10', imageTag: 'main' }));
      return;
    }
    if (url === '/api/update/apply') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: progress\ndata: {"text":"拉取镜像…"}\n\n');
      res.write('event: done\ndata: {"message":"更新流程已移交"}\n\n');
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
  const addr = hubServer.address();
  if (!addr || typeof addr !== 'object') throw new Error('fake hub 监听失败');
  hubUrl = `http://127.0.0.1:${addr.port}`;
  dbModule.setSetting('sync_hub_url', hubUrl);

  const { hubUpdateRoutes } = await import('./syncHubUpdate.js');
  app = Fastify();
  await app.register(jwt, { secret: 'hub-update-route-test-secret' });
  await app.register(hubUpdateRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  ownerToken = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => hubServer.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});

function base(): string {
  const addr = app.server.address();
  if (!addr || typeof addr !== 'object') throw new Error('app 未监听');
  return `http://127.0.0.1:${addr.port}`;
}

test('未绑定同步（无 hub 配置）时 state 返回 400 引导', async () => {
  db.prepare(`DELETE FROM settings WHERE key = 'sync_hub_url'`).run();
  try {
    const res = await fetch(`${base()}/api/sync/hub-update/state`, { headers: { authorization: `Bearer ${ownerToken}` } });
    assert.equal(res.status, 400);
    assert.ok(String(((await res.json()) as any).error).includes('多端同步'));
  } finally {
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES('sync_hub_url', ?)`).run(hubUrl);
  }
});

test('停用同步（enabled=0，hub 地址残留）后转发入口关闭', async () => {
  db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES('sync_enabled', '0')`).run();
  try {
    const res = await fetch(`${base()}/api/sync/hub-update/state`, { headers: { authorization: `Bearer ${ownerToken}` } });
    assert.equal(res.status, 400, '解除绑定后不应再凭残留 hub_url 转发');
  } finally {
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES('sync_enabled', '1')`).run();
  }
});

test('state/check 转发到中枢并透传结果，成员令牌随请求带上', async () => {
  const res = await fetch(`${base()}/api/sync/hub-update/state`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.currentVersion, '9.9.9');
  assert.equal(data.imageTag, 'main');
  assert.equal(seenAuth['/api/update/state'], `Bearer ${HUB_TOKEN}`);

  const check = await fetch(`${base()}/api/sync/hub-update/check`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(check.status, 200);
  assert.equal(((await check.json()) as any).latestVersion, '9.9.10');
  assert.equal(seenAuth['/api/update/check'], `Bearer ${HUB_TOKEN}`);
});

test('apply 透传中枢 SSE 事件并代等恢复（recovered 附新 state）', async () => {
  const res = await fetch(`${base()}/api/sync/hub-update/apply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body, '应为 SSE 流');
  const events: Array<{ event: string; data: any }> = [];
  await consumeSseStream(res.body, (event, data) => events.push({ event, data }));
  const names = events.map((e) => e.event);
  assert.ok(names.includes('progress'), `应透传 progress: ${names}`);
  assert.ok(names.includes('done'), `应透传 done: ${names}`);
  const recoveredIdx = names.indexOf('recovered');
  assert.ok(recoveredIdx >= 0, `应发出 recovered: ${names}`);
  assert.equal(events[recoveredIdx].data.state.currentVersion, '9.9.9');
  assert.ok(names.indexOf('recovered') > names.indexOf('done'), 'recovered 应在 done 之后');
  assert.equal(seenAuth['/api/update/apply'], `Bearer ${HUB_TOKEN}`);
});

test('中枢拒绝成员令牌（401）时返回可读错误并提示重新绑定', async () => {
  db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES('sync_hub_token', ?)`).run('lsync_wrong');
  try {
    const res = await fetch(`${base()}/api/sync/hub-update/state`, { headers: { authorization: `Bearer ${ownerToken}` } });
    assert.equal(res.status, 502);
    const msg = String(((await res.json()) as any).error);
    assert.ok(msg.includes('重新绑定'), `错误应引导重新绑定: ${msg}`);
  } finally {
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES('sync_hub_token', ?)`).run(HUB_TOKEN);
  }
});

test('本地未认证请求被拒绝', async () => {
  const res = await fetch(`${base()}/api/sync/hub-update/state`);
  assert.equal(res.status, 401);
});
