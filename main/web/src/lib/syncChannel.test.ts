import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelErrorText,
  formatChannelSince,
  inferChannelFromUrl,
  syncChannelView,
  type SyncLinkStatus,
} from './syncChannel.ts';

// 用本地时间构造「当天正午」：跨时区（UTC 容器 / UTC+8 开发机）下断言都成立
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

function linkOf(over: Partial<SyncLinkStatus> = {}): SyncLinkStatus {
  return {
    channel: 'lan',
    url: 'http://192.168.1.101:18080',
    host: '192.168.1.101:18080',
    latencyMs: 4,
    since: null,
    probedAt: new Date(NOW - 1000).toISOString(),
    preferLan: true,
    candidates: [],
    ...over,
  };
}

test('未配置同步时不显示任何通道（与首页状态条同一口径）', () => {
  assert.equal(syncChannelView(null), null);
  assert.equal(syncChannelView({}), null);
  assert.equal(syncChannelView({ role: 'none' }), null);
});

test('中枢端显示成员在线数，颜色走中性档', () => {
  const full = syncChannelView({
    role: 'hub',
    peers: [{ online: true }, { online: false }, { online: true }],
  });
  assert.equal(full?.key, 'hub');
  assert.equal(full?.label, '中枢 2/3');
  assert.equal(full?.detail, '2/3 个成员在线');

  // 还没有成员：只写「中枢」，不写 0/0
  const empty = syncChannelView({ role: 'hub', peers: [] });
  assert.equal(empty?.label, '中枢');
  assert.equal(empty?.detail, '还没有成员设备绑定');
});

test('同步被停用时显示「已停用」', () => {
  const view = syncChannelView({ role: 'member', enabled: false, connected: false });
  assert.equal(view?.key, 'muted');
  assert.equal(view?.label, '已停用');
  // 停用优先于断开：用户主动关掉的不该显示成故障
  assert.match(view!.hint, /设置/);
});

test('断开时显示「已断开」并给重试提示', () => {
  const view = syncChannelView({ role: 'member', enabled: true, connected: false });
  assert.equal(view?.key, 'offline');
  assert.equal(view?.label, '已断开');
  assert.equal(view?.title, '连接中断 · 所有通道不可达');
  assert.match(view!.detail, /自动重连/);
  assert.match(view!.hint, /立即重连/);
});

test('断开的原始错误里没有信息量的那几种不往界面上搬', () => {
  const view = syncChannelView({
    role: 'member',
    enabled: true,
    connected: false,
    lastError: 'fetch failed',
    pending: 3,
  });
  assert.doesNotMatch(view!.detail, /fetch failed/);
  assert.match(view!.detail, /改动已排队 3 项/);

  const real = syncChannelView({
    role: 'member',
    enabled: true,
    connected: false,
    lastError: '中枢返回 401：绑定令牌已失效',
  });
  assert.match(real!.detail, /绑定令牌已失效/);
});

test('连接正常时按 link.channel 映射四态', () => {
  const cases = [
    ['lan', '局域网', '局域网直连'],
    ['ipv6', 'IPv6', 'IPv6 直连'],
    ['ipv4', 'IPv4', 'IPv4 直连'],
  ] as const;
  for (const [channel, label, fullLabel] of cases) {
    const view = syncChannelView(
      {
        role: 'member',
        enabled: true,
        connected: true,
        link: linkOf({ channel, latencyMs: 4 }),
      },
      { now: NOW },
    );
    assert.equal(view?.key, channel);
    assert.equal(view?.label, label);
    assert.equal(view?.title, `${fullLabel} · 192.168.1.101:18080`);
    assert.equal(view?.detail, '延迟 4ms');
  }
});

test('link 说全都不可达、数据面却刚通信成功时按「已连接」（下一轮探测会把通道补上）', () => {
  // 中枢刚重启：探测记账还停在「都不通」，而推送/补拉已经通了——这时不能拿红色「已断开」吓用户
  const view = syncChannelView({
    role: 'member',
    enabled: true,
    connected: true,
    link: linkOf({ channel: 'offline', url: '', host: '', latencyMs: null }),
  });
  assert.equal(view?.key, 'connected');
  assert.equal(view?.label, '已连接');
  assert.equal(view?.host, '');
});

test('认不出的 channel 取值退回中性的「已连接」，不硬套四色之一', () => {
  const view = syncChannelView({
    role: 'member',
    enabled: true,
    connected: true,
    // 旧客户端 / 服务端将来加了新档：宁可不说话，也不说错
    link: linkOf({ channel: 'weird' as never, host: '' }),
  });
  assert.equal(view?.key, 'connected');
  assert.equal(view?.label, '已连接');
});

