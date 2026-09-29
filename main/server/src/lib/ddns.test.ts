import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先设 DATA_DIR 再动态导入（db.js 在导入时按 DATA_DIR 建库，避免污染 worktree）
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ddns-'));
process.env.DATA_DIR = temp;

const {
  clampInterval,
  getDdnsConfig,
  listCloudflareZones,
  normIp,
  normalizeRecord,
  parseDohAnswers,
  parseLinuxIfInet6,
  parseWindowsIpconfig,
  setDdnsFetchForTest,
  syncDdnsRecord,
  verifyCloudflareToken,
} = await import('./ddns.js');
const dbModule = await import('../lib/db.js');
const { migrate, db, setSetting } = dbModule as typeof import('../lib/db.js');

import type { DdnsConfig } from './ddns.js';

// ---------- fixtures（zh 取自真实 ipconfig 输出，含默认网关延续行陷阱） ----------

const IPCONFIG_ZH = `
Windows IP 配置

无线局域网适配器 WLAN:

   连接特定的 DNS 后缀. . . . . . . . :
   本地链接 IPv6 地址. . . . . . . . : fe80::1%17
   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : fe80::1%17
                                        2001:db8:5400:feb0::1
   IPv6 地址 . . . . . . . . . . . . : 2001:db8:5400:feb0::abd
   IPv6 地址 . . . . . . . . . . . . : 2001:db8:5400:feb0:7226:d527:175f:b42b
   临时 IPv6 地址. . . . . . . . . . : 2001:db8:5400:feb0:192b:a826:47d5:47ac
   DNS 服务器 . . . . . . . . . . . . : 2001:db8::8888
`;

const IPCONFIG_EN = `
Windows IP Configuration

Ethernet adapter Ethernet:

   Link-local IPv6 Address . . . . . : fe80::1%12
   IPv4 Address. . . . . . . . . . . : 192.168.1.101
   Default Gateway . . . . . . . . . : fe80::2%12
                                        2001:db8::1
   IPv6 Address. . . . . . . . . . . : 2001:db8:0:f101::5
   Temporary IPv6 Address. . . . . . : 2001:db8:0:f101:9:1
   DNS Servers . . . . . . . . . . . : 2001:db8::53
`;

const PROC_INET6 = [
  '00000000000000000000000000000001 01 80 10 80 lo',              // ::1（scope 10 host）
  'fe800000000000000000000000000002 02 64 20 00 eth0',            // link-local（scope 20）
  '20010db80540feb 03 40 00 00 eth0',                             // 地址长度非法，跳过
  '20010db80540feb00000000000000abd 03 40 00 00 eth0',            // 全局稳定
  '20010db80540feb0192ba82647d547ac 03 40 00 01 eth0',            // 全局临时（flags 0x01）
  '20010db80540feb07226d527175fb42b 03 40 00 40 eth0',            // tentative（flags 0x40）
].join('\n');

// ---------- 工具 ----------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface CfCall { url: string; method: string; body?: Record<string, unknown> }

interface StubOpts {
  /** 可维护的 zone 名（null=这个 token 管不了任何 zone） */
  zone?: string | null;
  /** 初始记录：不写 type 时按地址形态推断（含冒号即 AAAA），与历史用例写法兼容 */
  records?: Array<{ id: string; content: string; type?: 'A' | 'AAAA' }>;
  /** Cloudflare zone 状态：默认 active；pending 用来复现「记录写进去了但外网看不到」 */
  zoneStatus?: string;
  /** Cloudflare 分配的 NS */
  zoneNameServers?: string[];
  /** 注册局当前在用的 NS */
  registrarNameServers?: string[];
  /** DoH 行为：echo（默认）按 Cloudflare 现值回答；nxdomain 查无此域名；unreachable 三家解析器都连不上 */
  doh?: 'echo' | 'nxdomain' | 'unreachable';
  /** 覆盖某族的解析答案（复现「解析到别的地址」） */
  dohAnswer?: Partial<Record<'A' | 'AAAA', string[]>>;
}

