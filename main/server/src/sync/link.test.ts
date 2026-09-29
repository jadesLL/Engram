import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBase,
  hostOf,
  hostnameOf,
  ipFamilyOf,
  isLinkLocal,
  isLoopbackHost,
  isLoopbackUrl,
  isPrivateHost,
  lanIfaceCandidates,
  normalizeAnnouncedLan,
  normalizeBase,
  pickLanUrls,
  pickWinner,
  planProbes,
  type SyncLinkCandidate,
} from './link.js';

/**
 * 连接通道择优的纯逻辑：候选排序、赢家裁决、内网地址判定与网卡挑址。
 * 真实探测（fetch + 超时 + 状态机）在 client.ts，靠 Docker 里的端到端验收覆盖。
 */

const candidate = (over: Partial<SyncLinkCandidate> & { url: string }): SyncLinkCandidate => ({
  kind: 'hub',
  label: '中枢地址',
  ok: false,
  latencyMs: null,
  ...over,
});

test('地址与主机名解析：带端口、IPv6 方括号', () => {
  assert.equal(normalizeBase('http://192.168.1.101:18080/'), 'http://192.168.1.101:18080');
  assert.equal(hostOf('http://192.168.1.101:18080'), '192.168.1.101:18080');
  assert.equal(hostnameOf('http://192.168.1.101:18080'), '192.168.1.101');
  assert.equal(hostnameOf('https://hub.xxx.com/sync'), 'hub.xxx.com');
  // IPv6 字面量：URL.host 保留方括号，hostname 也要能剥掉（dualStack 记账键不带括号）
  assert.equal(hostOf('http://[fd00::5]:18080'), '[fd00::5]:18080');
  assert.equal(hostnameOf('http://[fd00::5]:18080'), 'fd00::5');
});

test('内网地址判定覆盖私网段、回环、ULA，且不误伤公网', () => {
  for (const host of ['10.0.0.5', '172.16.3.4', '172.31.255.1', '192.168.31.100', '127.0.0.1', 'localhost', 'nas.local', 'fd00::1', 'fc00::abcd', 'fe80::1%17']) {
    assert.equal(isPrivateHost(host), true, `${host} 应判为内网`);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '2001:db8::1', 'hub.xxx.com', '']) {
    assert.equal(isPrivateHost(host), false, `${host} 不应判为内网`);
  }
  assert.equal(isLinkLocal('fe80::1'), true);
  assert.equal(isLinkLocal('169.254.1.1'), true);
  assert.equal(isLinkLocal('fd00::1'), false);
  assert.equal(ipFamilyOf('2001:db8::1'), 6);
  assert.equal(ipFamilyOf('192.168.1.1'), 4);
  assert.equal(ipFamilyOf('hub.xxx.com'), null);
});

test('通道归类：字面量即答案，域名要等连上才知道', () => {
  assert.equal(classifyBase('http://192.168.1.101:18080'), 'lan');
  assert.equal(classifyBase('http://[fd00::5]:18080'), 'lan');
  assert.equal(classifyBase('http://127.0.0.1:18080'), 'lan');
  assert.equal(classifyBase('http://[2001:db8::1]:18080'), 'ipv6');
  assert.equal(classifyBase('http://1.2.3.4:18080'), 'ipv4');
  // 域名：协议族由双栈策略在建连时决定，这里不能瞎猜
  assert.equal(classifyBase('https://hub.xxx.com'), null);
  assert.equal(classifyBase(''), null);
});

test('候选排序：局域网在前、中枢地址垫底；关掉优先局域网就只剩中枢地址', () => {
  const hub = 'https://hub.xxx.com';
  const lan = ['http://192.168.1.101:18080', 'http://[fd00::5]:18080'];
  const on = planProbes({ hubBase: hub, announcedLan: lan, preferLan: true });
  assert.deepEqual(on.map((item) => item.url), [...lan, hub]);
  assert.deepEqual(on.map((item) => item.kind), ['lan', 'lan', 'hub']);

  const off = planProbes({ hubBase: hub, announcedLan: lan, preferLan: false });
  assert.deepEqual(off.map((item) => item.url), [hub]);
});

test('候选排序：与主地址重复、非 http、空值都不再单列', () => {
  const targets = planProbes({
    hubBase: 'http://192.168.1.101:18080',
    announcedLan: ['http://192.168.1.101:18080', 'ftp://192.168.1.9', '', 'http://192.168.1.11:18080/'],
    preferLan: true,
  });
  assert.deepEqual(targets.map((item) => item.url), ['http://192.168.1.11:18080', 'http://192.168.1.101:18080']);
});

test('赢家裁决：局域网优先，局域网不通回中枢地址，全不通即断开', () => {
  const lanOk = candidate({ kind: 'lan', label: '局域网', url: 'http://192.168.1.101:18080', ok: true, latencyMs: 4 });
  const lanBad = candidate({ kind: 'lan', label: '局域网', url: 'http://192.168.1.101:18080', ok: false });
  const hubOk = candidate({ url: 'https://hub.xxx.com', ok: true, latencyMs: 38 });

  assert.equal(pickWinner([lanOk, hubOk], true)?.url, lanOk.url);
  assert.equal(pickWinner([lanBad, hubOk], true)?.url, hubOk.url);
  assert.equal(pickWinner([hubOk, lanOk], false)?.url, hubOk.url, '关掉优先局域网时不该走局域网');
  assert.equal(pickWinner([lanBad, candidate({ url: 'https://hub.xxx.com', ok: false })], true), null);
  assert.equal(pickWinner([], true), null);
});

