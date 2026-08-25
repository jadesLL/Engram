import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-jobs-'));
process.env.DATA_DIR = temp;

let db: any;
let now: () => string;
let cancelJob: (jobId: number) => { status: string };
let getJobQueueState: () => { running: boolean };
let recoverStaleJobs: () => void;
let retryFailedJobs: () => { retried: number; failed: number; errors: string[] };
let retryJob: (jobId: number) => { status: string };
let startJobQueue: () => { status: string; started: number; failed: number; errors: string[] };
let stopJobQueue: () => { status: string; stopped: number };
let withJobsStopped: <T>(
  action: () => Promise<T>,
) => Promise<{ result: T; cancelledJobs: number }>;

before(async () => {
  const dbModule = await import('./lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  ({
    cancelJob,
    getJobQueueState,
    recoverStaleJobs,
    retryFailedJobs,
    retryJob,
    startJobQueue,
    stopJobQueue,
    withJobsStopped,
  } = await import('./jobs.js'));
});

beforeEach(() => {
  db.prepare(`DELETE FROM reports`).run();
  db.prepare(`DELETE FROM jobs`).run();
  db.prepare(`DELETE FROM settings WHERE key='job_queue_enabled'`).run();
  // 索引救济读 pages/index_states;清干净避免测试间互相影响
  db.prepare(`DELETE FROM pages_fts`).run();
  db.prepare(`DELETE FROM pages`).run();
  db.prepare(`DELETE FROM index_states`).run();
  db.prepare(`DELETE FROM chunks`).run();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('job migration adds persistent cancellation and execution token columns', () => {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(jobs)`).all().map((column: any) => column.name),
  );
  assert.ok(columns.has('cancel_requested'));
  assert.ok(columns.has('run_token'));
});

test('startup recovery discards interrupted derived jobs before restoring safe work', () => {
  const report = db.prepare(
    `INSERT INTO reports(run_at,kind,payload,status,issue_key,fingerprint)
     VALUES(?,'pending_review',?,'applying','startup-report','startup-report')`
  ).run(now(), JSON.stringify({ name: '启动残留候选' }));
  const reportId = Number(report.lastInsertRowid);

  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_at,run_token,cancel_requested)
     VALUES('page_recompose','{}','pending',?,?,NULL,'',0)`
  ).run(now(), now());
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_at,run_token,cancel_requested)
     VALUES('metagen','{}','running',?,?,?,'derived-run',1)`
  ).run(now(), now(), now());
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_at,run_token,cancel_requested)
     VALUES('candidate_reconcile',?,'running',?,?,?,'candidate-run',0)`
  ).run(JSON.stringify({ reportIds: [reportId] }), now(), now(), now());
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_at,run_token,cancel_requested)
     VALUES('embed','{"pageId":"safe"}','running',?,?,?,'safe-run',0)`
  ).run(now(), now(), now());
  // stale-run 的时间戳须超出 20 分钟无进度探针窗口（旧 5 分钟窗口时代用 -10 分钟），
  // 才会被启动清理判为超时残留标 failed
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_at,run_token,cancel_requested)
     VALUES('rebuild','{}','running',datetime('now','-25 minutes'),datetime('now','-25 minutes'),
            datetime('now','-25 minutes'),'stale-run',0)`
  ).run();

  recoverStaleJobs();

  assert.deepEqual(
    db.prepare(`SELECT kind,status,stage,run_token,cancel_requested FROM jobs ORDER BY id`).all(),
    [
      { kind: 'page_recompose', status: 'failed', stage: '启动清理', run_token: '', cancel_requested: 0 },
      { kind: 'metagen', status: 'failed', stage: '启动清理', run_token: '', cancel_requested: 0 },
      // candidate_reconcile 幂等且承担重启后的对账救济，不再作为残留任务清理，
      // 运行中的被恢复为 pending 继续执行，而不是标 failed 触发 previousFailure 锁死。
      { kind: 'candidate_reconcile', status: 'pending', stage: '等待执行', run_token: '', cancel_requested: 0 },
      { kind: 'embed', status: 'pending', stage: '等待执行', run_token: '', cancel_requested: 0 },
      { kind: 'rebuild', status: 'failed', stage: '等待执行', run_token: '', cancel_requested: 0 },
    ],
  );
  // candidate_reconcile 保留为 pending 且仍 claim 该 report，故 report 保持 applying
  // 等待对账任务继续执行，而不是被释放回 open 后重复入队。
  assert.equal(
    db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId).status,
    'applying',
  );
});

