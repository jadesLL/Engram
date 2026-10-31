import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * v1.5.1：视频理解模型配置的独立读写口。
 *
 * 手机（Android 本地服务）只有同步成员令牌，设置页要把「视频理解模型」经中枢窄代理
 * 读写到中枢那一份配置；这个文件锁住三件事：
 *  1) 成员令牌能读写，未知令牌 401，owner 登录态照旧可用；
 *  2) 读接口永远不返回 apiKey；
 *  3) 留空 apiKey = 保留原 Key，apiKey:null = 显式清除（不能让手机端空表单冲掉中枢 Key）。
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
  return { authorization: `Bearer ${memberToken}` };
}

async function getConfig(): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: memberHeaders() });
  assert.equal(res.statusCode, 200);
  const text = res.json().settings?.video_config || '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

test('成员令牌可保存视频配置，读接口不回显 apiKey', async () => {
  const empty = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: memberHeaders() });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().settings.video_config, '', '未配置时应返回空串（与 /api/settings 同口径）');

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/settings/video-config',
    headers: memberHeaders(),
    payload: {
      video_config: {
        enabled: true,
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'sk-video-secret',
        model: 'qwen3.8-omni-flash',
        maxTokens: 8192,
        quality: 32,
        douyinBrowser: true,
      },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().ok, true);

  const masked = await getConfig();
  assert.equal(masked.enabled, true);
  assert.equal(masked.baseUrl, 'https://gw.example.com/v1');
  assert.equal(masked.model, 'qwen3.8-omni-flash');
  assert.equal(masked.quality, 32);
  assert.equal(masked.apiKey, undefined, 'GET 不能把视频模型 API Key 回显给前端');

  const { getVideoConfig } = await import('../lib/videoConfig.js');
  assert.equal(getVideoConfig().apiKey, 'sk-video-secret', 'Key 应真正写进中枢设置');
});

test('留空 apiKey 保留原 Key，apiKey:null 才是显式清除', async () => {
  const keep = await app.inject({
    method: 'PUT',
    url: '/api/settings/video-config',
    headers: memberHeaders(),
    payload: { video_config: { apiKey: '', model: 'omni-2' } },
  });
  assert.equal(keep.statusCode, 200);
  const { getVideoConfig } = await import('../lib/videoConfig.js');
  assert.equal(getVideoConfig().apiKey, 'sk-video-secret', '留空提交把中枢已有的 Key 冲掉了');
  assert.equal(getVideoConfig().model, 'omni-2');

  const clear = await app.inject({
    method: 'PUT',
    url: '/api/settings/video-config',
    headers: memberHeaders(),
    payload: { video_config: { apiKey: null } },
  });
  assert.equal(clear.statusCode, 200);
  assert.equal(getVideoConfig().apiKey, '', 'apiKey:null 应清除 Key');
});

test('未认证 401；owner 登录态仍可读写', async () => {
  const deniedGet = await app.inject({ method: 'GET', url: '/api/settings/video-config' });
  assert.equal(deniedGet.statusCode, 401);
  const deniedPut = await app.inject({ method: 'PUT', url: '/api/settings/video-config', payload: { video_config: {} } });
  assert.equal(deniedPut.statusCode, 401);

  const ownerHeaders = { authorization: `Bearer ${token}` };
  const ownerGet = await app.inject({ method: 'GET', url: '/api/settings/video-config', headers: ownerHeaders });
  assert.equal(ownerGet.statusCode, 200);
  const ownerPut = await app.inject({
    method: 'PUT',
    url: '/api/settings/video-config',
    headers: ownerHeaders,
    payload: { video_config: { enabled: false } },
  });
  assert.equal(ownerPut.statusCode, 200);
});
