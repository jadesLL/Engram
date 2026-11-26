import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 飞书多维表格同步执行器：拉表 → 渲染 → 写原始资料 的完整链路（不联网）。
 *
 * 锁住：
 *  1) 首次拉取在 原始资料/文档/飞书多维表格/ 下新建 Markdown，内容带来源标记与表格行；
 *  2) 内容没变时不重写文件（不把「已提炼」打回待办、不改 frontmatter 更新时间）；
 *  3) 内容变化时覆盖同一份文件并更新记录数；
 *  4) 飞书报权限错误时落 lastError，状态为 error，不写坏文件。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-feishu-sync-'));
process.env.DATA_DIR = temp;

const FIXED_NOW = 1_764_000_000_000;

let db: any;
let syncModule: typeof import('./feishuBitableSync.js');
let configModule: typeof import('./feishuBitableConfig.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface StubTables {
  appName?: string;
  tableName?: string;
  records: Array<Record<string, unknown>>;
  failCode?: number;
}

/** 飞书 Open API 的 fetch 桩：token → tables → fields → records */
function stubFetch(options: StubTables): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('tenant_access_token')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-test', expire: 7200 });
    }
    if (url.includes('/bitable/v1/apps/') && !url.includes('/tables')) {
      return jsonResponse({ code: 0, data: { app: { name: options.appName ?? '销售管理' } } });
    }
    if (url.includes('/tables?')) {
      return jsonResponse({
        code: 0,
        data: { items: [{ table_id: 'tblABC12', name: options.tableName ?? '客户台账' }] },
      });
    }
    if (url.includes('/fields?')) {
      return jsonResponse({
        code: 0,
        data: {
          items: [
            { field_id: 'f1', field_name: '客户名称', type: 1, is_primary: true },
            { field_id: 'f2', field_name: '阶段', type: 3 },
          ],
        },
      });
    }
    if (url.includes('/records?')) {
      if (options.failCode) return jsonResponse({ code: options.failCode, msg: 'no permission' });
      return jsonResponse({
        code: 0,
        data: {
          items: options.records.map((fields, index) => ({ record_id: `rec${index + 1}`, fields })),
        },
      });
    }
    return jsonResponse({ code: 999404, msg: `unexpected ${url}` });
  }) as typeof fetch;
}

before(async () => {
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  syncModule = await import('./feishuBitableSync.js');
  configModule = await import('./feishuBitableConfig.js');
});

