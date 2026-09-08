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
  normIp,
  parseLinuxIfInet6,
  parseWindowsIpconfig,
  syncDdnsRecord,
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

/** Cloudflare API stub：zones 查找 + 记录读写，并记录调用 */
function cfStub(opts: { zone?: string | null; records?: Array<{ id: string; content: string }> }) {
  const calls: CfCall[] = [];
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
    if (u.includes('/dns_records') && method === 'GET') {
      return jsonResponse({ success: true, result: opts.records || [] });
    }
    if (u.includes('/dns_records') && (method === 'PUT' || method === 'POST')) {
      return jsonResponse({ success: true, result: { id: method === 'POST' ? 'new-1' : (opts.records?.[0]?.id || 'rec-1') } });
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

  test('auto：有 IPv6 候选选 AAAA；无则回退 A', async () => {
    const { fetchImpl } = cfStub({ zone: 'xxx.com', records: [] });
    const r6 = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? ['2001:db8:5400:feb0::abd'] : []),
    });
    assert.equal(r6.type, 'AAAA');
    assert.equal(r6.outcome, 'created');

    const r4 = await syncDdnsRecord({ ...baseCfg, type: 'auto' }, {
      fetchImpl,
      detectCandidates: async (t) => (t === 'AAAA' ? [] : ['1.2.3.4']),
    });
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
});