/** Cloudflare API + 公共解析器（DoH）stub：记录读写与解析答案都跟着 stub 内部状态走 */
function cfStub(opts: StubOpts = {}) {
  const calls: CfCall[] = [];
  const store = new Map<'A' | 'AAAA', { id: string; content: string }>();
  for (const r of opts.records || []) {
    const type: 'A' | 'AAAA' = r.type || (r.content.includes(':') ? 'AAAA' : 'A');
    if (!store.has(type)) store.set(type, { id: r.id, content: r.content });
  }
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    const u = String(url);
    if (u.includes('/zones?name=')) {
      const name = decodeURIComponent(u.split('name=')[1]);
      if (opts.zone && name === opts.zone) return jsonResponse({ success: true, result: [{ id: 'zone-1' }] });
      return jsonResponse({ success: true, result: [] });
    }
    // zone 详情（status / NS）：列表与详情都不带 /dns_records
    if (u.includes('/zones/') && !u.includes('/dns_records')) {
      return jsonResponse({
        success: true,
        result: {
          id: 'zone-1',
          name: opts.zone || 'xxx.com',
          status: opts.zoneStatus || 'active',
          name_servers: opts.zoneNameServers || [],
          original_name_servers: opts.registrarNameServers || [],
        },
      });
    }
    if (u.includes('/dns_records') && method === 'GET') {
      const type = new URL(u).searchParams.get('type') as 'A' | 'AAAA' | null;
      const rec = type ? store.get(type) : undefined;
      return jsonResponse({ success: true, result: rec ? [rec] : [] });
    }
    if (u.includes('/dns_records') && (method === 'PUT' || method === 'POST')) {
      const type = String(body?.type) as 'A' | 'AAAA';
      const id = method === 'POST' ? `new-${type}` : (store.get(type)?.id || 'rec-1');
      store.set(type, { id, content: String(body?.content) });
      return jsonResponse({ success: true, result: { id } });
    }
    // 公共解析器（DoH JSON）：外网看到的答案
    if (u.includes('cloudflare-dns.com') || u.includes('dns.alidns.com') || u.includes('dns.google')) {
      if (opts.doh === 'unreachable') return jsonResponse({}, 503);
      const type = new URL(u).searchParams.get('type') as 'A' | 'AAAA';
      if (opts.doh === 'nxdomain') return jsonResponse({ Status: 3, Answer: [] });
      // 域名没生效（zone 非 active）时外网本来就查不到——这是真实世界的答案，不是「解析器坏了」
      if (opts.zoneStatus && opts.zoneStatus !== 'active') return jsonResponse({ Status: 3, Answer: [] });
      const current = store.get(type);
      const answers = opts.dohAnswer?.[type] ?? (current ? [current.content] : []);
      if (!answers.length) return jsonResponse({ Status: 3, Answer: [] });
      return jsonResponse({
        Status: 0,
        Answer: answers.map((data) => ({ name: 'home.xxx.com', type: type === 'AAAA' ? 28 : 1, data })),
      });
    }
    return jsonResponse({ success: false, errors: [{ message: `unexpected ${method} ${u}` }] }, 500);
  };
  return { calls, fetchImpl };
}

const baseCfg: DdnsConfig = {
  enabled: true,
  token: 'tok',
  record: 'home.xxx.com',
  type: 'AAAA',
  intervalMin: 5,
};