test('cancelling a pending candidate reconciliation releases claimed reports', () => {
  const report = db.prepare(
    `INSERT INTO reports(run_at,kind,payload,status,issue_key,fingerprint)
     VALUES(?,'pending_review',?,'applying','cancel-report','cancel-report')`
  ).run(now(), JSON.stringify({ name: '取消候选' }));
  const reportId = Number(report.lastInsertRowid);
  const job = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('candidate_reconcile',?,'pending',?,?)`
  ).run(JSON.stringify({
    path: '原始资料/取消候选.md',
    candidateIds: ['candidate-1'],
    reportIds: [reportId],
  }), now(), now());

  assert.deepEqual(cancelJob(Number(job.lastInsertRowid)), { status: 'cancelled' });
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(job.lastInsertRowid).status,
    'cancelled',
  );
  assert.equal(
    db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId).status,
    'open',
  );

  assert.deepEqual(retryJob(Number(job.lastInsertRowid)), { status: 'pending' });
  assert.equal(
    db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId).status,
    'applying',
  );
});

test('maintenance stops active jobs and jobs queued during cleanup', async () => {
  const pending = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('metagen','{}','pending',?,?)`
  ).run(now(), now());
  const running = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_token)
     VALUES('mentions','{}','running',?,?,'detached-run')`
  ).run(now(), now());
  const paused = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('embed','{"pageId":"paused"}','paused',?,?)`
  ).run(now(), now());

  const maintenance = await withJobsStopped(async () => {
    const queued = db.prepare(
      `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
       VALUES('rebuild','{}','pending',?,?)`
    ).run(now(), now());
    return Number(queued.lastInsertRowid);
  });

  assert.equal(maintenance.cancelledJobs, 4);
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(pending.lastInsertRowid).status,
    'cancelled',
  );
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(running.lastInsertRowid).status,
    'cancelled',
  );
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(paused.lastInsertRowid).status,
    'cancelled',
  );
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(maintenance.result).status,
    'cancelled',
  );
});

test('stopping and starting the queue freezes and restores active jobs', () => {
  const pending = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('embed','{"pageId":"pending"}','pending',?,?)`
  ).run(now(), now());
  const running = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_at,run_token)
     VALUES('embed','{"pageId":"running"}','running',?,?,?,'test-run')`
  ).run(now(), now(), now());

  assert.deepEqual(stopJobQueue(), { status: 'stopped', stopped: 2 });
  assert.equal(getJobQueueState().running, false);
  assert.deepEqual(
    db.prepare(`SELECT id,status,stage FROM jobs ORDER BY id`).all(),
    [
      { id: Number(pending.lastInsertRowid), status: 'paused', stage: '已停止' },
      { id: Number(running.lastInsertRowid), status: 'paused', stage: '已停止' },
    ],
  );

  assert.deepEqual(startJobQueue(), {
    status: 'running',
    started: 2,
    failed: 0,
    errors: [],
  });
  assert.equal(getJobQueueState().running, true);
  assert.deepEqual(
    db.prepare(`SELECT status FROM jobs ORDER BY id`).all(),
    [{ status: 'pending' }, { status: 'pending' }],
  );
});

test('retrying failed jobs does not restart cancelled history', () => {
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('embed','{"pageId":"failed"}','failed',?,?)`
  ).run(now(), now());
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('embed','{"pageId":"cancelled"}','cancelled',?,?)`
  ).run(now(), now());

  assert.deepEqual(retryFailedJobs(), { retried: 1, failed: 0, errors: [] });
  assert.deepEqual(
    db.prepare(`SELECT status FROM jobs ORDER BY id`).all(),
    [{ status: 'pending' }, { status: 'cancelled' }],
  );
});

test('startup recovery re-enqueues pages that never completed indexing', async () => {
  const { createPage, writePage } = await import('./lib/vault.js');
  // A:从未索引(无 index_states)→ 应被救济入队 process
  const missing = createPage('Wiki/概念', '缺索引页面');
  writePage(missing.path, '# 缺索引页面\n\n内容', { type: 'concept' });
  // B:已完成索引(有 index_states)→ 不重复入队
  const indexed = createPage('Wiki/概念', '已索引页面');
  writePage(indexed.path, '# 已索引页面\n\n内容', { type: 'concept' });
  db.prepare(
    `INSERT INTO index_states(ref_type,ref_id,content_hash,model_key,updated_at)
     VALUES('page',?,'hash','model',?)`
  ).run(indexed.id, now());
  // C:已删除 → 不入队
  const deleted = createPage('Wiki/概念', '已删除页面');
  db.prepare(`UPDATE pages SET deleted=1 WHERE id=?`).run(deleted.id);

  recoverStaleJobs();

  const processJobs = db.prepare(
    `SELECT payload FROM jobs WHERE kind='process' AND status='pending'`
  ).all() as { payload: string }[];
  const processPageIds = processJobs.map((job) => JSON.parse(job.payload).pageId);
  assert.ok(processPageIds.includes(missing.id), '缺索引页面应重新入队 process');
  assert.ok(!processPageIds.includes(indexed.id), '已索引页面不应重复入队');
  assert.ok(!processPageIds.includes(deleted.id), '已删除页面不应入队');

  // 幂等:连续两次恢复,同一页面在 pending 队列中始终只有一个 process 任务。
  // (第二次恢复会把上次救济入队的 pending 任务按启动清理语义标 failed 再重新入队,
  //  这是清理与救济的正常交互:failed 记录有界,pending 不重复。)
  recoverStaleJobs();
  const pendingAfter = db.prepare(
    `SELECT payload FROM jobs WHERE kind='process' AND status='pending'`
  ).all() as { payload: string }[];
  const pendingIds = pendingAfter.map((job) => JSON.parse(job.payload).pageId)
    .filter((id) => id === missing.id);
  assert.equal(pendingIds.length, 1, '同一缺索引页面在 pending 中不应重复');
});
