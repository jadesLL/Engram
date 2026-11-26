import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-office-route-'));
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
  const { officeRoutes } = await import('./office.js');
  app = Fastify();
  await app.register(jwt, { secret: 'office-route-test-secret' });
  await app.register(officeRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('office authenticated endpoints enforce auth and input validation', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/files/office-config' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/files/office-versions' })).statusCode, 401);

  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/files/office-config', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/files/office-versions', headers })).statusCode, 400);

  const badRestore = await app.inject({
    method: 'POST',
    url: '/api/files/office-versions/invalid%2Fid/restore',
    headers,
  });
  assert.equal(badRestore.statusCode, 400);
});

test('office token-gated endpoints reject missing or invalid tokens', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/files/office-content' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/files/office-content?token=bad' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/files/office-callback', payload: {} })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/files/office-callback?token=bad', payload: {} })).statusCode,
    400
  );
});