after(async () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

// ---------- 地址解析 ----------

describe('parseWindowsIpconfig', () => {
  test('zh 输出：稳定/临时分类正确，排除网关/DNS/链路本地', () => {
    const r = parseWindowsIpconfig(IPCONFIG_ZH);
    assert.deepEqual(r.stable, [
      '2001:db8:5400:feb0::abd',
      '2001:db8:5400:feb0:7226:d527:175f:b42b',
    ]);
    assert.deepEqual(r.temporary, ['2001:db8:5400:feb0:192b:a826:47d5:47ac']);
  });

  test('en 输出：Temporary 行排除，网关延续行不误收', () => {
    const r = parseWindowsIpconfig(IPCONFIG_EN);
    assert.deepEqual(r.stable, ['2001:db8:0:f101::5']);
    assert.deepEqual(r.temporary, ['2001:db8:0:f101:9:1']);
  });
});

describe('parseLinuxIfInet6', () => {
  test('仅保留 global 非临时非 tentative 地址', () => {
    assert.deepEqual(parseLinuxIfInet6(PROC_INET6), ['2001:0db8:0540:feb0:0000:0000:0000:0abd']);
  });
});

describe('normIp', () => {
  test('展开 :: 与前导零，大小写与 zone 后缀归一', () => {
    assert.equal(normIp('2001:db8:5400:FEB0::ABD%17'), '2001:0db8:5400:feb0:0000:0000:0000:0abd');
    assert.equal(normIp('2001:db8:5400:feb0::abd'), '2001:0db8:5400:feb0:0000:0000:0000:0abd');
    assert.equal(normIp('1:2:3:4:5:6:7:8'), '0001:0002:0003:0004:0005:0006:0007:0008');
    assert.equal(normIp('1.2.3.4'), '1.2.3.4');
  });
});

// ---------- Cloudflare 同步 ----------

describe('syncDdnsRecord', () => {
  test('指向一致 → unchanged，不写入', async () => {
    const { calls, fetchImpl } = cfStub({
      zone: 'xxx.com',
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0::abd' }],
    });
    const r = await syncDdnsRecord(baseCfg, {
      fetchImpl,
      detectCandidates: async () => ['2001:db8:5400:feb0::abd'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, 'unchanged');
    assert.equal(r.type, 'AAAA');
    assert.ok(!calls.some((c) => c.method === 'PUT' || c.method === 'POST'));
  });

  test('现值是候选之一时优先沿用（多候选不抖动）', async () => {
    const { calls, fetchImpl } = cfStub({
      zone: 'xxx.com',
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0:7226:d527:175f:b42b' }],
    });
    const r = await syncDdnsRecord(baseCfg, {
      fetchImpl,
      detectCandidates: async () => [
        '2001:db8:5400:feb0::abd',
        '2001:db8:5400:feb0:7226:d527:175f:b42b',
      ],
    });
    assert.equal(r.outcome, 'unchanged');
    assert.ok(!calls.some((c) => c.method === 'PUT'));
  });

  test('IP 变化 → PUT 更新（TTL 60、仅 DNS）', async () => {
    const { calls, fetchImpl } = cfStub({
      zone: 'xxx.com',
      records: [{ id: 'rec-9', content: '2001:db8:5400:feb0::old' }],
    });
    const r = await syncDdnsRecord(baseCfg, {
      fetchImpl,
      detectCandidates: async () => ['2001:db8:5400:feb0::abd'],
    });
    assert.equal(r.outcome, 'updated');
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put);
    assert.ok(put.url.includes('/dns_records/rec-9'));
    assert.equal((put.body as { content: string }).content, '2001:db8:5400:feb0::abd');
    assert.equal((put.body as { proxied: boolean }).proxied, false);
    assert.equal((put.body as { ttl: number }).ttl, 60);
  });

  test('记录不存在 → POST 创建', async () => {
    const { calls, fetchImpl } = cfStub({ zone: 'xxx.com', records: [] });
    const r = await syncDdnsRecord({ ...baseCfg, type: 'A' }, {
      fetchImpl,
      detectCandidates: async () => ['192.168.1.101'],
    });
    assert.equal(r.outcome, 'created');
    assert.equal(r.type, 'A');
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post);
    assert.equal((post.body as { content: string }).content, '192.168.1.101');
  });

  test('dryRun 探测到差异 → needs-update 且不写入', async () => {
    const { calls, fetchImpl } = cfStub({
      zone: 'xxx.com',
      records: [{ id: 'rec-9', content: '2001:db8:5400:feb0::old' }],
    });
    const r = await syncDdnsRecord(baseCfg, {
      fetchImpl,
      detectCandidates: async () => ['2001:db8:5400:feb0::abd'],
      dryRun: true,
    });
    assert.equal(r.outcome, 'needs-update');
    assert.ok(!calls.some((c) => c.method === 'PUT' || c.method === 'POST'));
  });

  test('auto：A 与 AAAA 两条都维护（只留 AAAA 时纯 IPv4 访客连解析都拿不到地址）', async () => {
    const { fetchImpl } = cfStub({ zone: 'xxx.com', records: [] });
    const r6 = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? ['2001:db8:5400:feb0::abd'] : []),
    });
    assert.deepEqual(r6.types, ['AAAA'], '没有 IPv4 候选就只维护 AAAA');
    assert.equal(r6.type, 'AAAA');
    assert.equal(r6.outcome, 'created');
    assert.equal(r6.families.find((f) => f.type === 'A')?.outcome, 'skipped');

    const r4 = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? [] : ['1.2.3.4']),
    });
    assert.deepEqual(r4.types, ['A']);
    assert.equal(r4.type, 'A');
  });

  test('无候选 → error 带提示', async () => {
    const { fetchImpl } = cfStub({ zone: 'xxx.com', records: [] });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => [] });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /未探测到/);
  });

  test('CF 写入失败 → error 带原因', async () => {
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method || 'GET').toUpperCase();
      if (String(url).includes('/zones?name=')) return jsonResponse({ success: true, result: [{ id: 'z' }] });
      if (method === 'GET') return jsonResponse({ success: true, result: [{ id: 'r', content: '::1' }] });
      return jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 403);
    };
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2408::1'] });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /Authentication error/);
  });
});

