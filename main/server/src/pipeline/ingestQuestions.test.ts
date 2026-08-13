import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-ingest-questions-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let addReports: (items: any[]) => number;
let applyIngestQuestionAction: any;
let completeIngestQuestionJob: any;
let failIngestQuestionJob: any;
let hydrateIngestQuestionPayload: any;
let reconcileQuestionsAfterRun: any;
let recoverIngestQuestionJobs: any;
let syncIngestQuestionReport: any;
let supplementalAnswerContent: any;
let supplementalAnswers: any;

before(async () => {
  ({ db, migrate } = await import('../lib/db.js'));
  ({ addReports } = await import('../dream/reports.js'));
  ({
    applyIngestQuestionAction,
    completeIngestQuestionJob,
    failIngestQuestionJob,
    hydrateIngestQuestionPayload,
    reconcileQuestionsAfterRun,
    recoverIngestQuestionJobs,
    syncIngestQuestionReport,
  } = await import('./ingestQuestions.js'));
  ({ supplementalAnswerContent, supplementalAnswers } = await import('./sourceLedger.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM reports;
    DELETE FROM ingest_questions;
    DELETE FROM jobs;
    DELETE FROM ingest_runs;
  `);
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function seedQuestions() {
  const runId = 'run-initial';
  const sourcePath = '原始资料/追问测试.md';
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,'completed','committed','completed',?)`
  ).run(runId, sourcePath, 'hash-initial', '2026-08-10T00:00:00.000Z');
  const insert = db.prepare(
    `INSERT INTO ingest_questions(
       id,run_id,path,question,fact_ids,acceptance,status,created_at,updated_at
     ) VALUES(?,?,?,?,?,?, 'open',?,?)`
  );
  const questions = [
    { id: 'q1', question: '负责人完整姓名是什么？', acceptance: ['给出完整姓名'] },
    { id: 'q2', question: '项目完成日期是什么？', acceptance: ['给出日期'] },
    { id: 'q3', question: '预算金额是多少？', acceptance: ['给出金额'] },
  ];
  for (const question of questions) {
    insert.run(
      question.id,
      runId,
      sourcePath,
      question.question,
      '[]',
      JSON.stringify(question.acceptance),
      '2026-08-10T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
    );
  }
  addReports([{
    kind: 'ingest_questions',
    payload: {
      path: sourcePath,
      runId,
      contentHash: 'hash-initial',
      questions,
    },
  }]);
  return { sourcePath, questions };
}

function openQuestionPayload(sourcePath: string) {
  const report = db.prepare(
    `SELECT payload FROM reports WHERE kind='ingest_questions' AND status='open' AND issue_key=?`
  ).get(sourcePath) as { payload: string };
  return hydrateIngestQuestionPayload(JSON.parse(report.payload));
}

test('answer submission is idempotent and accepted questions leave the open list', () => {
  const { sourcePath } = seedQuestions();
  const first = applyIngestQuestionAction('q1', '刘子谕', 'reprocess');
  const second = applyIngestQuestionAction('q1', '刘子谕', 'reprocess');

  assert.equal(first.status, 'answered');
  assert.equal(second.idempotent, true);
  assert.equal(second.jobId, first.jobId);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM jobs WHERE kind='ingest'`).get().count, 1);
  assert.deepEqual(
    openQuestionPayload(sourcePath).questions.map((question: any) => [question.id, question.status]),
    [['q1', 'answered'], ['q2', 'open'], ['q3', 'open']],
  );

  completeIngestQuestionJob('q1', first.jobId);
  assert.equal(db.prepare(`SELECT status FROM ingest_questions WHERE id='q1'`).get().status, 'accepted');
  assert.deepEqual(
    openQuestionPayload(sourcePath).questions.map((question: any) => question.id),
    ['q2', 'q3'],
  );
});

test('failed reprocess keeps the answer and exposes a retryable error', () => {
  const { sourcePath } = seedQuestions();
  const submitted = applyIngestQuestionAction('q1', '刘子谕', 'reprocess');
  failIngestQuestionJob('q1', submitted.jobId, new Error('模型服务暂不可用'));

  const row = db.prepare(`SELECT status,answer,error FROM ingest_questions WHERE id='q1'`).get();
  assert.deepEqual(row, { status: 'failed', answer: '刘子谕', error: '模型服务暂不可用' });
  const question = openQuestionPayload(sourcePath).questions.find((item: any) => item.id === 'q1');
  assert.equal(question.status, 'failed');
  assert.equal(question.answer, '刘子谕');

  assert.deepEqual(supplementalAnswers(sourcePath), [{
    id: 'q1',
    question: '负责人完整姓名是什么？',
    answer: '刘子谕',
    acceptance: ['给出完整姓名'],
  }]);
  assert.equal(
    supplementalAnswerContent(supplementalAnswers(sourcePath)[0]),
    '原问题：负责人完整姓名是什么？\n用户补充回答：刘子谕\n验收条件：给出完整姓名',
  );
});

test('paused reprocess remains answered until the queue resumes', () => {
  seedQuestions();
  const submitted = applyIngestQuestionAction('q1', '刘子谕', 'reprocess');
  db.prepare(`UPDATE jobs SET status='paused',stage='已停止' WHERE id=?`).run(submitted.jobId);

  recoverIngestQuestionJobs();

  assert.deepEqual(
    db.prepare(`SELECT status,answer,error FROM ingest_questions WHERE id='q1'`).get(),
    { status: 'answered', answer: '刘子谕', error: null },
  );
});

test('ignoring one question does not close its remaining siblings', () => {
  const { sourcePath } = seedQuestions();
  const result = applyIngestQuestionAction('q1', '', 'ignore');

  assert.equal(result.status, 'ignored');
  assert.equal(result.jobId, null);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM jobs`).get().count, 0);
  assert.deepEqual(
    openQuestionPayload(sourcePath).questions.map((question: any) => question.id),
    ['q2', 'q3'],
  );
});

test('a successful run with no new questions supersedes the old set and closes the report', () => {
  const { sourcePath } = seedQuestions();
  const submitted = applyIngestQuestionAction('q1', '刘子谕', 'reprocess');

  reconcileQuestionsAfterRun(sourcePath, 'run-latest');
  syncIngestQuestionReport(sourcePath);
  assert.deepEqual(
    db.prepare(`SELECT id,status FROM ingest_questions ORDER BY id`).all(),
    [
      { id: 'q1', status: 'answered' },
      { id: 'q2', status: 'superseded' },
      { id: 'q3', status: 'superseded' },
    ],
  );

  completeIngestQuestionJob('q1', submitted.jobId);
  assert.equal(
    db.prepare(`SELECT status FROM reports WHERE kind='ingest_questions' AND issue_key=?`).get(sourcePath).status,
    'resolved',
  );
});

test('migration adds job linkage and error fields', () => {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(ingest_questions)`).all() as Array<{ name: string }>).map((column) => column.name)
  );
  assert.equal(columns.has('job_id'), true);
  assert.equal(columns.has('error'), true);
});
