import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-pages-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));

  const { pageRoutes } = await import('./pages.js');
  app = Fastify();
  await app.register(jwt, { secret: 'pages-route-test-secret' });
  await app.register(pageRoutes);
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
