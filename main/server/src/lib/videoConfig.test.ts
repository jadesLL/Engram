import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 视频理解配置：默认关闭、字段归一化（清晰度/上限）、Key 不回显、缺项提示。
 * 这些断言是「面板保存后再读回来不会悄悄丢字段」的可执行版本。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-video-config-'));
process.env.DATA_DIR = temp;

let getVideoConfig: typeof import('./videoConfig.js').getVideoConfig;
let setVideoConfig: typeof import('./videoConfig.js').setVideoConfig;
let videoConfigReady: typeof import('./videoConfig.js').videoConfigReady;
let videoConfigHint: typeof import('./videoConfig.js').videoConfigHint;
let videoConfigStatus: typeof import('./videoConfig.js').videoConfigStatus;
let db: any;

before(async () => {
  db = (await import('./db.js')).db;
  (await import('./db.js')).migrate();
  ({ getVideoConfig, setVideoConfig, videoConfigReady, videoConfigHint, videoConfigStatus } = await import('./videoConfig.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('默认：关闭、空路由、720P，未配置时 ready=false 且提示去设置', () => {
  const config = getVideoConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.baseUrl, '');
  assert.equal(config.model, '');
  assert.equal(config.quality, 64);
  assert.equal(config.maxTokens, 4096);
  assert.equal(videoConfigReady(config), false);
  assert.match(videoConfigHint(config), /视频理解未启用/);
});

test('保存：归一化字段（去空格/夹取清晰度与 maxTokens），部分更新不丢其他字段', () => {
  setVideoConfig({ enabled: true, baseUrl: '  https://gw.example/v1  ', model: ' omni ', apiKey: 'sk-1', quality: 32 as any, maxTokens: 123 });
  let config = getVideoConfig();
  assert.equal(config.baseUrl, 'https://gw.example/v1');
  assert.equal(config.model, 'omni');
  assert.equal(config.apiKey, 'sk-1');
  assert.equal(config.quality, 32);
  assert.equal(config.maxTokens, 256, '低于下限时夹到 256');
  assert.equal(videoConfigReady(config), true);

  setVideoConfig({ douyinBrowser: true });
  config = getVideoConfig();
  assert.equal(config.douyinBrowser, true);
  assert.equal(config.baseUrl, 'https://gw.example/v1', '部分更新不丢已有字段');

  setVideoConfig({ quality: 999 as any });
  assert.equal(getVideoConfig().quality, 64, '非法清晰度回退 720P');
});

test('缺项提示逐项列出；补全后 ready=true', () => {
  setVideoConfig({ enabled: true, baseUrl: '', apiKey: '', model: '', quality: 64 });
  assert.equal(videoConfigHint(getVideoConfig()).includes('Base URL'), true);
  assert.match(videoConfigHint(getVideoConfig()), /API Key/);
  assert.match(videoConfigHint(getVideoConfig()), /模型名/);
  setVideoConfig({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm' });
  assert.equal(videoConfigReady(getVideoConfig()), true);
});

test('状态摘要不回显 API Key，只给 hasKey', () => {
  setVideoConfig({ enabled: true, baseUrl: 'https://gw.example/v1', apiKey: 'secret-key', model: 'm' });
  const status = videoConfigStatus();
  assert.equal(status.hasKey, true);
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('secret-key'), false);
});
