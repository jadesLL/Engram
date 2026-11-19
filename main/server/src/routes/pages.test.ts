import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pages-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let resetReconcileThrottle: () => void = () => {};
let relatedCacheSize: () => number = () => 0;
let RELATED_CACHE_MAX = 0;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));

  const routes = await import('./pages.js');
  resetReconcileThrottle = routes.resetReconcileThrottle;
  relatedCacheSize = routes.relatedCacheSize;
  RELATED_CACHE_MAX = routes.RELATED_CACHE_MAX;
  app = Fastify();
  await app.register(jwt, { secret: 'pages-route-test-secret' });
  await app.register(routes.pageRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('PUT 只改 type 时保留正文（侧栏拖拽改类型路径）', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '侧栏拖拽测试', type: 'concept' },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().meta.id;

  const written = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: '# 侧栏拖拽测试\n\n重要正文，不能丢。' },
  });
  assert.equal(written.statusCode, 200);

  // 回归点：请求体只有 type（Sidebar.vue changePageType 的实际形态），
  // 修复前 content ?? '' 会把整页正文清空
  const moved = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'entity' },
  });
  assert.equal(moved.statusCode, 200);

  const row = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(id) as { path: string };
  const onDisk = fs.readFileSync(path.join(temp, 'brain', row.path), 'utf8');
  assert.match(onDisk, /重要正文，不能丢。/);
});

test('POST 拒绝已从词表移除的旧类型（place/work）', async () => {
  for (const legacyType of ['place', 'work']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pages',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: `旧类型测试-${legacyType}`, type: legacyType },
    });
    assert.equal(res.statusCode, 400);
  }
  // 合法类型仍可创建
  const ok = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '项目类型测试', type: 'project' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().meta.type, 'project');
});

test('PUT 显式传空 content 仍会清空正文（语义保留）', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '显式清空测试', type: 'concept' },
  });
  const id = created.json().meta.id;
  await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: '# 显式清空测试\n\n旧内容' },
  });
  const cleared = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: '' },
  });
  assert.equal(cleared.statusCode, 200);
  const row = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(id) as { path: string };
  const onDisk = fs.readFileSync(path.join(temp, 'brain', row.path), 'utf8');
  assert.doesNotMatch(onDisk, /旧内容/);
});

test('带外删除（裸移文件到 .trash）后列表自愈：幽灵页不再列出，行标 deleted', async () => {
  // 列表对账有 30s 节流（生产省全量 stat）：本用例验证「对账生效」，先重置窗口
  resetReconcileThrottle();
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '带外删除测试', type: 'concept' },
  });
  const id = created.json().meta.id;
  const row = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(id) as { path: string };

  // 复现现场：Agent 用 shell/文件工具把文件裸移进 .trash，不经过 moveToTrash，
  // DB 行停在 deleted=0（用户看到侧栏还有、点开报「文件不存在」）
  const abs = path.join(temp, 'brain', row.path);
  const trash = path.join(temp, 'brain', '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(abs, path.join(trash, path.basename(row.path)));
  assert.equal(
    (db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(id) as any).deleted,
    0,
    '前置条件：带外移动不动 DB 行'
  );

  const res = await app.inject({
    method: 'GET',
    url: '/api/pages/list',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(
    !res.json().pages.some((p: any) => p.id === id),
    '幽灵页不得再出现在列表里'
  );
  assert.equal((db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(id) as any).deleted, 1);

  // 对账只针对缺失文件：正常页面照常列出
  const kept = res.json().pages.map((p: any) => p.title);
  assert.ok(kept.includes('显式清空测试'));
});

test('编辑器改标题：磁盘文件名跟着改（侧栏「目录」不再显示旧名）', async () => {
  // 现场（2026-09-22 用户反馈）：在编辑器顶部标题框改名字，面包屑/大标题是新的、
  // 侧栏目录里的文件名还是旧的——因为 PUT 只写了 frontmatter 标题，没动文件。
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '2026.08.16京津区人员架构', type: 'concept' },
  });
  const id = created.json().meta.id;
  const before = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(id) as { path: string };
  assert.equal(before.path, 'Wiki/概念/2026.08.16京津区人员架构.md');

  const res = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '2026.08.16_京津区人员架构' },
  });
  assert.equal(res.statusCode, 200);

  const after = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(id) as any;
  assert.equal(after.title, '2026.08.16_京津区人员架构');
  assert.equal(
    after.path,
    'Wiki/概念/2026.08.16_京津区人员架构.md',
    '标题改了，文件名必须跟着改（否则侧栏目录与标题两套名字）'
  );
  assert.equal(
    fs.existsSync(path.join(temp, 'brain', before.path)),
    false,
    '旧文件名的文件不能留在原地'
  );
  const onDisk = fs.readFileSync(path.join(temp, 'brain', after.path), 'utf8');
  assert.match(onDisk, /标题: 2026\.08\.16_京津区人员架构/);
  assert.match(onDisk, /^# 2026\.08\.16京津区人员架构$/m, '编辑器改标题不动正文 H1');
});