test('网卡挑址：私网 IPv4 在前、ULA IPv6 在后，跳过回环/链路本地/公网地址', () => {
  const urls = pickLanUrls({
    '以太网': [
      { address: '192.168.31.100', family: 'IPv4', internal: false },
      { address: '10.8.0.2', family: 'IPv4', internal: false },
    ],
    'vEthernet (WSL)': [{ address: '172.20.96.1', family: 'IPv4', internal: false }],
    'Loopback': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'IPv6 网卡': [
      { address: 'fd00::5', family: 'IPv6', internal: false },
      { address: 'fe80::1%17', family: 'IPv6', internal: false },
      { address: '2001:db8:5400::abd', family: 'IPv6', internal: false },
    ],
  }, 18080);
  assert.deepEqual(urls, [
    'http://192.168.31.100:18080',
    'http://10.8.0.2:18080',
    'http://172.20.96.1:18080',
    'http://[fd00::5]:18080',
  ]);
});

test('网卡挑址：部署侧声明的地址排最前（容器里看到的不是宿主机内网地址）', () => {
  const urls = pickLanUrls(
    { eth0: [{ address: '172.18.0.3', family: 'IPv4', internal: false }] },
    8080,
    ['http://192.168.31.100:18080', 'http://192.168.31.100:18080/', 'not-a-url']
  );
  assert.deepEqual(urls, ['http://192.168.31.100:18080', 'http://172.18.0.3:8080']);
});

test('中枢通告归一化：只留 http(s)、去重、去掉与主地址重复的', () => {
  assert.deepEqual(
    normalizeAnnouncedLan(['http://192.168.1.101:18080/', 'http://192.168.1.101:18080', 'https://hub.xxx.com'], 'https://hub.xxx.com'),
    ['http://192.168.1.101:18080']
  );
  assert.deepEqual(normalizeAnnouncedLan(undefined, 'https://hub.xxx.com'), []);
  assert.deepEqual(normalizeAnnouncedLan('http://x', 'https://hub.xxx.com'), []);
});

test('回环地址判定：127.0.0.0/8、::1、localhost 与外层方括号', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(host), true, `${host} 应判为回环`);
  }
  for (const host of ['192.168.1.101', '10.0.0.5', 'fd00::1', 'hub.xxx.com', '127.0.0.1.example.com', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} 不应判为回环`);
  }
  assert.equal(isLoopbackUrl('http://127.0.0.1:18180/'), true);
  assert.equal(isLoopbackUrl('http://[::1]:18080'), true);
  assert.equal(isLoopbackUrl('http://192.168.1.101:18080'), false);
  assert.equal(isLoopbackUrl('not-a-url'), false);
});

test('网卡挑址：真实网卡排在同族虚拟网卡之前（VPN/WSL 给的地址成员连不上）', () => {
  // 刻意让虚拟网卡在前：排序必须由「网卡名像不像真网卡」决定，而不是字典序/对象顺序
  const urls = pickLanUrls({
    'vEthernet (WSL)': [{ address: '172.20.96.1', family: 'IPv4', internal: false }],
    'WLAN': [{ address: '192.168.31.100', family: 'IPv4', internal: false }],
    'Tailscale': [{ address: 'fd7a:115c::1', family: 'IPv6', internal: false }],
    'eth0': [{ address: 'fd00::5', family: 'IPv6', internal: false }],
  }, 18180);
  assert.deepEqual(urls, [
    'http://192.168.31.100:18180',
    'http://172.20.96.1:18180',
    'http://[fd00::5]:18180',
    'http://[fd7a:115c::1]:18180',
  ]);
});

test('网卡挑址：部署侧声明里混进回环就丢掉（成员探 127.0.0.1 只会探到它自己）', () => {
  const urls = pickLanUrls(
    { 'WLAN': [{ address: '192.168.31.100', family: 'IPv4', internal: false }] },
    18080,
    ['http://127.0.0.1:18080', 'http://localhost:18080', 'http://192.168.31.100:18080']
  );
  assert.deepEqual(urls, ['http://192.168.31.100:18080']);
});

test('中枢通告归一化：回环地址一律丢弃（旧版中枢可能把 127.0.0.1 播出来）', () => {
  assert.deepEqual(
    normalizeAnnouncedLan(
      ['http://127.0.0.1:18180', 'http://localhost:18180', 'http://192.168.1.101:18080'],
      'https://hub.xxx.com'
    ),
    ['http://192.168.1.101:18080']
  );
});

test('网卡候选带网卡名与真假标记（界面据此标注「局域网 · WLAN」）', () => {
  const list = lanIfaceCandidates({
    'WLAN': [{ address: '192.168.31.100', family: 'IPv4', internal: false }],
    'vEthernet (WSL)': [{ address: '172.20.96.1', family: 'IPv4', internal: false }],
  }, 18180);
  assert.deepEqual(list, [
    { url: 'http://192.168.31.100:18180', iface: 'WLAN', real: true },
    { url: 'http://172.20.96.1:18180', iface: 'vEthernet (WSL)', real: false },
  ]);
});

test('网卡挑址：192.168 家庭网段排在 VPN / 虚拟网卡之前（首选地址不能是 172.x 隧道）', () => {
  // 真机验收抓到过：VPN 的 172.30.x 排在首位，中枢面板给成员的首选地址就是它，别的设备连不上
  const urls = pickLanUrls({
    'vgate0': [{ address: '172.30.196.86', family: 'IPv4', internal: false }],
    '以太网': [{ address: '192.168.31.100', family: 'IPv4', internal: false }],
    'vEthernet (Default Switch)': [{ address: '172.19.80.1', family: 'IPv4', internal: false }],
  }, 18180);
  assert.deepEqual(urls, [
    'http://192.168.31.100:18180',
    'http://172.30.196.86:18180',
    'http://172.19.80.1:18180',
  ]);
});
