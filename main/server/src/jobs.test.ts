import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-jobs-'));
process.env.DATA_DIR = temp;

let db: any;
let now: () => string;
let cancelJob: (jobId: number) => { status: string };
let retryJob: (jobId: number) => { status: string };
let withJobsStopped: <T>(
  action: () => Promise<T>,
) => Promise<{ result: T; cancelledJobs: number }>;

before(async () => {
  const dbModule = await import('./lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  ({ cancelJob, retryJob, withJobsStopped } = await import('./jobs.js'));
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
  db.prepare(`DELETE FROM jobs`).run();
  const pending = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
     VALUES('metagen','{}','pending',?,?)`
  ).run(now(), now());
  const running = db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_token)
     VALUES('mentions','{}','running',?,?,'detached-run')`
  ).run(now(), now());

  const maintenance = await withJobsStopped(async () => {
    const queued = db.prepare(
      `INSERT INTO jobs(kind,payload,status,created_at,updated_at)
       VALUES('rebuild','{}','pending',?,?)`
    ).run(now(), now());
    return Number(queued.lastInsertRowid);
  });

  assert.equal(maintenance.cancelledJobs, 3);
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(pending.lastInsertRowid).status,
    'cancelled',
  );
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(running.lastInsertRowid).status,
    'cancelled',
  );
  assert.equal(
    db.prepare(`SELECT status FROM jobs WHERE id=?`).get(maintenance.result).status,
    'cancelled',
  );
});
