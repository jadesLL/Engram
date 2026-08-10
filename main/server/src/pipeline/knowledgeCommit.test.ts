import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-commit-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let now: () => string;
let readPage: (path: string) => any;
let beginSourceVersion: any;
let contributionKey: any;
let markCommitStarted: any;
let storeContribution: any;
let commitKnowledgeItems: any;
let recoverKnowledgeCommit: any;
let setCandidateStatus: any;
let upsertCandidateOccurrence: any;
let reconcilePendingCandidates: any;

before(async () => {
  ({ db, migrate, now } = await import('../lib/db.js'));
  ({ readPage } = await import('../lib/vault.js'));
  ({ beginSourceVersion, contributionKey, markCommitStarted, storeContribution } = await import('./sourceLedger.js'));
  ({ commitKnowledgeItems, recoverKnowledgeCommit } = await import('./knowledgeCommit.js'));
  ({ setCandidateStatus, upsertCandidateOccurrence, reconcilePendingCandidates } = await import('./candidateLedger.js'));
  migrate();
  db.prepare(`INSERT INTO settings(key,value) VALUES('chat_models',?)`).run(JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'mock',
    apiKey: 'mock',
  }]));
  db.prepare(`INSERT INTO settings(key,value) VALUES('active_chat_model','mock')`).run();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function startRun(runId: string, sourceVersionId: string, hash: string, sourcePath = '原始资料/测试.md') {
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, sourcePath, hash, sourceVersionId, now());
}

function addFacts(runId: string, ids: string[], prefix = '测试事实') {
  const insert = db.prepare(
    `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)`
  );
  for (const id of ids) {
    const statement = `${prefix}-${id}`;
    insert.run(runId, id, statement, JSON.stringify([{ chunkId: 'c1', quote: statement }]));
  }
}

function item(content: string) {
  return {
    name: '测试项目',
    kind: 'project',
    action: 'create',
    target: '',
    domain: '测试',
    confidence: '高',
    summary: '测试项目摘要',
    factIds: ['f1', 'f2'],
    relations: [],
    reason: '',
    content,
  };
}

