import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingAddresses,
  hubAddressNotice,
  hubSkippedNotice,
  primaryBindingAddress,
  type HubAddressReport,
} from './hubAddress.ts';

/**
 * 中枢面板「成员绑定地址」的前端口径：主地址取第一条、没有地址时说清怎么开、
 * 被剔除的回环地址要给用户一个解释。真机 bug 是「中枢是电脑时地址写成 127.0.0.1」，
 * 因此这里的第一条不变量就是：任何情况下都不会把 127.0.0.1 当绑定地址交出去。
 */

const report = (over: Partial<HubAddressReport> = {}): HubAddressReport => ({
  bindHost: '0.0.0.0',
  bindScope: 'lan',
  port: 18080,
  addresses: [],
  skippedLoopback: [],
  containerized: false,
  ...over,
});

const entry = (url: string, label = '局域网 · WLAN') => ({ url, kind: 'lan' as const, source: 'auto', label });

test('主地址取清单第一条（服务端已排好序：局域网 → 公网）', () => {
  const full = report({ addresses: [entry('http://192.168.31.100:18180'), entry('https://home.xxx.com:18080', '公网直连域名')] });
  assert.equal(primaryBindingAddress(full), 'http://192.168.31.100:18180');
  assert.equal(bindingAddresses(full).length, 2);
  assert.equal(primaryBindingAddress(report()), '');
  assert.equal(primaryBindingAddress(null), '');
  assert.equal(primaryBindingAddress(undefined), '');
});

test('有地址时不解释（正常态不需要文案）', () => {
  const full = report({ addresses: [entry('http://192.168.31.100:18180')] });
  assert.equal(hubAddressNotice(full), '');
  assert.equal(hubAddressNotice(full, { desktop: true }), '');
});

test('只监听回环：桌面端指向「允许局域网访问」开关，非桌面端指向 Docker/NAS 中枢', () => {
  const loopback = report({ bindHost: '127.0.0.1', bindScope: 'loopback', skippedLoopback: ['http://127.0.0.1:18180'] });
  const desktop = hubAddressNotice(loopback, { desktop: true });
  assert.match(desktop, /127\.0\.0\.1/);
  assert.match(desktop, /允许局域网访问/);
  const server = hubAddressNotice(loopback);
  assert.match(server, /Docker|NAS/);
  assert.doesNotMatch(server, /允许局域网访问/, '浏览器里没有桌面端开关，不能指引用户点不存在的按钮');
});

test('容器里没有对外地址：指向部署侧 LAN_ACCESS_URL', () => {
  const container = report({ containerized: true, addresses: [] });
  const text = hubAddressNotice(container);
  assert.match(text, /LAN_ACCESS_URL/);
  assert.match(text, /172\.x/, '说清为什么不做自动探测');
});

test('既不是回环也不是容器：检查网线 / Wi-Fi 与网卡状态', () => {
  const text = hubAddressNotice(report());
  assert.match(text, /路由器|交换机|网卡/);
  assert.equal(hubAddressNotice(null), '', '还没拿到报告时不猜原因');
});

test('回环地址被剔除时给一句说明；没有剔除就沉默', () => {
  assert.equal(
    hubSkippedNotice(report({ skippedLoopback: ['http://127.0.0.1:18180'] })),
    '已忽略 http://127.0.0.1:18180：它是本机回环地址，只在这台设备内有效，别的设备填了连不上。'
  );
  assert.equal(hubSkippedNotice(report()), '');
  assert.equal(hubSkippedNotice(null), '');
});
