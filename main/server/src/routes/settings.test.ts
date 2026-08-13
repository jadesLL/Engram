import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-settings-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let now: () => string;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));

  const { settingsRoutes } = await import('./settings.js');
  app = Fastify();
  await app.register(jwt, { secret: 'settings-route-test-secret' });
  await app.register(settingsRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('model usage can be cleared while an AI job remains running', async () => {
  db.prepare(
    `INSERT INTO llm_usage(
       provider,model,operation,tag,prompt_tokens,completion_tokens,total_tokens,
       cache_read_tokens,cache_write_tokens,cache_miss_tokens,cache_reported,
       duration_ms,raw_usage,created_at
     ) VALUES('test','model','chat','route-test',1,1,2,0,0,0,0,1,'{}',?)`
  ).run(now());
  const running = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_token)
     VALUES('metagen','{}','running',?,?,'usage-route-run')`
  ).run(now(), now());

  const response = await app.inject({
    method: 'DELETE',
    url: '/api/settings/llm-usage',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().deleted, 1);
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(running.lastInsertRowid).status,
    'running',
  );
});

test('AI logs can be cleared while queued and running jobs exist', async () => {
  db.prepare(`DELETE FROM jobs`).run();
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('metagen','{}','pending',?,?)`
  ).run(now(), now());
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_token)
     VALUES('mentions','{}','running',?,?,'detached-route-run')`
  ).run(now(), now());

  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/wipe-ai-logs',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: 'test-password' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cancelledJobs, 2);
  assert.equal(
    db.prepare(`SELECT COUNT(*) count FROM jobs WHERE status IN ('pending','running')`).get().count,
    0,
  );
});

test('knowledge data can be wiped while an AI job is running', async () => {
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_token)
     VALUES('mentions','{}','running',?,?,'knowledge-route-run')`
  ).run(now(), now());

  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/wipe',
    headers: { authorization: `Bearer ${token}` },
    payload: { password: 'test-password' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().cancelledJobs, 1);
  assert.equal(
    db.prepare(`SELECT COUNT(*) count FROM jobs WHERE status IN ('pending','running')`).get().count,
    0,
  );
});
