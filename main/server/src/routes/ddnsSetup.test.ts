import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * DDNS「一键配置」路由测试：
 *  - 中枢守卫：非中枢设备连 discover / setup 都不许调（UI 已隐藏，API 也拦）
 *  - discover：校验 Token → 列出可维护域名（Cloudflare 全程用注入 stub，不出网）
 *  - setup：探测失败默认不落库；force 才保存；成功时配置写进 settings 且结构正确
 *
 * IP 探测也走同一份 stub（api.ipify.org 回 1.2.3.4），因此类型固定用 A，结果可预期。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ddns-setup-'));
process.env.DATA_DIR = temp;

const API_TOKEN = `lwiki_${'d'.repeat(24)}`;

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import('../lib/db.js');
let setDdnsFetchForTest: (fn: ((url: string, init?: RequestInit) => Promise<Response>) | null) => void;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** 成功的 Cloudflare + 公网 IP 回声 stub */
function happyFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = (init?.method || 'GET').toUpperCase();
    const u = String(url);
    if (u.includes('api.ipify.org')) return textResponse('1.2.3.4');
    if (u.includes('/user/tokens/verify')) return jsonResponse({ success: true, result: { status: 'active' } });
    if (u.includes('/zones?per_page=')) return jsonResponse({ success: true, result: [{ id: 'zone-1', name: 'xxx.com' }] });
    if (u.includes('/zones?name=')) {
      const name = decodeURIComponent(u.split('name=')[1]);
      return jsonResponse({ success: true, result: name === 'xxx.com' ? [{ id: 'zone-1' }] : [] });
    }
    // zone 详情（status / NS）：同步流程用它判断「域名到底生效没有」
    if (u.includes('/zones/') && !u.includes('/dns_records')) {
      return jsonResponse({
        success: true,
        result: {
          id: 'zone-1',
          name: 'xxx.com',
          status: 'active',
          name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
          original_name_servers: [],
        },
      });
    }
    if (u.includes('/dns_records') && method === 'GET') return jsonResponse({ success: true, result: [] });
    if (u.includes('/dns_records') && method === 'POST') return jsonResponse({ success: true, result: { id: 'new-1' } });
    return jsonResponse({ success: false, errors: [{ message: `unexpected ${method} ${u}` }] }, 500);
  };
}

/** Cloudflare 拒绝（Token 没权限）的 stub：列举走 200+success:false，zone 查询走 403（两种真实形态都覆盖） */
function deniedFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url) => {
    const u = String(url);
    if (u.includes('api.ipify.org')) return textResponse('1.2.3.4');
    if (u.includes('/user/tokens/verify')) return jsonResponse({ success: true, result: { status: 'active' } });
    if (u.includes('/zones?per_page=')) return jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] });
    if (u.includes('/zones')) return jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 403);
    return jsonResponse({ success: false, errors: [{ message: 'unexpected' }] }, 500);
  };
}

/** 域名还没生效（注册局 NS 没切到 Cloudflare）的 stub：zone 详情报 pending，并给出双方 NS */
function pendingZoneFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  const base = happyFetch();
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/zones/') && !u.includes('/dns_records')) {
      return jsonResponse({
        success: true,
        result: {
          id: 'zone-1',
          name: 'xxx.com',
          status: 'pending',
          name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
          original_name_servers: ['launch1.spaceship.net', 'launch2.spaceship.net'],
        },
      });
    }
    return base(url, init);
  };
}

