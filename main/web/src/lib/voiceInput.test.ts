import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatModelSize,
  localModelPercent,
  localModelSummary,
  type SenseVoiceStatus,
} from './voiceInput.ts';

/** 本机模型状态展示：下载大小/进度/文案都在这里收口，菜单与设置页共用。 */

const base: SenseVoiceStatus = {
  supported: true,
  platform: 'win32-x64',
  ready: false,
  phase: 'missing',
  downloadedBytes: 0,
  totalBytes: 241_357_257,
  currentFile: '',
  error: '',
  modelRoot: 'C:/data/dsh/speech-to-text/sensevoice',
  sources: ['https://hf-mirror.com'],
  nodeAvailable: true,
};

test('formatModelSize：按十进制 MB/GB 展示，小文件落到 KB', () => {
  assert.equal(formatModelSize(0), '0MB');
  assert.equal(formatModelSize(-1), '0MB');
  assert.equal(formatModelSize(500_000), '500KB');
  assert.equal(formatModelSize(1_800_000), '1.8MB');
  assert.equal(formatModelSize(241_357_257), '241MB');
});

test('localModelPercent：0..100 夹紧，总大小未知时是 0', () => {
  assert.equal(localModelPercent({ ...base, totalBytes: 0, downloadedBytes: 10 }), 0);
  assert.equal(localModelPercent({ ...base, downloadedBytes: 0 }), 0);
  assert.equal(localModelPercent({ ...base, downloadedBytes: 120_678_628 }), 50);
  assert.equal(localModelPercent({ ...base, downloadedBytes: 999_999_999 }), 100);
});

test('localModelSummary：就绪 / 下载中 / 失败 / 未下载 / 平台不支持', () => {
  assert.equal(localModelSummary({ ...base, ready: true, phase: 'ready', downloadedBytes: base.totalBytes }), '已就绪，离线可用');
  assert.match(
    localModelSummary({ ...base, phase: 'preparing', downloadedBytes: 120_678_628 }),
    /^正在下载 50%（121MB \/ 241MB）$/,
  );
  assert.equal(localModelSummary({ ...base, phase: 'error', error: '模型文件校验失败，请重新下载' }), '模型文件校验失败，请重新下载');
  assert.equal(localModelSummary(base), '未下载（约 241MB）');
  assert.equal(
    localModelSummary({ ...base, supported: false, error: '当前平台没有可用的本机识别运行时' }),
    '当前平台没有可用的本机识别运行时',
  );
});