after(async () => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function addSource() {
  const source = configModule.newFeishuSource({
    name: '客户台账',
    url: 'https://abc.feishu.cn/base/bascnABC12345?table=tblABC12',
    appToken: 'bascnABC12345',
    appName: '销售管理',
    tableId: 'tblABC12',
    origin: 'https://abc.feishu.cn',
    apiBase: 'https://open.feishu.cn',
    filePath: '原始资料/文档/飞书多维表格/客户台账.md',
  });
  syncModule.saveFeishuConfig({
    appId: 'cli_test',
    appSecret: 'secret',
    apiBase: 'https://open.feishu.cn',
    oauth: null,
    oauthRequired: false,
    sources: [source],
  });
  return source;
}

test('首次拉取：新建原始资料，表格内容与来源标记齐全', async () => {
  const source = addSource();
  const state = await syncModule.syncFeishuSource(source.id, {
    fetchImpl: stubFetch({
      records: [
        { 客户名称: '甲公司', 阶段: '洽谈中' },
        { 客户名称: '乙公司', 阶段: '已成交' },
      ],
    }),
    now: () => FIXED_NOW,
  });
  assert.equal(state.state, 'ok');
  assert.equal(state.recordCount, 2);

  const abs = path.join(temp, 'brain', source.filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  assert.match(raw, /标题: 客户台账/);
  assert.match(raw, /来源:/);
  assert.match(raw, /飞书多维表格/);
  assert.match(raw, /engram:feishu-bitable app=bascnABC12345 table=tblABC12/);
  assert.match(raw, /\| 客户名称 \| 阶段 \|/);
  assert.match(raw, /甲公司/);

  const config = syncModule.readFeishuConfig();
  assert.equal(config.sources[0].lastStatus, 'ok');
  assert.equal(config.sources[0].lastRecordCount, 2);
  assert.equal(config.sources[0].lastSyncAt, FIXED_NOW);
  assert.equal(config.sources[0].name, '客户台账');
});

test('内容没变：跳过写入，文件字节不变', async () => {
  const config = syncModule.readFeishuConfig();
  const source = config.sources[0];
  const abs = path.join(temp, 'brain', source.filePath);
  const beforeBytes = fs.readFileSync(abs, 'utf8');
  const state = await syncModule.syncFeishuSource(source.id, {
    fetchImpl: stubFetch({ records: [{ 客户名称: '甲公司', 阶段: '洽谈中' }, { 客户名称: '乙公司', 阶段: '已成交' }] }),
    now: () => FIXED_NOW + 60_000,
  });
  assert.equal(state.state, 'ok');
  assert.match(state.message, /内容无变化/);
  assert.equal(fs.readFileSync(abs, 'utf8'), beforeBytes, '内容一致时不应重写（更新日期也不该变）');
});

test('内容变化：覆盖同一份文件，记录数更新，并把旧的提炼标记打回待办', async () => {
  const config = syncModule.readFeishuConfig();
  const source = config.sources[0];
  // 模拟这份资料已经被提炼过：有一个 active 来源版本
  const ledger = await import('../pipeline/sourceLedger.js');
  const version = ledger.beginSourceVersion(source.filePath, 'hash-before-change');
  db.prepare(`UPDATE source_versions SET status='active' WHERE id=?`).run(version.id);
  assert.equal(ledger.isDistilledPath(source.filePath), true);

  const state = await syncModule.syncFeishuSource(source.id, {
    fetchImpl: stubFetch({
      records: [
        { 客户名称: '甲公司', 阶段: '已成交' },
        { 客户名称: '丙公司', 阶段: '接洽' },
        { 客户名称: '丁公司', 阶段: '报价' },
      ],
    }),
    now: () => FIXED_NOW + 120_000,
  });
  assert.equal(state.state, 'ok');
  assert.equal(state.recordCount, 3);
  const raw = fs.readFileSync(path.join(temp, 'brain', source.filePath), 'utf8');
  assert.match(raw, /丙公司/);
  assert.doesNotMatch(raw, /乙公司/);
  assert.equal(syncModule.readFeishuConfig().sources[0].lastRecordCount, 3);
  // 正文变了：旧版本转 superseded，重新进入待提炼（否则自动整理永远跳过新数据）
  assert.equal(ledger.isDistilledPath(source.filePath), false);
});

test('飞书权限不足：状态 error，lastError 给可执行提示，文件保持上一版', async () => {
  const config = syncModule.readFeishuConfig();
  const source = config.sources[0];
  const abs = path.join(temp, 'brain', source.filePath);
  const beforeBytes = fs.readFileSync(abs, 'utf8');
  const state = await syncModule.syncFeishuSource(source.id, {
    fetchImpl: stubFetch({ records: [], failCode: 99991672 }),
    now: () => FIXED_NOW + 180_000,
  });
  assert.equal(state.state, 'error');
  assert.match(state.message, /bitable:app:readonly/);
  assert.equal(fs.readFileSync(abs, 'utf8'), beforeBytes, '失败不应写坏已有资料');
  const updated = syncModule.readFeishuConfig().sources[0];
  assert.equal(updated.lastStatus, 'error');
  assert.match(updated.lastError, /协作者/);
  assert.equal(updated.lastSyncAt, FIXED_NOW + 120_000, '失败不推进最近成功时间');
});

/** 按 URL 路由的 fetch 桩（OAuth token / 数据接口混在一起时用） */
function routeFetch(handler: (call: { url: string; init?: RequestInit }) => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('OAuth 拉取：access token 过期自动 refresh，数据请求带新令牌', async () => {
  syncModule.updateFeishuConfig((config) => {
    config.oauth = {
      accessToken: 'u-old',
      refreshToken: 'r-old',
      expiresAt: FIXED_NOW - 1,
      refreshExpiresAt: FIXED_NOW + 86_400_000,
      grantedAt: FIXED_NOW - 7_200_000,
    };
  });
  const source = syncModule.readFeishuConfig().sources[0];
  const { fetchImpl, calls } = routeFetch((call) => {
    if (call.url.includes('/authen/v2/oauth/token')) {
      return jsonResponse({
        code: 0,
        access_token: 'u-new',
        expires_in: 7200,
        refresh_token: 'r-new',
        refresh_token_expires_in: 604800,
      });
    }
    if (call.url.includes('/tables?')) {
      return jsonResponse({ code: 0, data: { items: [{ table_id: 'tblABC12', name: '客户台账' }] } });
    }
    if (call.url.includes('/fields?')) {
      return jsonResponse({ code: 0, data: { items: [{ field_name: '客户名称', type: 1 }] } });
    }
    if (call.url.includes('/records?')) {
      return jsonResponse({ code: 0, data: { items: [{ record_id: 'r1', fields: { 客户名称: '甲公司' } }] } });
    }
    return jsonResponse({ code: 999404, msg: 'unexpected ' + call.url });
  });
  const state = await syncModule.syncFeishuSource(source.id, {
    fetchImpl,
    now: () => FIXED_NOW + 60_000,
  });
  assert.equal(state.state, 'ok');
  const refreshCall = calls.find((call) => call.url.includes('/authen/v2/oauth/token'));
  assert.ok(refreshCall);
  assert.equal(JSON.parse(String(refreshCall.init?.body)).grant_type, 'refresh_token');
  const recordCall = calls.find((call) => call.url.includes('/records?'));
  assert.ok(recordCall);
  assert.equal((recordCall.init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer u-new');
  const saved = syncModule.readFeishuConfig();
  assert.equal(saved.oauth?.accessToken, 'u-new');
  assert.equal(saved.oauth?.refreshToken, 'r-new');
});

test('OAuth 刷新令牌过期：报「重新授权」并清掉绑定，不写资料', async () => {
  syncModule.updateFeishuConfig((config) => {
    config.oauth = {
      accessToken: 'u-old',
      refreshToken: 'r-old',
      expiresAt: FIXED_NOW - 1,
      refreshExpiresAt: FIXED_NOW - 1,
      grantedAt: FIXED_NOW - 100_000_000,
    };
  });
  const source = syncModule.readFeishuConfig().sources[0];
  const abs = path.join(temp, 'brain', source.filePath);
  const beforeBytes = fs.readFileSync(abs, 'utf8');
  const state = await syncModule.syncFeishuSource(source.id, {
    fetchImpl: routeFetch(() => jsonResponse({ code: 0, data: {} })).fetchImpl,
    now: () => FIXED_NOW + 120_000,
  });
  assert.equal(state.state, 'error');
  assert.match(state.message, /重新授权/);
  assert.equal(fs.readFileSync(abs, 'utf8'), beforeBytes);
  const saved = syncModule.readFeishuConfig();
  assert.equal(saved.oauth, null);
  assert.equal(saved.oauthRequired, true, '失效后标记必须重新授权，不能偷偷回退到应用身份');
});