test('new source version replaces the previous managed contribution and queues derived work', () => {
  const v1 = beginSourceVersion('原始资料/测试.md', 'hash-1');
  startRun('run-1', v1.id, 'hash-1');
  addFacts('run-1', ['f1', 'f2'], '第一版');
  commitKnowledgeItems([item('## 核心特性\n\n第一版')], {
    runId: 'run-1',
    sourceVersion: v1,
    sourcePath: '原始资料/测试.md',
    sourceName: '测试.md',
    sourceRef: '[[测试]]',
    manualApproval: true,
  });

  const page = db.prepare(`SELECT id,path FROM pages WHERE title='测试项目'`).get();
  const first = readPage(page.path).content;
  assert.match(first, /## 当前理解/);
  assert.doesNotMatch(first, /第一版|来源提炼/);
  assert.ok(first.indexOf('## 相关页面') < first.indexOf('## 时间线'));
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='page_recompose' AND status='pending'`).get());

  const v2 = beginSourceVersion('原始资料/测试.md', 'hash-2');
  startRun('run-2', v2.id, 'hash-2');
  addFacts('run-2', ['f1', 'f2'], '第二版');
  commitKnowledgeItems([item('## 核心特性\n\n第二版')], {
    runId: 'run-2',
    sourceVersion: v2,
    sourcePath: '原始资料/测试.md',
    sourceName: '测试.md',
    sourceRef: '[[测试]]',
    manualApproval: true,
  });

  const second = readPage(page.path).content;
  assert.doesNotMatch(second, /第一版/);
  assert.doesNotMatch(second, /第二版|来源提炼/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM page_contributions WHERE page_id=? AND active=1`).get(page.id).n, 1);
  assert.equal(db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(v1.id).status, 'superseded');
  assert.equal(db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(v2.id).status, 'active');
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='page_recompose' AND status='pending'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='ingest_finalize' AND status='pending'`).get());

  const v3 = beginSourceVersion('原始资料/测试.md', 'hash-3');
  startRun('run-3', v3.id, 'hash-3');
  addFacts('run-3', ['f1', 'f2'], '恢复版本');
  storeContribution({
    pageId: page.id,
    sourceVersionId: v3.id,
    runId: 'run-3',
    contributionKey: contributionKey('原始资料/测试.md', page.id),
    factIds: ['f1', 'f2'],
    content: '## 核心特性\n\n中断后恢复的第三版',
    summary: '恢复摘要',
    domain: '测试',
    confidence: '高',
    sourceRef: '[[测试]]',
  });
  markCommitStarted('run-3');
  recoverKnowledgeCommit('run-3');
  const recovered = readPage(page.path).content;
  assert.doesNotMatch(recovered, /第二版/);
  assert.doesNotMatch(recovered, /中断后恢复的第三版|来源提炼/);
  assert.equal(db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(v3.id).status, 'active');
  assert.equal(db.prepare(`SELECT commit_status FROM ingest_runs WHERE id='run-3'`).get().commit_status, 'committed');
});

test('automatic page creation requires facts from two different source paths and reuses ignored evidence', () => {
  const firstPath = '原始资料/来源一.md';
  const secondPath = '原始资料/来源二.md';
  const firstVersion = beginSourceVersion(firstPath, 'cross-hash-1');
  startRun('cross-run-1', firstVersion.id, 'cross-hash-1', firstPath);
  addFacts('cross-run-1', ['source-1-f1'], '第一来源');
  const first = {
    ...item('## 核心事实\n\n第一来源事实'),
    name: '跨来源项目',
    factIds: ['source-1-f1'],
  };
  const firstResult = commitKnowledgeItems([first], {
    runId: 'cross-run-1',
    sourceVersion: firstVersion,
    sourcePath: firstPath,
    sourceName: '来源一.md',
    sourceRef: firstPath,
  });
  assert.deepEqual(firstResult.stats, { created: 0, merged: 0, skipped: 0, pending: 1 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM pages WHERE title='跨来源项目'`).get().n, 0);
  const ignored = db.prepare(
    `SELECT id FROM ingest_candidates WHERE run_id='cross-run-1' AND name='跨来源项目'`
  ).get();
  setCandidateStatus(ignored.id, 'ignored');

  const secondVersion = beginSourceVersion(secondPath, 'cross-hash-2');
  startRun('cross-run-2', secondVersion.id, 'cross-hash-2', secondPath);
  addFacts('cross-run-2', ['source-2-f1'], '第二来源');
  const second = {
    ...item('## 核心事实\n\n第二来源事实'),
    name: '跨来源项目',
    factIds: ['source-2-f1'],
  };
  const secondResult = commitKnowledgeItems([second], {
    runId: 'cross-run-2',
    sourceVersion: secondVersion,
    sourcePath: secondPath,
    sourceName: '来源二.md',
    sourceRef: secondPath,
  });
  assert.deepEqual(secondResult.stats, { created: 1, merged: 0, skipped: 0, pending: 0 });
  const page = db.prepare(`SELECT id,path FROM pages WHERE title='跨来源项目'`).get();
  const content = readPage(page.path).content;
  assert.doesNotMatch(content, /第一来源事实|第二来源事实|来源提炼/);
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='page_recompose' AND status='pending' AND payload LIKE ?`).get(`%${page.id}%`));
  assert.equal(
    db.prepare(`SELECT COUNT(DISTINCT sv.path) n FROM page_contributions pc JOIN source_versions sv ON sv.id=pc.source_version_id WHERE pc.page_id=? AND pc.active=1`).get(page.id).n,
    2,
  );
  assert.equal(db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(ignored.id).status, 'consumed');
});

test('ignoring a candidate does not block reruns, but a new version of the same path is still one source', () => {
  const sourcePath = '原始资料/重复来源.md';
  const firstVersion = beginSourceVersion(sourcePath, 'same-path-hash-1');
  startRun('same-path-run-1', firstVersion.id, 'same-path-hash-1', sourcePath);
  const firstResult = commitKnowledgeItems([{
    ...item('## 核心事实\n\n旧版本事实'),
    name: '同路径候选',
    factIds: ['same-f1'],
  }], {
    runId: 'same-path-run-1',
    sourceVersion: firstVersion,
    sourcePath,
    sourceName: '重复来源.md',
    sourceRef: sourcePath,
  });
  assert.equal(firstResult.stats.pending, 1);
  const firstCandidate = db.prepare(
    `SELECT id FROM ingest_candidates WHERE run_id='same-path-run-1'`
  ).get();
  setCandidateStatus(firstCandidate.id, 'ignored');

  const secondVersion = beginSourceVersion(sourcePath, 'same-path-hash-2');
  startRun('same-path-run-2', secondVersion.id, 'same-path-hash-2', sourcePath);
  const secondResult = commitKnowledgeItems([{
    ...item('## 核心事实\n\n同一路径的新版本事实'),
    name: '同路径候选',
    factIds: ['same-f2'],
  }], {
    runId: 'same-path-run-2',
    sourceVersion: secondVersion,
    sourcePath,
    sourceName: '重复来源.md',
    sourceRef: sourcePath,
  });
  assert.equal(secondResult.stats.pending, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM pages WHERE title='同路径候选'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ingest_candidates WHERE normalized_name='同路径候选'`).get().n, 2);
});

test('dynamic reconciliation hides stale reviews once two active source paths exist', () => {
  const name = '动态对账候选';
  const createOccurrence = (runId: string, sourcePath: string, hash: string) => {
    const version = beginSourceVersion(sourcePath, hash);
    startRun(runId, version.id, hash, sourcePath);
    db.prepare(
      `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)`
    ).run(runId, 'f1', `${sourcePath}的事实`, JSON.stringify([{ chunkId: 'c1', quote: `${sourcePath}的事实` }]));
    db.prepare(`UPDATE source_versions SET status='active',activated_at=? WHERE id=?`).run(now(), version.id);
    return upsertCandidateOccurrence({
      ...item(`## 核心事实\n\n${sourcePath}的事实`),
      name,
      factIds: ['f1'],
      action: 'review',
    }, {
      runId,
      sourceVersionId: version.id,
      sourcePath,
      sourceName: path.posix.basename(sourcePath),
    });
  };
  const first = createOccurrence('reconcile-run-1', '原始资料/动态一.md', 'reconcile-hash-1');
  createOccurrence('reconcile-run-2', '原始资料/动态二.md', 'reconcile-hash-2');
  const payload = JSON.stringify({
    candidateId: first.id,
    name,
    kind: 'project',
    source: '动态一.md',
    sourcePath: '原始资料/动态一.md',
    sourceVersionId: first.source_version_id,
    runId: first.run_id,
    factIds: ['f1'],
    content: '旧待审草稿',
  });
  db.prepare(
    `INSERT INTO reports(run_at,kind,payload,status,issue_key,fingerprint)
     VALUES(?,'pending_review',?,'open',?,?)`
  ).run(now(), payload, `dynamic:${name}`, 'dynamic-fingerprint');

  assert.equal(reconcilePendingCandidates(), 1);
  assert.equal(
    db.prepare(`SELECT status FROM reports WHERE issue_key=?`).get(`dynamic:${name}`).status,
    'applying',
  );
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='candidate_reconcile' AND status='pending'`).get());
});