function post(url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${API_TOKEN}` },
    payload,
  });
}

before(async () => {
  dbModule = await import('../lib/db.js');
  dbModule.migrate();
  dbModule.db
    .prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
    .run(API_TOKEN, 'ddns-route-test', '2026-01-01 00:00:00');
  ({ setDdnsFetchForTest } = await import('../lib/ddns.js'));
  const { settingsRoutes } = await import('./settings.js');
  app = Fastify();
  await app.register(jwt, { secret: 'ddns-test-secret' });
  await app.register(settingsRoutes);
  await app.ready();
});

after(async () => {
  setDdnsFetchForTest?.(null);
  try { await app.close(); } catch { /* 已关闭 */ }
  try { dbModule?.db.close(); } catch { /* 已关闭 */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('非中枢设备：discover 与 setup 都被拦下（400）', async () => {
  dbModule.setSetting('sync_role', 'member');
  const d = await post('/api/settings/ddns/discover', { token: 'tok' });
  assert.equal(d.statusCode, 400);
  assert.match(d.json().error, /仅中枢设备/);

  const s = await post('/api/settings/ddns/setup', { token: 'tok', record: 'home.xxx.com', type: 'a' });
  assert.equal(s.statusCode, 400);
  assert.match(s.json().error, /仅中枢设备/);

  dbModule.setSetting('sync_role', 'none');
  const n = await post('/api/settings/ddns/discover', { token: 'tok' });
  assert.equal(n.statusCode, 400);
});

test('中枢 + 有效 Token：discover 列出域名，缺 Token 时 400', async () => {
  dbModule.setSetting('sync_role', 'hub');
  setDdnsFetchForTest(happyFetch());

  const empty = await post('/api/settings/ddns/discover', {});
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /Token/);

  const ok = await post('/api/settings/ddns/discover', { token: 'cf-token' });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as { ok: boolean; zones: Array<{ id: string; name: string }> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.zones, [{ id: 'zone-1', name: 'xxx.com' }]);
});

test('中枢 + Token 无权限：discover 返回 ok=false 与原因', async () => {
  dbModule.setSetting('sync_role', 'hub');
  setDdnsFetchForTest(deniedFetch());
  const res = await post('/api/settings/ddns/discover', { token: 'cf-token' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; code: string; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'permission');
  assert.match(body.error, /Authentication error/);
});

test('Token 有效但账号下没有域名：discover 报「还没有域名」，不能报成权限不足', async () => {
  dbModule.setSetting('sync_role', 'hub');
  setDdnsFetchForTest(async (url) => {
    const u = String(url);
    if (u.includes('/user/tokens/verify')) return jsonResponse({ success: true, result: { status: 'active' } });
    if (u.includes('/zones?per_page=')) return jsonResponse({ success: true, result: [] });
    return jsonResponse({ success: false, errors: [{ message: `unexpected ${u}` }] }, 500);
  });
  const res = await post('/api/settings/ddns/discover', { token: 'cf-token' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; code: string; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'no-domain', '界面靠这个 code 醒目标出「先去买域名」');
  assert.match(body.error, /还没有任何域名/);
  assert.doesNotMatch(body.error, /权限/, '别把没域名说成权限问题');
});

test('Token 本身无效：discover 用 code=token 区分于「没域名」', async () => {
  dbModule.setSetting('sync_role', 'hub');
  setDdnsFetchForTest(async (url) => {
    const u = String(url);
    if (u.includes('/user/tokens/verify')) {
      return jsonResponse({ success: false, errors: [{ message: 'Invalid API Token' }] });
    }
    return jsonResponse({ success: false, errors: [{ message: `unexpected ${u}` }] }, 500);
  });
  const res = await post('/api/settings/ddns/discover', { token: 'bad-token' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; code: string; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'token');
  assert.match(body.error, /Invalid API Token/);
});

test('setup：检测失败默认不落库，force 才保存', async () => {
  dbModule.setSetting('sync_role', 'hub');
  dbModule.setSetting('ddns_config', '');
  setDdnsFetchForTest(deniedFetch());

  const denied = await post('/api/settings/ddns/setup', { token: 'cf-token', record: 'home.xxx.com', type: 'a' });
  assert.equal(denied.statusCode, 400);
  assert.match(denied.json().error, /HTTP 403/);
  assert.equal(dbModule.getSetting('ddns_config'), '', '检测失败时不应写入配置');

  const forced = await post('/api/settings/ddns/setup', {
    token: 'cf-token',
    record: 'home.xxx.com',
    type: 'a',
    force: true,
  });
  assert.equal(forced.statusCode, 200);
  assert.equal((forced.json() as { saved: boolean }).saved, true);
  const raw = JSON.parse(dbModule.getSetting('ddns_config') || '{}') as Record<string, unknown>;
  assert.equal(raw.enabled, true);
  assert.equal(raw.record, 'home.xxx.com');
  assert.equal(raw.type, 'a');
});

test('setup：一次调用完成探测并落库（记录不存在 → 待创建）', async () => {
  dbModule.setSetting('sync_role', 'hub');
  dbModule.setSetting('ddns_config', '');
  setDdnsFetchForTest(happyFetch());

  const res = await post('/api/settings/ddns/setup', {
    token: 'cf-token',
    record: 'https://Home.xxx.com./',
    type: 'a',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ok: boolean;
    saved: boolean;
    record: string;
    type: string;
    types: string[];
    detectedIp: string;
    outcome: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.saved, true);
  assert.equal(body.record, 'home.xxx.com', '域名应归一化（去协议、去尾点、小写）');
  assert.equal(body.type, 'A');
  assert.deepEqual(body.types, ['A'], '只指定 A 时就只维护 A');
  assert.equal(body.detectedIp, '1.2.3.4');
  assert.equal(body.outcome, 'needs-update');

  const raw = JSON.parse(dbModule.getSetting('ddns_config') || '{}') as Record<string, unknown>;
  assert.equal(raw.record, 'home.xxx.com');
  assert.equal(raw.type, 'a');
  assert.equal(raw.enabled, true);
  assert.equal(raw.intervalMin, 5);
});

test('域名未生效（NS 没切到 Cloudflare）→ 配置照样保存，但状态是 zone-pending 并附处置建议', async () => {
  dbModule.setSetting('sync_role', 'hub');
  dbModule.setSetting('ddns_config', '');
  setDdnsFetchForTest(pendingZoneFetch());

  const res = await post('/api/settings/ddns/setup', { token: 'cf-token', record: 'home.xxx.com', type: 'a' });
  assert.equal(res.statusCode, 200, '域名没生效不该拦住「先配好」这件事');
  const body = res.json() as {
    ok: boolean;
    saved: boolean;
    outcome: string;
    live: boolean | null;
    zone: { status: string } | null;
    hint: string;
    types: string[];
  };
  assert.equal(body.saved, true);
  assert.equal(body.outcome, 'zone-pending');
  assert.equal(body.live, false);
  assert.equal(body.zone?.status, 'pending');
  assert.match(body.hint, /launch1\.spaceship\.net/, '要告诉用户注册局现在用的是哪两条 NS');
  assert.match(body.hint, /ada\.ns\.cloudflare\.com/, '也要给出该换成哪两条');
  assert.deepEqual(body.types, ['A'], '显式指定 A 时就只维护 A');

  const raw = JSON.parse(dbModule.getSetting('ddns_config') || '{}') as Record<string, unknown>;
  assert.equal(raw.enabled, true);
  assert.equal(raw.record, 'home.xxx.com');
});

test('ddns-status：状态里带上「到底能不能用」的字段（live / zone / 逐族明细 / 建议）', async () => {
  setDdnsFetchForTest(happyFetch());
  const res = await app.inject({
    method: 'GET',
    url: '/api/settings/ddns-status',
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: Record<string, unknown> };
  assert.ok('live' in body.status, '界面要靠 live 判断是否亮绿灯');
  assert.ok('zone' in body.status);
  assert.ok(Array.isArray(body.status.families));
  assert.ok('hint' in body.status);
  assert.deepEqual(body.status.lastTypes, []);
});