// ---------- 配置解析 ----------

describe('getDdnsConfig', () => {
  test('DB 配置优先，空字段回退 env，缺省 enabled 由完整性推导', () => {
    migrate();
    setSetting('ddns_config', JSON.stringify({ enabled: true, token: 'tok-db', record: 'A.xxx.com.', type: 'a', intervalMin: 10 }));
    const cfg = getDdnsConfig();
    assert.equal(cfg.token, 'tok-db');
    assert.equal(cfg.record, 'a.xxx.com');
    assert.equal(cfg.type, 'A');
    assert.equal(cfg.intervalMin, 10);
    assert.equal(cfg.enabled, true);

    setSetting('ddns_config', JSON.stringify({ token: 'tok-db' }));
    const cfg2 = getDdnsConfig();
    assert.equal(cfg2.record, '');       // env 未设置 → 空
    assert.equal(cfg2.enabled, false);   // 配置不完整 → 未启用
    assert.equal(cfg2.type, 'auto');
    assert.equal(cfg2.intervalMin, 5);
  });

  test('clampInterval 非法值回退默认', () => {
    assert.equal(clampInterval(0), 5);
    assert.equal(clampInterval(-3), 5);
    assert.equal(clampInterval('abc'), 5);
    assert.equal(clampInterval(2.9), 2);
  });

  test('normalizeRecord：粘浏览器地址 / 带端口 / 尾点都能归一化成纯 FQDN', () => {
    assert.equal(normalizeRecord('  HTTPS://Home.xxx.com/  '), 'home.xxx.com');
    assert.equal(normalizeRecord('https://home.xxx.com/path?x=1#y'), 'home.xxx.com');
    assert.equal(normalizeRecord('home.xxx.com:18080'), 'home.xxx.com');
    assert.equal(normalizeRecord('a.b.xxx.com...'), 'a.b.xxx.com');
    assert.equal(normalizeRecord(''), '');
  });
});

// ---------- 一键配置的第一步：Token 校验与域名列举 ----------