/**
 * 回归：by-title 路由此前对 Fastify 已解码的路由参数再做一次 decodeURIComponent——
 * 含 `%` 的标题直接抛 URIError 变 500，`%XX` 形状的标题会被解成别的字符、跳错页面。
 */
test('by-title 支持含 % 的标题，不再二次解码', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '折扣100%达标', type: 'concept' },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().meta.id;

  const hit = await app.inject({
    method: 'GET',
    url: `/api/pages/by-title/${encodeURIComponent('折扣100%达标')}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(hit.statusCode, 200, '含 % 的标题不得 500（二次解码抛 URIError）');
  assert.equal(hit.json().id, id);

  // `%25` 字面量不得被当成转义序列解码成 `%`
  const encodedTitle = '进度50%25完成';
  const encoded = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: encodedTitle, type: 'concept' },
  });
  const encodedId = encoded.json().meta.id;
  const hit2 = await app.inject({
    method: 'GET',
    url: `/api/pages/by-title/${encodeURIComponent(encodedTitle)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(hit2.statusCode, 200);
  assert.equal(hit2.json().id, encodedId, '%XX 形状的标题不得被二次解码成别的标题');
});

/** 回归：related 缓存原先只在命中时查 TTL、从不删条目，长跑进程会随访问过的页面无限增长。 */
test('related 缓存有上限：访问大量页面后不会无限增长', async () => {
  for (let i = 0; i < RELATED_CACHE_MAX + 8; i += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/pages/related-miss-${i}/related`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
  }
  assert.ok(relatedCacheSize() > 0, '新访问的页面应进入缓存');
  assert.ok(
    relatedCacheSize() <= RELATED_CACHE_MAX,
    `缓存条目 ${relatedCacheSize()} 超过上限 ${RELATED_CACHE_MAX}`
  );
});

/**
 * 保存前对账（2026-11-19 用户报障：内置 Agent 按位置引用写入后，编辑器看不到，
 * 下次自动保存还会用旧正文把它覆盖）：PUT 带 baseContent 时，若页面在加载后被
 * 别的来源改过，服务端先做字符级三方合并再落盘，两侧改动都要保留。
 */
test('PUT 带 baseContent：页面被外部改过时三方合并，Agent 插入不被旧正文覆盖', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '保存对账合并测试', type: 'concept' },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().meta.id;

  const base = '# 保存对账合并测试\n\n第一段。\n\n第二段。';
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: base },
  });
  assert.equal(saved.statusCode, 200);

  const row = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(id) as { path: string };
  // 模拟内置 Agent 在编辑器加载之后按位置引用插入
  const { writePage } = await import('../lib/vault.js');
  writePage(row.path, `${base}\n\n123456`);

  // 编辑器仍以加载时的 base 为基准提交自己的追加：服务端必须合并而不是覆盖
  const merged = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: `${base}\n\n我的追加`, baseContent: base },
  });
  assert.equal(merged.statusCode, 200);
  const body = merged.json();
  assert.equal(body.merged, true, '外部改动应触发合并');
  assert.equal(typeof body.content, 'string', '合并后要回传最终正文给编辑器对齐');
  assert.match(body.content, /123456/);
  assert.match(body.content, /我的追加/);

  const onDisk = fs.readFileSync(path.join(temp, 'brain', row.path), 'utf8');
  assert.match(onDisk, /123456/, 'Agent 写入的内容不能丢');
  assert.match(onDisk, /我的追加/, '编辑器自己的改动也要保留');
});

test('PUT 带 baseContent 但页面没被外部改过：普通保存，不触发合并', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/pages',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: '保存对账无冲突测试', type: 'concept' },
  });
  const id = created.json().meta.id;
  const base = '# 保存对账无冲突测试\n\n原文。';
  await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: base },
  });

  const res = await app.inject({
    method: 'PUT',
    url: `/api/pages/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { content: `${base}\n\n新改动`, baseContent: base },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().merged, undefined);
  assert.equal(res.json().content, undefined);
});
