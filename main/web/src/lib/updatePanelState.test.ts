import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptManualProgressEvent,
  autoProgressPercent,
  autoProgressVisible,
  autoUpdateStatusLine,
  autoUpdateStatusTone,
  clampPercent,
  isAutoDownloading,
} from './updatePanelState.ts';

const base = {
  enabled: true,
  phase: 'idle',
  latestVersion: null as string | null,
  percent: null as number | null,
  error: '',
};

test('状态行任何阶段都有文字：状态槽常驻才不会因为节点增删改变卡片高度', () => {
  const phases = ['idle', 'checking', 'downloading', 'up-to-date', 'installing', 'failed', 'unconfigured', 'paused'];
  for (const phase of phases) {
    const text = autoUpdateStatusLine({ ...base, phase });
    assert.ok(text.length > 0, `阶段 ${phase} 必须有状态文字（空字符串会让固定高度槽位空着）`);
  }
  assert.ok(autoUpdateStatusLine({ ...base, enabled: false }).includes('已关闭'));
  assert.ok(autoUpdateStatusLine({ ...base, enabled: false, phase: 'idle' }).includes('已关闭'));
});

test('下载中的状态行带真实百分比；百分比缺失时只说「正在后台下载」', () => {
  assert.equal(
    autoUpdateStatusLine({ ...base, phase: 'downloading', latestVersion: '1.5.8', percent: 39 }),
    '发现新版本 v1.5.8，正在后台下载 39%…',
  );
  assert.equal(
    autoUpdateStatusLine({ ...base, phase: 'downloading', latestVersion: '1.5.8', percent: null }),
    '发现新版本 v1.5.8，正在后台下载…',
  );
  // 旧壳可能把上一轮的 100% 留在状态里；这里仍按实际传入值展示，主进程负责重置
  assert.ok(autoUpdateStatusLine({ ...base, phase: 'downloading', latestVersion: '1.5.8', percent: 100 }).includes('100%'));
});

test('进度轨宽度只认下载阶段：其余阶段为 0（轨道常驻占位，不显示假进度）', () => {
  assert.equal(autoProgressPercent({ ...base, phase: 'downloading', percent: 39 }), 39);
  assert.equal(autoProgressPercent({ ...base, phase: 'downloading', percent: 133 }), 100);
  assert.equal(autoProgressPercent({ ...base, phase: 'downloading', percent: null }), 0);
  assert.equal(autoProgressPercent({ ...base, phase: 'checking', percent: 39 }), 0, '检查阶段不能顶着上一轮的百分比');
  assert.equal(autoProgressPercent({ ...base, phase: 'downloading', percent: 39, enabled: false }), 0, '关掉自动更新就不再显示进度');
  assert.equal(autoProgressVisible({ ...base, phase: 'idle' }), false);
  assert.equal(autoProgressVisible({ ...base, phase: 'downloading', percent: 0 }), false);
});

test('色调：失败红、安装中黄，其余常规', () => {
  assert.equal(autoUpdateStatusTone({ ...base, phase: 'failed' }), 'err');
  assert.equal(autoUpdateStatusTone({ ...base, phase: 'installing' }), 'warn');
  assert.equal(autoUpdateStatusTone({ ...base, phase: 'downloading' }), '');
  assert.equal(autoUpdateStatusTone({ ...base, phase: 'idle' }), '');
});

test('自动更新下载/安装期间要禁用「下载并安装」（两者落盘同一个文件）', () => {
  assert.equal(isAutoDownloading({ ...base, phase: 'downloading' }), true);
  assert.equal(isAutoDownloading({ ...base, phase: 'installing' }), true);
  assert.equal(isAutoDownloading({ ...base, phase: 'checking' }), false);
  assert.equal(isAutoDownloading({ ...base, phase: 'idle' }), false);
  assert.equal(isAutoDownloading({ ...base, phase: 'downloading', enabled: false }), false, '开关关掉就不再拦手动下载');
});

test('手动进度只采信 manual：旧壳没有 source 时全收，新壳过滤掉 auto', () => {
  assert.equal(acceptManualProgressEvent({ percent: 12, source: 'manual' }), true);
  assert.equal(acceptManualProgressEvent({ percent: 12, source: 'auto' }), false, '自动更新进度不能串到手动进度条');
  assert.equal(acceptManualProgressEvent({ percent: 12 }), true, '旧壳没有来源字段');
  assert.equal(acceptManualProgressEvent(null), false);
  assert.equal(acceptManualProgressEvent('bad'), false);
});

test('clampPercent：负数/超界/非数字都收敛成 0–100 的整数', () => {
  assert.equal(clampPercent(39.6), 40);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(101), 100);
  assert.equal(clampPercent('x'), 0);
});