describe('verifyCloudflareToken / listCloudflareZones', () => {
  test('Token 有效 → ok；无效 → 带 Cloudflare 给的原因；网络失败 → 带原始错误', async () => {
    const okFetch = async () => jsonResponse({ success: true, result: { status: 'active' } });
    assert.deepEqual(await verifyCloudflareToken('t', okFetch), { ok: true });

    const badFetch = async () => jsonResponse({ success: false, errors: [{ message: 'Invalid API Token' }] });
    const bad = await verifyCloudflareToken('t', badFetch);
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? '' : bad.error, /Invalid API Token/);

    const http500 = async () => jsonResponse({}, 500);
    const http = await verifyCloudflareToken('t', http500);
    assert.equal(http.ok, false);
    assert.match(http.ok ? '' : http.error, /HTTP 500/);

    const netErr = async () => { throw new Error('fetch failed'); };
    const net = await verifyCloudflareToken('t', netErr);
    assert.equal(net.ok, false);
    assert.match(net.ok ? '' : net.error, /fetch failed/);
  });

  test('域名列举：返回 {id,name}；空列表=「还没域名」、API 拒绝=「权限」——两种要分得开', async () => {
    const zonesFetch = async () =>
      jsonResponse({ success: true, result: [{ id: 'z1', name: 'xxx.com' }, { id: 'z2', name: 'yyy.net' }] });
    const ok = await listCloudflareZones('t', zonesFetch);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok ? ok.zones : [], [{ id: 'z1', name: 'xxx.com' }, { id: 'z2', name: 'yyy.net' }]);

    // 空列表：Token 是好的、请求也成功，只是账号下没有域名——客户还没买域名
    const empty = await listCloudflareZones('t', async () => jsonResponse({ success: true, result: [] }));
    assert.equal(empty.ok, false);
    assert.equal(empty.ok ? '' : empty.code, 'no-domain');
    assert.match(empty.ok ? '' : empty.error, /还没有任何域名/);
    assert.match(empty.ok ? '' : empty.error, /购买|买一个/, '要明确告诉客户域名得自己买');
    assert.doesNotMatch(empty.ok ? '' : empty.error, /权限/, '没域名不能报成权限问题');

    const denied = await listCloudflareZones('t', async () =>
      jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }));
    assert.equal(denied.ok, false);
    assert.equal(denied.ok ? '' : denied.code, 'permission');
    assert.match(denied.ok ? '' : denied.error, /Authentication error/);
    assert.match(denied.ok ? '' : denied.error, /Zone → Zone → Read/, '指出该补哪个权限');

    const forbidden = await listCloudflareZones('t', async () => jsonResponse({}, 403));
    assert.equal(forbidden.ok ? '' : (forbidden as { code?: string }).code, 'permission');

    const broken = await listCloudflareZones('t', async () => jsonResponse({}, 500));
    assert.equal(broken.ok ? '' : (broken as { code?: string }).code, 'network');

    const offline = await listCloudflareZones('t', async () => { throw new Error('fetch failed'); });
    assert.equal(offline.ok ? '' : (offline as { code?: string }).code, 'network');
  });

  test('setDdnsFetchForTest 接管「没显式传 fetchImpl」的调用（接口层就是这么调的）', async () => {
    setDdnsFetchForTest(async () => jsonResponse({ success: true, result: [{ id: 'z9', name: 'probe.dev' }] }));
    try {
      const r = await listCloudflareZones('t');
      assert.equal(r.ok, true);
      assert.deepEqual(r.ok ? r.zones : [], [{ id: 'z9', name: 'probe.dev' }]);
    } finally {
      setDdnsFetchForTest(null);
    }
  });
});

// ---------- 真实性核验：zone 生效状态 + 公共解析（假绿灯的根治点） ----------

