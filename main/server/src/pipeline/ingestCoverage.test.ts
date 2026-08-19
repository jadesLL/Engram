import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-coverage-'));
process.env.DATA_DIR = temp;

let db: any;
let now: () => string;
let buildIngestCoverage: () => any;
let pathsNeedingIngest: () => string[];

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  ({ buildIngestCoverage, pathsNeedingIngest } = await import('./ingestCoverage.js'));
});

beforeEach(() => {
  db.exec(`DELETE FROM ingest_log; DELETE FROM file_extractions; DELETE FROM files;
    DELETE FROM jobs; DELETE FROM ingest_runs; DELETE FROM pages_fts; DELETE FROM pages;`);
  fs.rmSync(path.join(temp, 'brain', '原始资料'), { recursive: true, force: true });
  fs.mkdirSync(path.join(temp, 'brain', '原始资料'), { recursive: true });
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function writeRaw(rel: string, content: string): string {
  const abs = path.join(temp, 'brain', ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function markIngested(rel: string, contentHash: string, status = 'completed') {
  db.prepare(
    `INSERT INTO ingest_log(path, at, content_hash, status, run_id, error) VALUES(?,?,?,?,?,?)`
  ).run(rel, now(), contentHash, status, `${rel}-run`, status === 'failed' ? '测试失败原因' : null);
}

test('覆盖率:已整理/未整理/失败/不支持四态分类正确', () => {
  const hashA = writeRaw('原始资料/已整理.md', '已整理内容');
  markIngested('原始资料/已整理.md', hashA);
  writeRaw('原始资料/未整理.md', '未整理内容');
  writeRaw('原始资料/失败.md', '失败内容');
  markIngested('原始资料/失败.md', 'any', 'failed');
  writeRaw('原始资料/图片.exe', 'binary');

  const report = buildIngestCoverage();
  assert.equal(report.total, 4);
  assert.equal(report.counts.ingested, 1);
  assert.equal(report.counts.pending, 1);
  assert.equal(report.counts.ingest_failed, 1);
  assert.equal(report.counts.unsupported, 1);
  // 需要关注的:失败在前,未整理在后,已整理与不支持的排除
  assert.deepEqual(report.attention.map((item: any) => item.name), ['失败.md', '未整理.md']);
  assert.equal(report.attention[0].error, '测试失败原因');
});

test('覆盖率:内容变更后标记为 outdated 并进入待处理', () => {
  const oldHash = writeRaw('原始资料/变更.md', '旧内容');
  markIngested('原始资料/变更.md', oldHash);
  // 文件内容被修改
  writeRaw('原始资料/变更.md', '新内容改了');
  const report = buildIngestCoverage();
  const item = report.items.find((entry: any) => entry.name === '变更.md');
  assert.equal(item.status, 'outdated');
  assert.equal(report.counts.outdated, 1);
  assert.ok(report.attention.some((entry: any) => entry.name === '变更.md'));
});

test('覆盖率:进行中的任务显示为 running 而非 pending', () => {
  writeRaw('原始资料/整理中.md', '内容');
  db.prepare(
    `INSERT INTO jobs(kind,payload,status,created_at,updated_at,run_token,cancel_requested)
     VALUES('ingest',?,'running',?,?,'tok',0)`
  ).run(JSON.stringify({ path: '原始资料/整理中.md' }), now(), now());
  const report = buildIngestCoverage();
  const item = report.items.find((entry: any) => entry.name === '整理中.md');
  assert.equal(item.status, 'running');
  assert.ok(!report.attention.some((entry: any) => entry.name === '整理中.md'), '进行中不算待处理');
});

test('一键补齐:只返回失败/未整理/过期,不含已整理与不支持的', () => {
  const hashA = writeRaw('原始资料/好.md', '好内容');
  markIngested('原始资料/好.md', hashA);
  writeRaw('原始资料/补1.md', '补1');
  writeRaw('原始资料/补2.md', '补2');
  markIngested('原始资料/补2.md', 'x', 'failed');
  writeRaw('原始资料/跳过.xyz', 'binary');
  const paths = pathsNeedingIngest();
  assert.deepEqual(paths.sort(), ['原始资料/补1.md', '原始资料/补2.md']);
});
