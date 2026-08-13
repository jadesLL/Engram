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
