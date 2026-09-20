import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSyncTime, syncStatusView } from './syncStatus.ts';

// 用本地时间构造「当天正午」：跨时区（UTC 容器 / UTC+8 开发机）下断言都成立
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

test('未配置同步时不显示任何状态', () => {
  assert.equal(syncStatusView(null), null);
  assert.equal(syncStatusView({ role: 'none' }), null);
  assert.equal(syncStatusView({}), null);
});

test('成员端首次接入引导显示「同步中」', () => {
  const view = syncStatusView({ role: 'member', enabled: true, connected: true, syncing: true });
  assert.equal(view?.phase, 'syncing');
  assert.equal(view?.tone, 'busy');
  assert.equal(view?.label, '同步中…');
  assert.match(view!.detail, /首次同步/);
});

test('手动/周期全量对账进行中也算「同步中」（不是已完成）', () => {
  const view = syncStatusView(
    { role: 'member', enabled: true, connected: true, syncing: false, reconciling: true, pending: 0 },
    { now: NOW },
  );
  assert.equal(view?.phase, 'syncing');
  assert.equal(view?.detail, '正在全量对账');
});

test('成员端连接正常且无排队时显示「同步已完成」与最近同步时间', () => {
  const view = syncStatusView(
    {
      role: 'member',
      enabled: true,
      connected: true,
      syncing: false,
      pending: 0,
      pendingPulls: 0,
      lastSyncAt: new Date(NOW - 3 * 60_000).toISOString(),
    },
    { now: NOW },
  );
  assert.equal(view?.phase, 'done');
  assert.equal(view?.tone, 'ok');
  assert.equal(view?.label, '同步已完成');
  assert.equal(view?.detail, '最近同步 3 分钟前');
});

test('有待推送或待补拉文件时仍算「同步中」并给出数量', () => {
  const pending = syncStatusView({ role: 'member', enabled: true, connected: true, pending: 4 }, { now: NOW });
  assert.equal(pending?.phase, 'syncing');
  assert.equal(pending?.detail, '待推送 4 项');

  const pulls = syncStatusView(
    { role: 'member', enabled: true, connected: true, pending: 2, pendingPulls: 7 },
    { now: NOW },
  );
  assert.equal(pulls?.phase, 'syncing');
  assert.equal(pulls?.detail, '待推送 2 项 · 待补拉 7 个文件');
});

test('断线时提示中断与重连，并带出最近错误', () => {
  const view = syncStatusView(
    { role: 'member', enabled: true, connected: false, lastError: 'hub 返回 502: bad gateway' },
    { now: NOW },
  );
  assert.equal(view?.phase, 'offline');
  assert.equal(view?.tone, 'warn');
  assert.equal(view?.label, '同步中断');
  assert.equal(view?.detail, 'hub 返回 502: bad gateway');
  assert.match(view!.hint, /最近错误/);
});

test('断线且没有错误信息时给出默认重连文案', () => {
  const view = syncStatusView({ role: 'member', enabled: true, connected: false }, { now: NOW });
  assert.equal(view?.detail, '未连接中枢，正在自动重连');
});

test('底层网络错误不直接摆到首页：退回通用文案，原始错误留在提示里', () => {
  const view = syncStatusView(
    { role: 'member', enabled: true, connected: false, lastError: 'fetch failed' },
    { now: NOW },
  );
  assert.equal(view?.label, '同步中断');
  assert.equal(view?.detail, '未连接中枢，正在自动重连');
  assert.match(view!.hint, /fetch failed/);

  const refused = syncStatusView(
    { role: 'member', enabled: true, connected: false, lastError: 'connect ECONNREFUSED 192.168.1.101:18080' },
    { now: NOW },
  );
  assert.equal(refused?.detail, '未连接中枢，正在自动重连');
});

test('成员端停用同步时提示已停用而不是中断', () => {
  const view = syncStatusView({ role: 'member', enabled: false, connected: false }, { now: NOW });
  assert.equal(view?.phase, 'disabled');
  assert.equal(view?.tone, 'muted');
  assert.equal(view?.label, '同步已停用');
});

test('中枢端展示运行中与成员在线数', () => {
  const view = syncStatusView({
    role: 'hub',
    peers: [{ online: true }, { online: false }, { online: true }],
  });
  assert.equal(view?.phase, 'hub');
  assert.equal(view?.label, '中枢运行中');
  assert.equal(view?.detail, '2/3 个成员在线');

  const empty = syncStatusView({ role: 'hub', peers: [] });
  assert.equal(empty?.detail, '还没有成员设备绑定');
});

test('Android 本地端按最近一轮是否跑完判定', () => {
  const running = syncStatusView(
    { role: 'member', enabled: true, running: true },
    { androidLocal: true, now: NOW },
  );
  assert.equal(running?.phase, 'syncing');
  assert.equal(running?.label, '同步中…');

  const done = syncStatusView(
    { role: 'member', enabled: true, connected: true, running: false, lastSyncAt: new Date(NOW - 90_000).toISOString() },
    { androidLocal: true, now: NOW },
  );
  assert.equal(done?.phase, 'done');
  assert.equal(done?.detail, '最近同步 1 分钟前');

  const never = syncStatusView({ role: 'member', enabled: true, connected: false }, { androidLocal: true, now: NOW });
  assert.equal(never?.phase, 'offline');
  assert.equal(never?.label, '尚未同步');
});

test('formatSyncTime 覆盖各时间档位', () => {
  assert.equal(formatSyncTime(null, NOW), '');
  assert.equal(formatSyncTime('', NOW), '');
  assert.equal(formatSyncTime('not-a-date', NOW), '');
  assert.equal(formatSyncTime(new Date(NOW - 20_000).toISOString(), NOW), '刚刚');
  assert.equal(formatSyncTime(new Date(NOW - 5 * 60_000).toISOString(), NOW), '5 分钟前');
  // 时钟漂移：未来时间不显示负数
  assert.equal(formatSyncTime(new Date(NOW + 60_000).toISOString(), NOW), '刚刚');
  // 同一天超过 1 小时：显示今天的具体时刻（本地时区）
  const sameDay = new Date(NOW - 2 * 3_600_000);
  assert.match(formatSyncTime(sameDay.toISOString(), NOW), /^今天 \d{2}:\d{2}$/);
  assert.equal(formatSyncTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW), '3 天前');
  assert.match(formatSyncTime(new Date(NOW - 90 * 86_400_000).toISOString(), NOW), /^\d{4}-\d{2}-\d{2}$/);
});
