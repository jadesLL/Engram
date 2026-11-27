import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-entity-names-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let ensureDirs: () => void;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ ensureDirs } = await import('../config.js'));
  ensureDirs();
  const { entityNameRoutes } = await import('./entityNames.js');
  app = Fastify();
  await app.register(jwt, { secret: 'entity-names-route-test-secret' });
  await app.register(entityNameRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM entity_name_checks;
    DELETE FROM pages_fts;
    DELETE FROM pages;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('entity name routes enforce auth and decision validation', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/entity-names' })).statusCode, 401);

  const headers = { authorization: `Bearer ${token}` };
  const badAnswer = await app.inject({
    method: 'POST',
    url: '/api/entity-names/nonexistent/answer',
    headers,
    payload: { decision: 'maybe' },
  });
  assert.equal(badAnswer.statusCode, 400);
});

test('entity name check lifecycle lists pending checks, accepts answers, and audits pages', async () => {
  const headers = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/agent/entity-name',
    headers,
    payload: { entity: '京卓信' },
  });
  assert.equal(created.statusCode, 200);
  const checkId = created.json().check.id;

  const listPending = await app.inject({ method: 'GET', url: '/api/entity-names?status=pending', headers });
  assert.equal(listPending.statusCode, 200);
  assert.equal(listPending.json().pending, 1);

  const answered = await app.inject({
    method: 'POST',
    url: `/api/entity-names/${encodeURIComponent(checkId)}/answer`,
    headers,
    payload: { decision: 'deny', note: '待进一步核实' },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().pending, 0);

  const audit = await app.inject({ method: 'GET', url: '/api/agent/entity-name/audit', headers });
  assert.equal(audit.statusCode, 200);
  assert.ok(typeof audit.json().text === 'string');
});
