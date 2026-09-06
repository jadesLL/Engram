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
