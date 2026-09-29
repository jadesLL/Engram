import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { memberHubAddresses, type HubAddressEntry } from './hubAddress.js';
import { lanIfaceCandidates, type NetworkInterfaces } from './link.js';

/**
 * 「成员该填哪个地址」的纯逻辑。真机 bug 的根因就在这里可复现：
 * 桌面版的内嵌服务只监听 127.0.0.1，旧界面却把 `location.origin`（http://127.0.0.1:18180）
 * 当成员绑定地址发给用户——填到手机上永远连不上。
 */

/** 一台典型 Windows 电脑：真网卡（WLAN/以太网）+ WSL 与 VPN 的虚拟网卡 */
const IFACES: NetworkInterfaces = {
  'WLAN': [{ address: '192.168.31.100', family: 'IPv4', internal: false }],
  '以太网': [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
  'vEthernet (WSL)': [{ address: '172.20.96.1', family: 'IPv4', internal: false }],
  'Tailscale': [{ address: '100.64.1.9', family: 'IPv4', internal: false }],
  'Loopback': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};

const urls = (list: HubAddressEntry[]): string[] => list.map((item) => item.url);

test('桌面版默认（只监听 127.0.0.1）：一条地址都不给，并记下被剔除的回环地址', () => {
  const report = memberHubAddresses({
    bindHost: '127.0.0.1',
    port: 18180,
    ifaces: IFACES,
    containerized: false,
    origin: 'http://127.0.0.1:18180',
  });
  assert.equal(report.bindScope, 'loopback');
  assert.deepEqual(report.addresses, [], '只监听回环时不能给出任何地址（配了也连不上）');
  assert.deepEqual(report.skippedLoopback, ['http://127.0.0.1:18180'], '界面要能解释为什么不再是 127.0.0.1');
});

test('开了局域网访问（0.0.0.0）：列出真网卡地址，虚拟网卡让位', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 18180,
    ifaces: IFACES,
    containerized: false,
    origin: 'http://127.0.0.1:18180',
  });
  assert.equal(report.bindScope, 'lan');
  // 真网卡在前（列表第一页就够用），WSL 这类虚拟网卡排在后面；Tailscale 的 100.64/10 不是私网段，不收
  assert.deepEqual(urls(report.addresses), [
    'http://192.168.31.100:18180',
    'http://10.0.0.7:18180',
    'http://172.20.96.1:18180',
  ]);
  assert.deepEqual(report.skippedLoopback, ['http://127.0.0.1:18180'], '回环 origin 一律剔除');
  assert.equal(report.addresses[0].label, '局域网 · WLAN', '带上网卡名，多网卡时用户知道该抄哪条');
});

test('真实网卡一张都没有时，虚拟网卡也列出来（宁多勿漏）', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 18080,
    ifaces: { 'vEthernet (WSL)': [{ address: '172.20.96.1', family: 'IPv4', internal: false }] },
    containerized: false,
  });
  assert.deepEqual(urls(report.addresses), ['http://172.20.96.1:18080']);
});

test('容器里不做网卡自动探测：172.x 是 Docker 网段，宿主上看不到', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 8080,
    ifaces: { eth0: [{ address: '172.18.0.3', family: 'IPv4', internal: false }] },
    containerized: true,
    env: {},
  });
  assert.deepEqual(report.addresses, []);
  assert.equal(report.containerized, true);

  const declared = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 8080,
    ifaces: { eth0: [{ address: '172.18.0.3', family: 'IPv4', internal: false }] },
    containerized: true,
    env: { LAN_ACCESS_URL: 'http://192.168.31.100:18080' },
  });
  assert.deepEqual(urls(declared.addresses), ['http://192.168.31.100:18080'], '容器里只认部署侧声明的地址');
});

