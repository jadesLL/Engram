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

before(async () => {
  ({ db, migrate, now } = await import('../lib/db.js'));
  ({ readPage } = await import('../lib/vault.js'));
  ({ beginSourceVersion, contributionKey, markCommitStarted, storeContribution } = await import('./sourceLedger.js'));
  ({ commitKnowledgeItems, recoverKnowledgeCommit } = await import('./knowledgeCommit.js'));
  migrate();
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function startRun(runId: string, sourceVersionId: string, hash: string) {
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, '原始资料/测试.md', hash, sourceVersionId, now());
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
  commitKnowledgeItems([item('## 核心特性\n\n第一版')], {
    runId: 'run-1',
    sourceVersion: v1,
    sourcePath: '原始资料/测试.md',
    sourceName: '测试.md',
    sourceRef: '[[测试]]',
  });

  const page = db.prepare(`SELECT id,path FROM pages WHERE title='测试项目'`).get();
  const first = readPage(page.path).content;
  assert.match(first, /## 当前理解/);
  assert.match(first, /第一版/);
  assert.ok(first.indexOf('## 相关页面') < first.indexOf('## 时间线'));

  const v2 = beginSourceVersion('原始资料/测试.md', 'hash-2');
  startRun('run-2', v2.id, 'hash-2');
  commitKnowledgeItems([item('## 核心特性\n\n第二版')], {
    runId: 'run-2',
    sourceVersion: v2,
    sourcePath: '原始资料/测试.md',
    sourceName: '测试.md',
    sourceRef: '[[测试]]',
  });

  const second = readPage(page.path).content;
  assert.doesNotMatch(second, /第一版/);
  assert.match(second, /第二版/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM page_contributions WHERE page_id=? AND active=1`).get(page.id).n, 1);
  assert.equal(db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(v1.id).status, 'superseded');
  assert.equal(db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(v2.id).status, 'active');
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='process' AND status='pending'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM jobs WHERE kind='ingest_finalize' AND status='pending'`).get());

  const v3 = beginSourceVersion('原始资料/测试.md', 'hash-3');
  startRun('run-3', v3.id, 'hash-3');
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
  assert.match(recovered, /中断后恢复的第三版/);
  assert.equal(db.prepare(`SELECT status FROM source_versions WHERE id=?`).get(v3.id).status, 'active');
  assert.equal(db.prepare(`SELECT commit_status FROM ingest_runs WHERE id='run-3'`).get().commit_status, 'committed');
});
