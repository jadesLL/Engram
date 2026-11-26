import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-trash-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let ensureDirs: () => void;
let createPage: (dir: string, title: string) => any;
let moveToTrash: (relPath: string) => any;
let safeJoin: (relPath: string) => string;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ ensureDirs } = await import('../config.js'));
  ensureDirs();
  ({ createPage, safeJoin } = await import('../lib/vault.js'));
  ({ moveToTrash } = await import('../lib/trash.js'));
  const { trashRoutes } = await import('./trash.js');
  app = Fastify();
  await app.register(jwt, { secret: 'trash-route-test-secret' });
  await app.register(trashRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM chunks;
    DELETE FROM edges;
    DELETE FROM pages_fts;
    DELETE FROM files_fts;
    DELETE FROM pages;
    DELETE FROM files;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('trash routes enforce auth and validate empty id lists', async () => {
  const unauth = await app.inject({ method: 'GET', url: '/api/trash' });
  assert.equal(unauth.statusCode, 401);

  const headers = { authorization: `Bearer ${token}` };
  const badRestore = await app.inject({ method: 'POST', url: '/api/trash/restore', headers, payload: { ids: [] } });
  assert.equal(badRestore.statusCode, 400);

  const badDelete = await app.inject({ method: 'DELETE', url: '/api/trash', headers, payload: {} });
  assert.equal(badDelete.statusCode, 400);
});

test('trash routes list, restore, and empty trashed pages', async () => {
  const headers = { authorization: `Bearer ${token}` };
  const page = createPage('Wiki/概念', '回收站路由测试');
  const trashed = moveToTrash(page.path);

  const list1 = await app.inject({ method: 'GET', url: '/api/trash', headers });
  assert.equal(list1.statusCode, 200);
  assert.equal(list1.json().count, 1);

  const restore = await app.inject({
    method: 'POST',
    url: '/api/trash/restore',
    headers,
    payload: { ids: [trashed.id] },
  });
  assert.equal(restore.statusCode, 200);
  assert.equal(restore.json().restored.length, 1);
  assert.equal(fs.existsSync(safeJoin(page.path)), true);

  moveToTrash(page.path);
  const emptied = await app.inject({ method: 'DELETE', url: '/api/trash/all', headers });
  assert.equal(emptied.statusCode, 200);
  assert.equal(emptied.json().deleted.length, 1);

  const list2 = await app.inject({ method: 'GET', url: '/api/trash', headers });
  assert.equal(list2.json().count, 0);
});
