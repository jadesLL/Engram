import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-raw-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  const { rawRoutes } = await import('./raw.js');
  app = Fastify();
  await app.register(jwt, { secret: 'raw-route-test-secret' });
  await app.register(rawRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM chunks;
    DELETE FROM pages_fts;
    DELETE FROM pages;
  `);
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('POST /api/raw/chat requires auth and non-empty content', async () => {
  const unauth = await app.inject({ method: 'POST', url: '/api/raw/chat', payload: { content: 'hi' } });
  assert.equal(unauth.statusCode, 401);

  const blank = await app.inject({
    method: 'POST',
    url: '/api/raw/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { content: '   ' },
  });
  assert.equal(blank.statusCode, 400);
});

test('POST /api/raw/chat saves chat note and returns metadata', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/raw/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { content: '讨论架构重构细节', project: 'Engram', identifier: 'batch4' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.meta?.id);
  assert.match(String(body.meta?.path || ''), /^原始资料\//);
});
