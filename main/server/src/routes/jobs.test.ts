import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

/**
 * /api/jobs 的失败告警口径：
 *  - failed / failures 只算「未忽略 + 最近 7 天内」的失败，老失败不占告警位；
 *  - POST /api/jobs/acknowledge 逐条或全部忽略，忽略后立刻从两个字段里消失。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-jobs-routes-'));
process.env.DATA_DIR = temp;

let app: FastifyInstance;
let db: any;
let token = '';
let seq = 0;

const DAY = 24 * 60 * 60 * 1000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function insertJob(options: {
  status?: string;
  updatedAt?: string;
  acknowledgedAt?: string | null;
  kind?: string;
  payload?: unknown;
} = {}): number {
  seq += 1;
  const at = options.updatedAt || new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO jobs(kind, payload, status, stage, progress, detail, error, created_at, run_at, updated_at, acknowledged_at)
     VALUES(?, ?, ?, ?, 0, '', ?, ?, ?, ?, ?)`
  ).run(
    options.kind || 'inbox_convert',
    JSON.stringify(options.payload || { path: `收集箱/资料-${seq}.md` }),
    options.status || 'failed',
    options.status === 'done' ? '已完成' : '失败',
    options.status === 'failed' ? '测试失败' : null,
    at,
    at,
    at,
    options.acknowledgedAt ?? null
  );
  return Number(info.lastInsertRowid);
}

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { jobRoutes } = await import('./jobs.js');
  app = Fastify();
  await app.register(jwt, { secret: 'jobs-route-test-secret' });
  await app.register(jobRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

beforeEach(() => {
  db.prepare(`DELETE FROM jobs`).run();
  seq = 0;
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

const auth = () => ({ authorization: 'Bearer ' + token });

test('/api/jobs：失败只算最近 7 天内且未忽略的', async () => {
  const recent = insertJob();
  insertJob({ updatedAt: isoAgo(10 * DAY) });
  insertJob({ acknowledgedAt: new Date().toISOString() });
  insertJob({ status: 'done' });

  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: auth() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.failed, 1, '老失败 / 已忽略 / 已完成都不计入告警数');
  assert.deepEqual(body.failures.map((job: any) => job.id), [recent], '点开「去处理」必须看到徽标同口径的失败清单');
  assert.equal(body.failures[0].acknowledged, false);
  assert.equal(body.failures[0].label, '收集箱转换');
  assert.match(body.failures[0].targetLabel, /资料-/, '失败清单带目标名，用户才知道是哪条');
});

test('/api/jobs/acknowledge：按 id 忽略，只影响指定失败', async () => {
  const first = insertJob();
  const second = insertJob();
  const beforeUpdatedAt = (db.prepare(`SELECT updated_at FROM jobs WHERE id = ?`).get(first) as any).updated_at;

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs/acknowledge',
    headers: auth(),
    payload: { ids: [first] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().acknowledged, 1);

  const body = (await app.inject({ method: 'GET', url: '/api/jobs', headers: auth() })).json();
  assert.equal(body.failed, 1);
  assert.deepEqual(body.failures.map((job: any) => job.id), [second]);

  const row = db.prepare(`SELECT acknowledged_at, updated_at FROM jobs WHERE id = ?`).get(first) as any;
  assert.ok(row.acknowledged_at, '忽略时间要落库，重启后仍不再报警');
  assert.equal(row.updated_at, beforeUpdatedAt, '忽略只写 acknowledged_at，不动 updated_at（30 天保留期照旧）');
});

test('/api/jobs/acknowledge：不传 ids = 全部忽略（含窗口外的老失败）', async () => {
  insertJob();
  insertJob({ updatedAt: isoAgo(10 * DAY) });

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs/acknowledge',
    headers: auth(),
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().acknowledged, 2);

  const body = (await app.inject({ method: 'GET', url: '/api/jobs', headers: auth() })).json();
  assert.equal(body.failed, 0);
  assert.deepEqual(body.failures, []);
});

test('/api/jobs/acknowledge：非法 ids 不做任何事，非数组报 400', async () => {
  const id = insertJob();

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/jobs/acknowledge',
    headers: auth(),
    payload: { ids: ['nope'] },
  });
  assert.equal(invalid.statusCode, 200);
  assert.equal(invalid.json().acknowledged, 0, '传了 ids 但全非法时不能退化成「全部忽略」');

  const missing = await app.inject({
    method: 'POST',
    url: '/api/jobs/acknowledge',
    headers: auth(),
    payload: { ids: id },
  });
  assert.equal(missing.statusCode, 400);
});

test('/api/jobs/acknowledge 同样要鉴权', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/jobs/acknowledge', payload: {} });
  assert.equal(res.statusCode, 401);
});
