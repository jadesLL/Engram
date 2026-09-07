import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-jobs-'));
process.env.DATA_DIR = temp;

let db: any;
let now: () => string;
let recoverStaleJobs: () => void;
let retryJob: (jobId: number) => { status: string };

before(async () => {
  const dbModule = await import('./lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  ({ recoverStaleJobs, retryJob } = await import('./jobs.js'));
});

beforeEach(() => {
  db.prepare(`DELETE FROM jobs`).run();
  db.prepare(`DELETE FROM pages_fts`).run();
  db.prepare(`DELETE FROM pages`).run();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('启动清理把已移除的提炼类任务标记为失败', () => {
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at) VALUES('ingest','{}','pending',?,?)`
  ).run(now(), now());
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at) VALUES('dream','{}','running',?,?)`
  ).run(now(), now());
  recoverStaleJobs();
  const rows = db.prepare(`SELECT kind,status,error FROM jobs`).all();
  for (const row of rows) {
    assert.equal(row.status, 'failed');
    assert.match(row.error, /已随提炼管线移除/);
  }
});

test('已移除类型的失败任务不可重试', () => {
  const info = db.prepare(
    `INSERT INTO jobs(kind,payload,status,error,created_at,updated_at) VALUES('page_recompose','{}','failed','x',?,?)`
  ).run(now(), now());
  assert.throws(() => retryJob(Number(info.lastInsertRowid)), /已随提炼管线移除/);
});

test('启动 FTS 兜底为缺 pages_fts 的页面入队索引任务', () => {
  db.prepare(
    `INSERT INTO pages(id,path,title,type,tags,summary,created_at,updated_at,deleted,word_count)
     VALUES('p1','Wiki/概念/A.md','A','concept','[]','',?,?,0,1)`
  ).run(now(), now());
  recoverStaleJobs();
  const job = db.prepare(`SELECT kind,payload FROM jobs WHERE status IN ('pending','running')`).get() as any;
  assert.ok(job);
  assert.equal(job.kind, 'process');
  assert.match(job.payload, /p1/);
});