describe('syncDdnsRecord · zone 生效状态', () => {
  test('zone 还是 pending（NS 没切）→ zone-pending：不亮绿灯，直接说清去注册商改哪两条 NS', async () => {
    const { fetchImpl } = cfStub({
      zone: 'xxx.com',
      zoneStatus: 'pending',
      zoneNameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      registrarNameServers: ['launch1.spaceship.net', 'launch2.spaceship.net'],
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0::abd' }],
    });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.outcome, 'zone-pending');
    assert.equal(r.live, false);
    assert.equal(r.ok, true, '记录同步本身没出错：写还是写进去了');
    assert.equal(r.zone?.status, 'pending');
    assert.match(r.hint || '', /launch1\.spaceship\.net/);
    assert.match(r.hint || '', /ada\.ns\.cloudflare\.com/);
    // 域名没生效时外网一定是查不到的（stub 按真实行为回 NXDOMAIN）：逐族也要如实标成 false
    assert.equal(r.families[0].live, false);
    assert.deepEqual(r.families[0].resolved, []);
  });

  test('zone active + 公共解析确认 → live=true（绿灯的唯一依据）', async () => {
    const { fetchImpl } = cfStub({
      zone: 'xxx.com',
      zoneStatus: 'active',
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0::abd' }],
    });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.outcome, 'unchanged');
    assert.equal(r.live, true);
    assert.equal(r.resolver, 'Cloudflare 1.1.1.1');
    assert.equal(r.families[0].live, true);
  });

  test('zone active 但公共解析查不到 → not-published（API 写入成功 ≠ 外网能用）', async () => {
    const { fetchImpl } = cfStub({
      zone: 'xxx.com',
      zoneStatus: 'active',
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0::abd' }],
      doh: 'nxdomain',
    });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.outcome, 'not-published');
    assert.equal(r.live, false);
    assert.match(r.hint || '', /NXDOMAIN/);
  });

  test('解析到别的地址 → not-published 并列出实际答案', async () => {
    const { fetchImpl } = cfStub({
      zone: 'xxx.com',
      zoneStatus: 'active',
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0::abd' }],
      dohAnswer: { AAAA: ['2001:db8:5400:feb0::old'] },
    });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.outcome, 'not-published');
    assert.equal(r.live, false);
    assert.deepEqual(r.families[0].resolved, ['2001:db8:5400:feb0::old']);
  });

  test('刚写入的记录还没解析到 → propagating（不误报成故障）', async () => {
    const { fetchImpl } = cfStub({ zone: 'xxx.com', zoneStatus: 'active', records: [], doh: 'nxdomain' });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.outcome, 'propagating');
    assert.equal(r.live, false);
  });

  test('公共解析器都不可达 → live=null：显示「未能核验」，不判死', async () => {
    const { fetchImpl } = cfStub({
      zone: 'xxx.com',
      zoneStatus: 'active',
      records: [{ id: 'rec-1', content: '2001:db8:5400:feb0::abd' }],
      doh: 'unreachable',
    });
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.outcome, 'unchanged');
    assert.equal(r.live, null);
    assert.match(r.hint || '', /未能核验|不可达/);
  });

  test('zone 详情查不到（API 抖动）→ 不据此判定域名失效', async () => {
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method || 'GET').toUpperCase();
      const u = String(url);
      if (u.includes('/zones?name=')) return jsonResponse({ success: true, result: [{ id: 'zone-1' }] });
      if (u.includes('/zones/') && !u.includes('/dns_records')) return jsonResponse({ success: false }, 500);
      if (u.includes('/dns_records') && method === 'GET') {
        return jsonResponse({ success: true, result: [{ id: 'r', content: '2001:db8:5400:feb0::abd' }] });
      }
      if (u.includes('cloudflare-dns.com')) {
        return jsonResponse({ Status: 0, Answer: [{ type: 28, data: '2001:db8:5400:feb0::abd' }] });
      }
      return jsonResponse({ success: false, errors: [{ message: 'unexpected' }] }, 500);
    };
    const r = await syncDdnsRecord(baseCfg, { fetchImpl, detectCandidates: async () => ['2001:db8:5400:feb0::abd'] });
    assert.equal(r.zone, null);
    assert.equal(r.outcome, 'unchanged');
    assert.equal(r.live, true, 'zone 未知不影响公共解析的核验结论');
  });
  test('域名已被 CNAME 占用（多为 Cloudflare 隧道）→ 说清「两者只留一个」，别让用户猜写入为什么失败', async () => {
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method || 'GET').toUpperCase();
      const u = String(url);
      if (u.includes('/zones?name=')) return jsonResponse({ success: true, result: [{ id: 'zone-1' }] });
      if (u.includes('/zones/') && !u.includes('/dns_records')) {
        return jsonResponse({ success: true, result: { id: 'zone-1', name: 'xxx.com', status: 'active' } });
      }
      if (u.includes('/dns_records') && method === 'GET') return jsonResponse({ success: true, result: [] });
      if (u.includes('/dns_records')) {
        return jsonResponse(
          { success: false, errors: [{ message: 'A CNAME record with that host already exists. (Code: 81053)' }] },
          400,
        );
      }
      return jsonResponse({ success: false, errors: [{ message: 'unexpected' }] }, 500);
    };
    const r = await syncDdnsRecord({ ...baseCfg, type: 'A' }, {
      fetchImpl,
      detectCandidates: async () => ['1.2.3.4'],
    });
    assert.equal(r.outcome, 'error');
    assert.match(r.error || '', /CNAME/);
    assert.match(r.hint || '', /隧道/);
    assert.match(r.hint || '', /只留一个/);
  });
});