test('叠加态只加角标与转圈：通道颜色与文案不变', () => {
  const idle = syncChannelView(
    { role: 'member', enabled: true, connected: true, link: linkOf() },
    { now: NOW },
  );
  assert.equal(idle?.busy, false);
  assert.equal(idle?.pending, 0);

  // 一轮同步正在跑
  const syncing = syncChannelView(
    { role: 'member', enabled: true, connected: true, syncing: true, link: linkOf() },
    { now: NOW },
  );
  assert.equal(syncing?.busy, true);
  assert.equal(syncing?.key, idle?.key);
  assert.equal(syncing?.label, idle?.label);

  // 还有排队改动（含 Android 本地端的 running 与待补拉）
  for (const extra of [{ pending: 3 }, { pendingPulls: 2 }, { reconciling: true }, { running: true }]) {
    const view = syncChannelView(
      { role: 'member', enabled: true, connected: true, link: linkOf(), ...extra },
      { now: NOW },
    );
    assert.equal(view?.busy, true, `${Object.keys(extra)[0]} 没有算进叠加态`);
    assert.equal(view?.key, 'lan');
  }
  const queued = syncChannelView(
    { role: 'member', enabled: true, connected: true, link: linkOf(), pending: 3, pendingPulls: 1 },
    { now: NOW },
  );
  assert.equal(queued?.pending, 3);
  assert.equal(queued?.detail, '延迟 4ms · 待推送 3 项 · 待补拉 1 个文件');
});

test('第二行把延迟 / 最近同步 / 队列按顺序拼起来', () => {
  const view = syncChannelView(
    {
      role: 'member',
      enabled: true,
      connected: true,
      pending: 3,
      lastSyncAt: new Date(NOW - 2 * 60_000).toISOString(),
      link: linkOf({ latencyMs: 4, since: new Date(NOW - 12 * 60_000).toISOString() }),
    },
    { now: NOW },
  );
  assert.equal(view?.detail, '延迟 4ms · 最近同步 2 分钟前 · 待推送 3 项');
  assert.equal(view?.since, new Date(NOW - 12 * 60_000).toISOString());
});

test('没有 link 时（Android 本地端）按中枢地址推断通道', () => {
  const infer = (hubUrl: string) =>
    syncChannelView({ role: 'member', enabled: true, connected: true, hubUrl }, { now: NOW });

  assert.equal(infer('http://192.168.1.101:18080')?.key, 'lan');
  assert.equal(infer('http://10.0.0.5:18080')?.label, '局域网');
  assert.equal(infer('http://172.20.3.4:18080')?.key, 'lan');
  assert.equal(infer('http://[fd00::1]:18080')?.key, 'ipv6');
  assert.equal(infer('http://fd00::1:18080')?.key, 'ipv6');
  assert.equal(infer('http://8.8.8.8:18080')?.key, 'ipv4');

  // 域名可能走 AAAA 也可能走 A：推断不出就不硬编成四色之一
  const domain = infer('https://hub.xxx.com');
  assert.equal(domain?.key, 'connected');
  assert.equal(domain?.label, '已连接');
  assert.equal(domain?.title, '已连接中枢 · hub.xxx.com');
  assert.equal(domain?.host, 'hub.xxx.com');
});

test('inferChannelFromUrl 只认字面量能定死的地址', () => {
  assert.equal(inferChannelFromUrl('http://192.168.1.101:18080'), 'lan');
  assert.equal(inferChannelFromUrl('http://127.0.0.1:18080'), 'lan');
  assert.equal(inferChannelFromUrl('http://nas.local:18080'), 'lan');
  assert.equal(inferChannelFromUrl('http://localhost:18080'), 'lan');
  assert.equal(inferChannelFromUrl('http://172.15.0.1'), 'ipv4');
  assert.equal(inferChannelFromUrl('http://172.32.0.1'), 'ipv4');
  assert.equal(inferChannelFromUrl('http://[2001:db8::1]:18080'), 'ipv6');
  assert.equal(inferChannelFromUrl('https://hub.xxx.com'), null);
  assert.equal(inferChannelFromUrl('http://192.168.1.101:18080/'), 'lan');
  assert.equal(inferChannelFromUrl(''), null);
  assert.equal(inferChannelFromUrl(null), null);
});

test('channelErrorText / formatChannelSince 的边界', () => {
  assert.equal(channelErrorText('fetch failed'), '');
  assert.equal(channelErrorText('ECONNREFUSED 127.0.0.1:18080'), '');
  assert.equal(channelErrorText(''), '');
  assert.equal(channelErrorText('中枢没有启动'), '中枢没有启动');
  assert.equal(channelErrorText('x'.repeat(80)).endsWith('…'), true);

  assert.equal(formatChannelSince(null, NOW), '');
  assert.equal(formatChannelSince('不是时间', NOW), '');
  assert.equal(formatChannelSince(new Date(NOW - 30_000).toISOString(), NOW), '不到 1 分钟');
  assert.equal(formatChannelSince(new Date(NOW - 12 * 60_000).toISOString(), NOW), '12 分钟');
  assert.equal(formatChannelSince(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), '3 小时');
  assert.equal(formatChannelSince(new Date(NOW - 200 * 60_000).toISOString(), NOW), '3 小时 20 分');
  assert.equal(formatChannelSince(new Date(NOW - 2 * 86_400_000).toISOString(), NOW), '2 天');
});
