import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-ingest-history-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let buildIngestTrace: typeof import('./ingestHistory.js').buildIngestTrace;
let clearIngestHistory: typeof import('./ingestHistory.js').clearIngestHistory;
let getIngestHistory: typeof import('./ingestHistory.js').getIngestHistory;
let listIngestHistory: typeof import('./ingestHistory.js').listIngestHistory;

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ buildIngestTrace, clearIngestHistory, getIngestHistory, listIngestHistory } =
    await import('./ingestHistory.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM semantic_events;
    DELETE FROM ingest_history_hidden;
    DELETE FROM ingest_audit;
    DELETE FROM ingest_facts;
    DELETE FROM page_contributions;
    DELETE FROM ingest_questions;
    DELETE FROM ingest_runs;
    DELETE FROM source_versions;
    DELETE FROM pages;
  `);
});

after(() => {
  try {
    db.close();
  } catch {
    /* noop */
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

function insertRun(id: string, status: string, pathName = `原始资料/${id}.md`) {
  db.prepare(
    `INSERT INTO ingest_runs(
       id,path,content_hash,status,commit_status,derived_status,started_at,finished_at,stats
     ) VALUES(?,?,?,?,'committed','completed','2026-08-13T01:00:00.000Z',
       '2026-08-13T01:01:00.000Z','{"created":1,"merged":2}')`
  ).run(id, pathName, `hash-${id}`, status);
}

test('trace exposes the complete refinement pipeline and locates a failed stage', () => {
  const run = {
    id: 'failed-run',
    path: '原始资料/失败.md',
    content_hash: 'hash',
    status: 'failed',
    commit_status: 'failed',
    derived_status: 'failed',
    started_at: '2026-08-13T01:00:00.000Z',
    stats: '{}',
  };
  const trace = buildIngestTrace(
    run,
    [
      { id: 1, stage: 'map', at: '2026-08-13T01:00:10.000Z' },
      { id: 2, stage: 'normalize', at: '2026-08-13T01:00:20.000Z' },
      { id: 3, stage: 'retrieve', at: '2026-08-13T01:00:25.000Z' },
    ],
    [{
      id: 1,
      stage: 'ingest-plan:1',
      model_tag: 'ingest-plan',
      status: 'failed',
      error: '模型输出无效',
      duration_ms: 1200,
      created_at: '2026-08-13T01:00:30.000Z',
    }],
  );

  assert.deepEqual(
    trace.map((stage) => stage.label),
    ['解析', 'Map', 'Normalize', 'Retrieve', 'Plan', 'Critic 1', 'Critic 2', 'Compose', 'Questions', 'Verify', 'Commit'],
  );
  assert.deepEqual(
    trace.map((stage) => stage.annotation || ''),
    ['', '候选提取', '归一整理', '关联检索', '制定计划', '首次审查', '修订复核', '内容生成', '问题识别', '事实验证', '提交入库'],
  );
  assert.equal(trace.find((stage) => stage.id === 'retrieve')?.status, 'completed');
  assert.equal(trace.find((stage) => stage.id === 'plan')?.status, 'failed');
  assert.equal(trace.find((stage) => stage.id === 'compose')?.status, 'pending');
});

test('clear hides finished history without deleting provenance or active runs', () => {
  insertRun('completed-run', 'completed');
  insertRun('failed-run', 'failed');
  insertRun('running-run', 'running');
  db.prepare(
    `INSERT INTO ingest_facts(run_id,fact_id,statement,sources)
     VALUES('completed-run','fact-1','保留的事实','[]')`
  ).run();
  db.prepare(
    `INSERT INTO ingest_audit(run_id,stage,at,payload)
     VALUES('completed-run','commit','2026-08-13T01:01:00.000Z','{}')`
  ).run();

  assert.equal(listIngestHistory().total, 3);
  assert.equal(clearIngestHistory(), 2);
  const visible = listIngestHistory();

  assert.equal(visible.total, 1);
  assert.equal(visible.runs[0].id, 'running-run');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM ingest_runs`).get().count, 3);
  assert.equal(db.prepare(`SELECT statement FROM ingest_facts WHERE run_id='completed-run'`).get().statement, '保留的事实');
  assert.equal(getIngestHistory('completed-run'), null);
});

test('history list supports filtering and returns stage progress', () => {
  insertRun('alpha', 'completed', '原始资料/项目甲.md');
  insertRun('beta', 'failed', '原始资料/项目乙.md');
  for (const stage of ['map', 'normalize', 'retrieve', 'plan', 'critic_review', 'compose', 'questions', 'verify', 'commit']) {
    db.prepare(
      `INSERT INTO ingest_audit(run_id,stage,at,payload) VALUES('alpha',?,'2026-08-13T01:00:30.000Z','{}')`
    ).run(stage);
  }

  const result = listIngestHistory({ q: '项目甲', status: 'completed' });

  assert.equal(result.total, 1);
  assert.equal(result.runs[0].id, 'alpha');
  assert.equal(result.runs[0].progress, 100);
  assert.equal(result.runs[0].currentStage.label, 'Commit');
});

test('completed legacy runs infer missing stage audits as completed', () => {
  insertRun('legacy-completed', 'completed');
  db.prepare(
    `INSERT INTO ingest_audit(run_id,stage,at,payload)
     VALUES('legacy-completed','commit','2026-08-13T01:01:00.000Z','{}')`
  ).run();

  const result = listIngestHistory({ q: 'legacy-completed' });

  assert.equal(result.runs[0].progress, 100);
  assert.equal(result.runs[0].currentStage.label, 'Commit');
});
