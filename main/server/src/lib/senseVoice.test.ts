import test from 'node:test';
import assert from 'node:assert/strict';
import { senseVoiceStatus, stopSenseVoiceWorker } from './senseVoice.js';
import {
  SENSEVOICE_ASSETS,
  SENSEVOICE_SOURCES,
  SENSEVOICE_TOTAL_BYTES,
} from './senseVoiceAssets.js';

/**
 * SenseVoice 本机识别的约定：
 *  - 模型身份固定（大小 + SHA-256），下载后必须逐字节校验；
 *  - 状态查询不能偷偷联网/下载，未准备时如实返回 missing/error；
 *  - 空闲进程可以重复停止（服务退出 / 测试收尾都要安全）。
 */

test('模型身份固定：每个文件都有大小与 SHA-256，总量与清单一致', () => {
  for (const asset of SENSEVOICE_ASSETS) {
    assert.ok(asset.name.length > 0);
    assert.ok(asset.bytes > 0, `${asset.name} 缺少大小`);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/, `${asset.name} 的 SHA-256 格式不对`);
    assert.match(asset.url, /^https:\/\/huggingface\.co\//, `${asset.name} 应使用固定修订的 HF 路径`);
  }
  const sum = SENSEVOICE_ASSETS.reduce((total, asset) => total + asset.bytes, 0);
  assert.equal(SENSEVOICE_TOTAL_BYTES, sum);
  assert.ok(SENSEVOICE_TOTAL_BYTES > 200 * 1_000_000, 'SenseVoice int8 模型应大于 200MB');
  assert.deepEqual(SENSEVOICE_SOURCES, ['https://hf-mirror.com', 'https://huggingface.co']);
});

test('状态查询不会偷偷下载：未准备时是 missing/error，不会进入 preparing', async () => {
  const status = await senseVoiceStatus();
  assert.equal(status.totalBytes, SENSEVOICE_TOTAL_BYTES);
  assert.notEqual(status.phase, 'preparing', '准备必须是用户显式点击，状态查询不能自动开始');
  if (status.ready) {
    assert.equal(status.phase, 'ready');
  } else {
    assert.ok(status.phase === 'missing' || status.phase === 'error');
  }
  assert.ok(status.downloadedBytes >= 0 && status.downloadedBytes <= SENSEVOICE_TOTAL_BYTES);
  assert.ok(status.platform.length > 0);
});

test('空闲 worker 重复停止是幂等的', () => {
  stopSenseVoiceWorker();
  stopSenseVoiceWorker();
});
