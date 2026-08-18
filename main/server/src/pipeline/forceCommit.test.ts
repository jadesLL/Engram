import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-force-commit-'));
process.env.DATA_DIR = temp;

let db: any;
let now: () => string;
let createPage: (dir: string, title: string) => any;
let readPage: (path: string) => any;
let addReports: (items: any[]) => number;
let beginSourceVersion: any;
let activateSourceVersion: any;
let upsertCandidateOccurrence: any;
let forceCommitCandidate: (reportId: number) => { id: string; path: string; name: string; kind: string };

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  ({ createPage, readPage } = await import('../lib/vault.js'));
  ({ addReports } = await import('../dream/reports.js'));
  ({ beginSourceVersion, activateSourceVersion } = await import('./sourceLedger.js'));
  ({ upsertCandidateOccurrence } = await import('./candidateLedger.js'));
  ({ forceCommitCandidate } = await import('./candidateReview.js'));
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function clear() {
  db.exec(`DELETE FROM reports; DELETE FROM jobs; DELETE FROM edges; DELETE FROM chunks;
    DELETE FROM pages_fts; DELETE FROM pages; DELETE FROM ingest_candidates; DELETE FROM ingest_facts;
    DELETE FROM ingest_runs; DELETE FROM source_versions; DELETE FROM ingest_questions;
    DELETE FROM page_contributions; DELETE FROM page_syntheses;`);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  fs.mkdirSync(path.join(temp, 'brain'), { recursive: true });
}

function seedCandidate(name: string, runId: string, sourcePath: string, draft: string) {
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
  ).run(runId, `${runId}-f1`, `${name}有一条可追溯事实`, JSON.stringify([{ chunkId: 'c1', quote: `${name}有一条可追溯事实` }]));
  activateSourceVersion(version.id, runId);
  const candidate = upsertCandidateOccurrence({
    name, kind: 'project', action: 'review', target: '', domain: '测试',
    confidence: '中', summary: `${name}摘要`, factIds: [`${runId}-f1`],
    relations: [], reason: '需要至少两个不同原始资料来源支持才能自动建页',
    content: draft, evidenceEligible: true,
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
      factIds: [`${runId}-f1`], content: draft, summary: `${name}摘要`,
      reason: '需要至少两个不同原始资料来源支持才能自动建页',
    },
  }]);
  const report = db.prepare(
    `SELECT id FROM reports WHERE kind='pending_review' AND status='open' ORDER BY id DESC LIMIT 1`
  ).get() as { id: number };
  return { candidate, reportId: report.id, version };
}

test('强制建立:单来源候选直接建页,正文注入未交叉验证提示块', () => {
  clear();
  const { candidate, reportId } = seedCandidate('强制建立项目', 'fc-run-1', '原始资料/强制.md', '候选草稿正文。');
  const result = forceCommitCandidate(reportId);
  assert.equal(result.name, '强制建立项目');
  assert.equal(result.kind, 'project');
  assert.match(result.path, /^Wiki\/实体\//);
  const content = readPage(result.path).content;
  assert.match(content, /人工强制建立/);
  assert.match(content, /候选草稿正文/);
  assert.equal((db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId) as any).status, 'resolved');
  assert.equal((db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(candidate.id) as any).status, 'approved');
  const payload = JSON.parse((db.prepare(`SELECT payload FROM reports WHERE id=?`).get(reportId) as any).payload);
  assert.equal(payload.review.decision, 'force_create');
  assert.equal(payload.review.target, result.id);
});

test('强制建立幂等:重复提交被拒绝', () => {
  clear();
  const { reportId } = seedCandidate('幂等项目', 'fc-run-2', '原始资料/幂等.md', '草稿。');
  forceCommitCandidate(reportId);
  assert.throws(() => forceCommitCandidate(reportId), /已处理|不存在/);
});

test('强制建立:同名页已存在时并入已有页面', () => {
  clear();
  const existing = createPage('Wiki/实体', '已有项目');
  const { candidate, reportId } = seedCandidate('已有项目', 'fc-run-3', '原始资料/已有.md', '新增的来源内容。');
  const result = forceCommitCandidate(reportId);
  assert.equal(result.id, existing.id);
  const content = readPage(existing.path).content;
  assert.match(content, /人工强制建立/);
  assert.match(content, /新增的来源内容/);
  assert.equal((db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(candidate.id) as any).status, 'merged');
});

test('强制建立:同实体其他来源候选一并并入并被消耗', () => {
  clear();
  const first = seedCandidate('多来源项目', 'fc-run-5a', '原始资料/多A.md', 'A 来源草稿。');
  const second = seedCandidate('多来源项目', 'fc-run-5b', '原始资料/多B.md', 'B 来源草稿。');
  const result = forceCommitCandidate(first.reportId);
  const content = readPage(result.path).content;
  assert.match(content, /A 来源草稿/);
  assert.equal((db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(first.candidate.id) as any).status, 'approved');
  assert.equal((db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(second.candidate.id) as any).status, 'consumed');
  assert.equal((db.prepare(`SELECT status FROM reports WHERE id=?`).get(second.reportId) as any).status, 'resolved');
  const contributions = db.prepare(
    `SELECT COUNT(*) n FROM page_contributions WHERE page_id=? AND active=1`
  ).get(result.id) as { n: number };
  assert.equal(contributions.n, 2, '两个来源都应记录为页面贡献');
});

test('来源版本失效后拒绝强制建立', () => {
  clear();
  const { reportId, version } = seedCandidate('失效项目', 'fc-run-4', '原始资料/失效.md', '草稿。');
  db.prepare(`UPDATE source_versions SET status='superseded' WHERE id=?`).run(version.id);
  assert.throws(() => forceCommitCandidate(reportId), /已更新/);
  assert.equal(
    (db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId) as any).status,
    'open',
    '失败的强制建立不应关闭报告',
  );
});
