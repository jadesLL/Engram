import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * 首页自定义看板布局（home_layout）设置接口测试：
 *  - 白名单放行：GET /api/settings 带出该键（未设置时是 ''），PUT 后能原样取回；
 *  - 服务端不校验 JSON：字符串原样存；传对象时走既有 `typeof v === 'string' ? v : JSON.stringify(v)` 分支；
 *  - 回归：没写过的其它白名单键仍是 ''，新增键不该影响既有响应结构。
 *
 * 解析与归一化是前端 lib/homeBoard.ts 的职责（写坏的内容一律回退默认布局），
 * 所以这里只守「服务端原样存取、不做特判」这条契约。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-home-layout-'));
process.env.DATA_DIR = temp;

const API_TOKEN = `lwiki_${'h'.repeat(24)}`;

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import('../lib/db.js');

function getSettings() {
  return app.inject({
    method: 'GET',
    url: '/api/settings',
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
}

function putSettings(payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { authorization: `Bearer ${API_TOKEN}` },
    payload,
  });
}

before(async () => {
  dbModule = await import('../lib/db.js');
  dbModule.migrate();
  dbModule.db
    .prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
    .run(API_TOKEN, 'home-layout-test', '2026-01-01 00:00:00');
  const { settingsRoutes } = await import('./settings.js');
  app = Fastify();
  await app.register(jwt, { secret: 'home-layout-test-secret' });
  await app.register(settingsRoutes);
  await app.ready();
});

after(async () => {
  try { await app.close(); } catch { /* 已关闭 */ }
  try { dbModule?.db.close(); } catch { /* 已关闭 */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('未设置时 home_layout 也出现在响应里，值为空串（前端据此回退默认布局）', async () => {
  const res = await getSettings();
  assert.equal(res.statusCode, 200);
  const settings = (res.json() as { settings: Record<string, string> }).settings;
  assert.ok('home_layout' in settings, 'GET 必须带出白名单里的 home_layout');
  assert.equal(settings.home_layout, '');
  assert.equal(typeof settings.home_layout, 'string', '设置值一律以字符串形态返回');
});

test('PUT JSON 字符串后 GET 原样取回（服务端不重新序列化、不改写内容）', async () => {
  const layout = JSON.stringify({
    version: 1,
    modules: [
      { id: 'm1', kind: 'capture', title: '', span: 'full', opts: {} },
      { id: 'm2', kind: 'recent', title: '最近更新', span: 'half', opts: { limit: 8 } },
    ],
  });

  const saved = await putSettings({ home_layout: layout });
  assert.equal(saved.statusCode, 200);
  assert.equal((saved.json() as { ok: boolean }).ok, true);

  const res = await getSettings();
  const got = (res.json() as { settings: Record<string, string> }).settings.home_layout;
  assert.equal(typeof got, 'string');
  assert.equal(got, layout, '字符串入参应原样存取，不做解析/重排');
  assert.deepEqual(JSON.parse(got), JSON.parse(layout));
  assert.equal(dbModule.getSetting('home_layout'), layout, '落库内容与接口读回一致');
});

test('PUT 传对象（而非字符串）时按既有分支 JSON.stringify 保存，GET 仍是字符串', async () => {
  const layout = {
    version: 1,
    modules: [
      { id: 'm3', kind: 'tasks', title: '近期待办', span: 'half', opts: { limit: 5, collapsed: false } },
    ],
  };

  const saved = await putSettings({ home_layout: layout });
  assert.equal(saved.statusCode, 200);

  const res = await getSettings();
  const got = (res.json() as { settings: Record<string, string> }).settings.home_layout;
  assert.equal(typeof got, 'string', '对象入参必须序列化后再存，读取端永远拿到字符串');
  assert.deepEqual(JSON.parse(got), layout);
  assert.equal(dbModule.getSetting('home_layout'), got);
});

test('写坏的内容照样存下并原样返回（服务端不做 JSON 校验，由前端归一化兜底）', async () => {
  const broken = '{"version":1,"modules":[';
  const saved = await putSettings({ home_layout: broken });
  assert.equal(saved.statusCode, 200, '非法 JSON 不是服务端该拦的事');

  const res = await getSettings();
  const got = (res.json() as { settings: Record<string, string> }).settings.home_layout;
  assert.equal(got, broken);
  assert.throws(() => JSON.parse(got), '服务端不该偷偷修补内容');
});

test('回归：其它未设置的白名单键仍是空串（新增 home_layout 不改动既有键的默认行为）', async () => {
  const res = await getSettings();
  assert.equal(res.statusCode, 200);
  const settings = (res.json() as { settings: Record<string, string> }).settings;
  // search_synonyms 是唯一有初值的白名单键（migrate 预置默认同义词表），不列入「未设置」集合。
  for (const key of ['zcode_config', 'ddns_config', 'name_fixes', 'show_ai_workspace']) {
    assert.equal(settings[key], '', `${key} 未设置时仍应是空串`);
  }
  assert.ok(settings.search_synonyms.length > 0, 'search_synonyms 的默认值来自 migrate，不受本次改动影响');
});
