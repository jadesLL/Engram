import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-jobs-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let now: () => string;
let token = '';
let beginSourceVersion: any;
let activateSourceVersion: any;
let upsertCandidateOccurrence: any;
let addReports: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));

  ({ beginSourceVersion, activateSourceVersion } = await import('../pipeline/sourceLedger.js'));
  ({ upsertCandidateOccurrence } = await import('../pipeline/candidateLedger.js'));
  ({ addReports } = await import('../dream/reports.js'));

  const { jobRoutes } = await import('./jobs.js');
  app = Fastify();
  await app.register(jwt, { secret: 'jobs-route-test-secret' });
  await app.register(jobRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 建一个可被 auto-commit claim 的 pending_review 报告 */
function seedPendingReview(name: string, runId: string, sourcePath: string): number {
  const abs = path.join(temp, 'brain', ...sourcePath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${name}的原始资料内容。`);
  const version = beginSourceVersion(sourcePath, `${runId}-hash`);
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, sourcePath, `${runId}-hash`, version.id, now());
  db.prepare(
    `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)`
  ).run(runId, `${runId}-f1`, `${name}的事实`, JSON.stringify([{ chunkId: 'c1', quote: `${name}的事实` }]));
  activateSourceVersion(version.id, runId);
  const candidate = upsertCandidateOccurrence({
    name, kind: 'project', action: 'review', target: '', domain: '测试',
    confidence: '中', summary: `${name}摘要`, factIds: [`${runId}-f1`],
    relations: [], reason: '跨来源不足', content: `${name}的候选正文`, evidenceEligible: true,
  }, {
    runId,
    sourceVersionId: version.id,
    sourcePath,
    sourceName: path.posix.basename(sourcePath),
  });
  addReports([{
    kind: 'pending_review',
    payload: {
      candidateId: candidate.id, name, kind: 'project',
      source: path.posix.basename(sourcePath), sourcePath,
      sourceVersionId: version.id, runId,
      factIds: [`${runId}-f1`], content: `${name}的候选正文`,
      summary: `${name}摘要`, reason: '跨来源不足',
    },
  }]);
  const report = db.prepare(
    `SELECT id FROM reports WHERE kind='pending_review' AND status='open' ORDER BY id DESC LIMIT 1`
  ).get();
  return report.id;
}

function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
}

test('auto-commit claims the report and enqueues a background candidate review job', async () => {
  const reportId = seedPendingReview('一步入库项目', 'auto-run-1', '原始资料/一步入库.md');
  const response = await post(`/api/ingest/candidates/${reportId}/auto-commit`, { kind: 'project' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isInteger(body.jobId) && body.jobId > 0, '应返回后台任务 jobId 供前端轮询进度');
  const job = db.prepare(`SELECT kind,payload,status FROM jobs WHERE id=?`).get(body.jobId);
  assert.equal(job.kind, 'candidate_review_batch');
  assert.equal(job.status, 'pending');
  assert.deepEqual(JSON.parse(job.payload).decisions, [{ reportId, action: 'approve:project' }]);
  assert.equal(
    db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId).status,
    'applying',
    'claim 应原子置 applying,防止重复触发',
  );
});

test('auto-commit rejects duplicate trigger while the candidate is applying', async () => {
  const reportId = seedPendingReview('重复触发项目', 'auto-run-2', '原始资料/重复触发.md');
  const first = await post(`/api/ingest/candidates/${reportId}/auto-commit`, {});
  assert.equal(first.statusCode, 200);
  const second = await post(`/api/ingest/candidates/${reportId}/auto-commit`, {});
  assert.equal(second.statusCode, 409, '处理中重复点击应返回 409 而非再次入队');
  const jobs = db.prepare(
    `SELECT COUNT(*) n FROM jobs WHERE kind='candidate_review_batch' AND payload LIKE ?`
  ).get(`%"reportId":${reportId}%`).n;
  assert.equal(jobs, 1, '同一候选只应入队一次');
});

test('auto-commit falls back to the report payload kind and validates it', async () => {
  const reportId = seedPendingReview('默认类型项目', 'auto-run-3', '原始资料/默认类型.md');
  const response = await post(`/api/ingest/candidates/${reportId}/auto-commit`, {});
  assert.equal(response.statusCode, 200);
  const job = db.prepare(`SELECT payload FROM jobs WHERE kind='candidate_review_batch' ORDER BY id DESC LIMIT 1`).get();
  assert.deepEqual(JSON.parse(job.payload).decisions, [{ reportId, action: 'approve:project' }]);

  const bad = await post(`/api/ingest/candidates/${reportId}/auto-commit`, { kind: 'not-a-kind' });
  assert.equal(bad.statusCode, 409, '无效 kind 无法通过候选决策校验');
});

test('auto-commit rejects unknown or already-resolved reports', async () => {
  const missing = await post('/api/ingest/candidates/999999/auto-commit', {});
  assert.equal(missing.statusCode, 409);

  const reportId = seedPendingReview('已处理项目', 'auto-run-4', '原始资料/已处理.md');
  db.prepare(`UPDATE reports SET status='resolved' WHERE id=?`).run(reportId);
  const resolved = await post(`/api/ingest/candidates/${reportId}/auto-commit`, {});
  assert.equal(resolved.statusCode, 409);
});