test('部署侧声明里混进回环：剔除并记账，不去重成两条', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 8080,
    ifaces: {},
    containerized: true,
    env: { LAN_ACCESS_URL: 'http://127.0.0.1:18080, http://192.168.31.100:18080, http://192.168.31.100:18080/' },
  });
  assert.deepEqual(urls(report.addresses), ['http://192.168.31.100:18080']);
  assert.deepEqual(report.skippedLoopback, ['http://127.0.0.1:18080']);
});

test('公网地址排在局域网之后：DDNS 域名、直连声明、当前访问地址', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 18080,
    ifaces: { WLAN: [{ address: '192.168.31.100', family: 'IPv4', internal: false }] },
    containerized: false,
    origin: 'http://192.168.31.100:18080',
    ddnsHost: 'home.xxx.com',
    env: { DIRECT_ACCESS_URL: 'https://direct.xxx.com' },
  });
  assert.deepEqual(urls(report.addresses), [
    'http://192.168.31.100:18080',        // 网卡探测（origin 与它重复，只留一条）
    'http://home.xxx.com:18080',          // DDNS 域名
    'https://direct.xxx.com',             // 部署侧直连声明
  ]);
  assert.deepEqual(report.addresses.map((item) => item.kind), ['lan', 'public', 'public']);
  assert.deepEqual(report.addresses.map((item) => item.label), ['局域网 · WLAN', '公网直连域名', '公网直连地址']);
});

test('Docker 版用局域网 IP 打开设置页：当前访问地址本身就是可用地址', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 8080,
    ifaces: {},
    containerized: true,
    origin: 'http://192.168.31.9:18080',
  });
  assert.deepEqual(urls(report.addresses), ['http://192.168.31.9:18080']);
  assert.equal(report.addresses[0].source, 'origin');
  assert.equal(report.addresses[0].label, '当前访问地址');
});

test('监听地址是具体 IP 时它排最前（比网卡探测更权威）', () => {
  const report = memberHubAddresses({
    bindHost: '10.0.0.7',
    port: 18080,
    ifaces: { WLAN: [{ address: '192.168.31.100', family: 'IPv4', internal: false }] },
    containerized: false,
  });
  assert.deepEqual(urls(report.addresses), ['http://10.0.0.7:18080', 'http://192.168.31.100:18080']);
  assert.equal(report.addresses[0].source, 'bind');
});

test('IPv6 与坏值：ULA 带方括号保留，非 http(s) 与解析不了的丢弃', () => {
  const report = memberHubAddresses({
    bindHost: '0.0.0.0',
    port: 18080,
    ifaces: {
      eth0: [{ address: 'fd00::5', family: 'IPv6', internal: false }],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    },
    containerized: false,
    origin: 'ftp://192.168.1.9',
    ddnsHost: '',
    env: { LAN_ACCESS_URL: 'not-a-url http://192.168.31.100:18080/extra/path' },
  });
  // 先 IPv4（docker0 是虚拟网卡名，但同族里没有真网卡，照收）再 IPv6；ftp:// 与乱码都不进清单
  assert.deepEqual(urls(report.addresses), [
    'http://192.168.31.100:18080/extra/path',
    'http://172.17.0.1:18080',
    'http://[fd00::5]:18080',
  ]);
});

test('端口缺失时不给地址（拼不出可用 URL）', () => {
  const report = memberHubAddresses({ bindHost: '0.0.0.0', port: 0, ifaces: IFACES, containerized: false });
  assert.deepEqual(report.addresses, []);
});

test('不传 ifaces 时自动取真实网卡（回归：中枢接口漏传会让清单永远为空）', () => {
  const real = lanIfaceCandidates(os.networkInterfaces() as NetworkInterfaces, 18080);
  const report = memberHubAddresses({ bindHost: '0.0.0.0', port: 18080, containerized: false });
  assert.deepEqual(
    urls(report.addresses),
    real.map((item) => item.url),
    '缺省网卡必须与 os.networkInterfaces() 的结果一致'
  );
  assert.equal(
    report.addresses.length,
    real.length,
    '本机/容器只要有私网网卡就必须列出来（长度为 0 说明默认网卡没接上）'
  );
});
