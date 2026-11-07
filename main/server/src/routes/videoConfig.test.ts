import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * 视频理解配置的独立读写口（2026-11 起只维护总开关）。
 *
 * 锁住：
 *  1) 成员令牌能读写，未知令牌 401，owner 登录态照旧可用；
 *  2) GET 同时返回脱敏 settings.video_config 与解析到的模型状态（status），且不含任何 Key；
 *  3) PUT 只认 enabled，旧客户端的 baseUrl/apiKey/model 字段被忽略；
 *  4) 默认提供商播种已办结时不再启动 dsh 控制台（避免每次打开设置页都拉控制台）。
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-video-config-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
const memberToken = 'lsync_video_config_fixture';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  // 播种标记置 1：本文件只测读写语义，不让 GET 去拉起 dsh 控制台
  dbModule.setSetting('video_provider_seeded', '1');
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android 视频配置验收', memberToken);
  const { videoConfigRoutes } = await import('./videoConfig.js');
  app = Fastify();
  await app.register(jwt, { secret: 'video-config-route-test-secret' });
  await app.register(videoConfigRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function memberHeaders() {
  return { authorization: 'Bearer ' + memberToken };
}

test('成员令牌可读：未保存过时 video_config 为空串，status 带默认模型与缺失项', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: memberHeaders() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.settings.video_config, '', '未保存过时保持空串（与 /api/settings 同口径）');
  assert.equal(body.status.enabled, true, '默认开启');
  assert.equal(body.status.configured, false);
  assert.equal(body.status.model, 'qwen3.8-omni-flash');
  assert.equal(body.status.provider, 'dashscope');
  assert.equal(body.status.hasKey, false);
  assert.deepEqual(body.status.missing, ['视频模型提供商']);
});

test('成员令牌保存开关：只认 enabled，旧字段不落库、不回显', async () => {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/settings/video-config',
    headers: memberHeaders(),
    payload: {
      video_config: {
        enabled: false,
        baseUrl: 'https://legacy.example/v1',
        apiKey: 'sk-legacy-secret',
        model: 'omni-old',
        quality: 32,
      },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().ok, true);

  const { getVideoConfig } = await import('../lib/videoConfig.js');
  assert.deepEqual(getVideoConfig(), { enabled: false }, '旧字段不应写进 Engram 设置');

  const readBack = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: memberHeaders() });
  const json = readBack.json();
  assert.deepEqual(JSON.parse(json.settings.video_config), { enabled: false });
  assert.equal(json.settings.video_config.includes('sk-legacy-secret'), false);
  assert.equal(json.status.enabled, false);
});

test('未认证 401；owner 登录态仍可读写', async () => {
  const deniedGet = await app.inject({ method: 'GET', url: '/api/settings/video-config' });
  assert.equal(deniedGet.statusCode, 401);
  const deniedPut = await app.inject({ method: 'PUT', url: '/api/settings/video-config', payload: { video_config: {} } });
  assert.equal(deniedPut.statusCode, 401);

  const ownerHeaders = { authorization: 'Bearer ' + token };
  const ownerGet = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: ownerHeaders });
  assert.equal(ownerGet.statusCode, 200);
  const ownerPut = await app.inject({
    method: 'PUT',
    url: '/api/settings/video-config',
    headers: ownerHeaders,
    payload: { video_config: { enabled: true } },
  });
  assert.equal(ownerPut.statusCode, 200);
  const afterPut = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: ownerHeaders });
  assert.equal(afterPut.json().status.enabled, true);
});