describe('syncDdnsRecord · auto 双栈', () => {
  test('两族都有候选 → A 与 AAAA 都写进 Cloudflare', async () => {
    const { calls, fetchImpl } = cfStub({ zone: 'xxx.com', records: [] });
    const r = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? ['2001:db8:5400:feb0::abd'] : ['1.2.3.4']),
    });
    assert.deepEqual(r.types, ['AAAA', 'A']);
    assert.equal(r.outcome, 'created');
    assert.equal(r.live, true, '两条都能被公共解析器查到');
    const posted = calls.filter((c) => c.method === 'POST').map((c) => String((c.body as { type: unknown }).type)).sort();
    assert.deepEqual(posted, ['A', 'AAAA']);
  });

  test('某一族探不到：不动旧记录，也不误报失败', async () => {
    const { calls, fetchImpl } = cfStub({
      zone: 'xxx.com',
      records: [
        { id: 'rec-6', content: '2001:db8:5400:feb0::old' },
        { id: 'rec-4', content: '1.2.3.4' },
      ],
    });
    const r = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? [] : ['1.2.3.4']),
    });
    const v6 = r.families.find((f) => f.type === 'AAAA');
    assert.equal(v6?.outcome, 'skipped');
    assert.equal(v6?.dnsIp, '2001:db8:5400:feb0::old', '旧 AAAA 记录保持原样');
    assert.deepEqual(r.types, ['A']);
    assert.equal(r.outcome, 'unchanged');
    assert.ok(!calls.some((c) => c.method === 'PUT' || c.method === 'POST'));
  });

  test('双栈：IPv4 变化只改 A，AAAA 不动', async () => {
    const { calls, fetchImpl } = cfStub({
      zone: 'xxx.com',
      records: [
        { id: 'rec-6', content: '2001:db8:5400:feb0::abd' },
        { id: 'rec-4', content: '1.2.3.4' },
      ],
    });
    const r = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? ['2001:db8:5400:feb0::abd'] : ['5.6.7.8']),
    });
    assert.equal(r.outcome, 'updated');
    const put = calls.filter((c) => c.method === 'PUT');
    assert.equal(put.length, 1);
    assert.ok(put[0].url.includes('/dns_records/rec-4'));
    assert.equal(r.live, true);
    assert.equal(r.families.find((f) => f.type === 'AAAA')?.outcome, 'unchanged');
  });
});

describe('parseDohAnswers', () => {
  test('Status 3=NXDOMAIN；只收目标族的地址；尾点归一', () => {
    assert.deepEqual(parseDohAnswers({ Status: 3 }, 'AAAA'), { status: 'NXDOMAIN', ips: [] });
    assert.deepEqual(parseDohAnswers({ Status: 0, Answer: [] }, 'A'), { status: 'NOERROR', ips: [] });
    const r = parseDohAnswers(
      {
        Status: 0,
        Answer: [
          { type: 28, data: '2001:db8:5400:feb0::1' },
          { type: 1, data: '1.2.3.4' },
          { type: 5, data: 'hub.example.com.' },
        ],
      },
      'A',
    );
    assert.deepEqual(r, { status: 'NOERROR', ips: ['1.2.3.4'] });
  });
});
