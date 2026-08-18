import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-decide-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let now: () => string;
let createPage: (dir: string, title: string) => any;
let readPage: (path: string) => any;
let readPageMeta: (path: string) => any;
let writePage: (path: string, content: string, extra?: Record<string, any>) => any;
let addReports: (items: any[]) => number;
let decideReport: (id: number, option: string, input?: any) => Promise<{ status: string }>;
let decideReportGroup: (ids: number[], option: string, input?: any) => Promise<{ status: string; async?: boolean; jobId?: number }>;

before(async () => {
  // mergePages 需要 LLM 做语义去重;mock 只响应合并 prompt,返回空增量。
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url?.endsWith('/embeddings')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: (body.input || []).map((_: unknown, index: number) => ({ index, embedding: Array(1536).fill(0) })),
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ addition: '', rationale: '测试合并' }) },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  const models = [{
    id: 'mock', name: 'mock', provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock', apiKey: 'mock', dim: 1536,
  }];
  dbModule.setSetting('chat_models', JSON.stringify(models));
  dbModule.setSetting('active_chat_model', 'mock');
  dbModule.setSetting('embedding_models', JSON.stringify(models));
  dbModule.setSetting('active_embedding_model', 'mock');
  ({ createPage, readPage, readPageMeta, writePage } = await import('../lib/vault.js'));
  ({ addReports } = await import('./reports.js'));
  ({ decideReport, decideReportGroup } = await import('./decide.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function clear() {
  db.exec(`DELETE FROM reports; DELETE FROM jobs; DELETE FROM edges; DELETE FROM chunks;
    DELETE FROM pages_fts; DELETE FROM pages; DELETE FROM ingest_questions;
    DELETE FROM ingest_candidates; DELETE FROM ingest_facts; DELETE FROM ingest_runs;
    DELETE FROM source_versions; DELETE FROM page_contributions; DELETE FROM page_syntheses;`);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  fs.mkdirSync(path.join(temp, 'brain'), { recursive: true });
}

function reportIdOf(kind: string): number {
  return (db.prepare(`SELECT id FROM reports WHERE kind=? AND status='open' ORDER BY id DESC LIMIT 1`).get(kind) as any).id;
}

function reportStatus(id: number): string {
  return (db.prepare(`SELECT status FROM reports WHERE id=?`).get(id) as any).status;
}

test('deadlink:create 按建议类型建页,create-custom 用输入类型,dismiss 忽略', async () => {
  clear();
  const src = createPage('Wiki/概念', '来源页');
  addReports([{ kind: 'deadlink', payload: { srcId: src.id, srcTitle: '来源页', deadTitle: '新组织', suggestedType: 'org' } }]);
  const first = reportIdOf('deadlink');
  assert.equal((await decideReport(first, 'create')).status, 'resolved');
  const created = db.prepare(`SELECT type, path FROM pages WHERE title='新组织' AND deleted=0`).get() as any;
  assert.equal(created.type, 'org');
  assert.match(created.path, /^Wiki\/实体\//);

  addReports([{ kind: 'deadlink', payload: { srcId: src.id, srcTitle: '来源页', deadTitle: '新概念' } }]);
  const second = reportIdOf('deadlink');
  await decideReport(second, 'create-custom', { pageType: 'concept' });
  assert.equal((db.prepare(`SELECT type FROM pages WHERE title='新概念' AND deleted=0`).get() as any).type, 'concept');

  addReports([{ kind: 'deadlink', payload: { srcId: src.id, srcTitle: '来源页', deadTitle: '不建' } }]);
  const third = reportIdOf('deadlink');
  assert.equal((await decideReport(third, 'dismiss')).status, 'dismissed');
  assert.ok(!db.prepare(`SELECT id FROM pages WHERE title='不建' AND deleted=0`).get());

  addReports([{ kind: 'deadlink', payload: { srcId: src.id, srcTitle: '来源页', deadTitle: '坏类型' } }]);
  const fourth = reportIdOf('deadlink');
  await assert.rejects(decideReport(fourth, 'create-custom', { pageType: 'weird' }), /页面类型无效/);
  assert.equal(reportStatus(fourth), 'open', '失败后报告应回滚为 open');
});

test('duplicate:keep_a 合并归档 B,keep_both 仅关闭报告', async () => {
  clear();
  const a = createPage('Wiki/概念', '甲页');
  const b = createPage('Wiki/概念', '乙页');
  writePage(a.path, '# 甲页\n\nA 内容', { type: 'concept' });
  writePage(b.path, '# 乙页\n\nB 内容', { type: 'concept' });
  addReports([{ kind: 'duplicate', payload: { a: { id: a.id, title: '甲页' }, b: { id: b.id, title: '乙页' } } }]);
  assert.equal((await decideReport(reportIdOf('duplicate'), 'keep_a')).status, 'resolved');
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(a.id) as any).path,
    /^Wiki\/概念\//,
  );
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(b.id) as any).path,
    /^Wiki\/归档\//,
    'B 应移入归档目录',
  );

  const c = createPage('Wiki/概念', '丙页');
  const d = createPage('Wiki/概念', '丁页');
  addReports([{ kind: 'duplicate', payload: { a: { id: c.id, title: '丙页' }, b: { id: d.id, title: '丁页' } } }]);
  assert.equal((await decideReport(reportIdOf('duplicate'), 'keep_both')).status, 'dismissed');
  assert.ok(db.prepare(`SELECT id FROM pages WHERE id=? AND deleted=0`).get(c.id));
  assert.ok(db.prepare(`SELECT id FROM pages WHERE id=? AND deleted=0`).get(d.id));
});

test('identity_ambiguity:merge 合并到建议目标,rename 重命名澄清,dismiss 标记误报', async () => {
  clear();
  const target = createPage('Wiki/实体', '张三(产品)');
  writePage(target.path, '# 张三(产品)\n\n## 当前理解\n\n已有内容', { type: 'person' });
  const ambiguous = createPage('Wiki/实体', '张三');
  writePage(ambiguous.path, '# 张三\n\n## 当前理解\n\n歧义内容', { type: 'person' });
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: ambiguous.id, title: '张三', type: 'person', suggestedTargetId: target.id, suggestedTargetTitle: '张三(产品)' },
  }]);
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'merge')).status, 'resolved');
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(ambiguous.id) as any).path,
    /^Wiki\/归档\//,
    '歧义页应移入归档目录',
  );

  const renamed = createPage('Wiki/实体', '李四');
  writePage(renamed.path, '# 李四\n\n内容', { type: 'person' });
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: renamed.id, title: '李四', type: 'person', suggestedTargetId: '', suggestedTargetTitle: '' },
  }]);
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'rename', { newTitle: '李四(销售)' })).status, 'resolved');
  assert.ok(db.prepare(`SELECT id FROM pages WHERE title='李四(销售)' AND deleted=0`).get());

  const kept = createPage('Wiki/实体', '王五');
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: kept.id, title: '王五', type: 'person', suggestedTargetId: '', suggestedTargetTitle: '' },
  }]);
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'dismiss')).status, 'dismissed');
  assert.ok(db.prepare(`SELECT id FROM pages WHERE id=? AND deleted=0`).get(kept.id));
});

test('missing_sections/stale:补章节与复核写回页面元信息', async () => {
  clear();
  const entity = createPage('Wiki/实体', '缺章节实体');
  writePage(entity.path, '# 缺章节实体\n\n正文', { type: 'person' });
  addReports([{ kind: 'missing_sections', payload: { pageId: entity.id, title: '缺章节实体', missing: ['当前理解', '时间线'] } }]);
  assert.equal((await decideReport(reportIdOf('missing_sections'), 'repair')).status, 'resolved');
  const repaired = readPage(entity.path).content;
  assert.match(repaired, /## 当前理解/);
  assert.match(repaired, /## 时间线/);

  const stale = createPage('Wiki/概念', '旧页面');
  writePage(stale.path, '# 旧页面\n\n内容', { type: 'concept' });
  addReports([{ kind: 'stale', payload: { pageId: stale.id, title: '旧页面' } }]);
  assert.equal((await decideReport(reportIdOf('stale'), 'review')).status, 'resolved');
  assert.ok(readPageMeta(stale.path).reviewed_at, '复核应写入 reviewed_at(frontmatter 最后复核日期)');
});

test('contradiction/single_source/enrich:纯状态流转', async () => {
  clear();
  const page = createPage('Wiki/概念', '某页');
  addReports([{ kind: 'contradiction', payload: { a: { id: page.id, title: '某页' }, b: { id: 'b', title: '另一页' } } }]);
  assert.equal((await decideReport(reportIdOf('contradiction'), 'resolve')).status, 'resolved');
  addReports([{ kind: 'single_source', payload: { pageId: page.id, title: '某页', source: 'A.md' } }]);
  assert.equal((await decideReport(reportIdOf('single_source'), 'resolve')).status, 'resolved');
  addReports([{ kind: 'enrich', payload: { pageId: page.id, title: '某页', detail: '待丰富' } }]);
  assert.equal((await decideReport(reportIdOf('enrich'), 'dismiss')).status, 'dismissed');
  await assert.rejects(decideReport(999999, 'dismiss'), /报告不存在/);
});

test('ingest_questions:resolve 接受全部问题,dismiss 忽略全部', async () => {
  clear();
  const abs = path.join(temp, 'brain', '原始资料', '追问.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '资料内容');
  const runId = 'decide-q-run';
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,NULL,'running','pending','pending',?)`
  ).run(runId, '原始资料/追问.md', `${runId}-hash`, now());
  const insert = db.prepare(
    `INSERT INTO ingest_questions(id,run_id,source_version_id,path,question,fact_ids,acceptance,answer,status,created_at,updated_at)
     VALUES(?,?,NULL,?,?,'[]','[]','','open',?,?)`
  );
  insert.run('dq1', runId, '原始资料/追问.md', '问题一', now(), now());
  const { syncAllIngestQuestionReports } = await import('../pipeline/ingestQuestions.js');
  syncAllIngestQuestionReports();
  const id = reportIdOf('ingest_questions');
  assert.equal((await decideReport(id, 'resolve')).status, 'resolved');
  assert.equal(db.prepare(`SELECT status FROM ingest_questions WHERE id='dq1'`).get().status, 'accepted');

  insert.run('dq2', runId, '原始资料/追问.md', '问题二', now(), now());
  syncAllIngestQuestionReports();
  const second = reportIdOf('ingest_questions');
  assert.equal((await decideReport(second, 'dismiss')).status, 'dismissed');
  assert.equal(db.prepare(`SELECT status FROM ingest_questions WHERE id='dq2'`).get().status, 'ignored');
});

test('并发与非法输入:已处理报告返回 409 语义,pending_review 拒绝走 decide', async () => {
  clear();
  const page = createPage('Wiki/概念', '并发页');
  addReports([{ kind: 'single_source', payload: { pageId: page.id, title: '并发页', source: 'A.md' } }]);
  const id = reportIdOf('single_source');
  await decideReport(id, 'resolve');
  await assert.rejects(decideReport(id, 'resolve'), /已处理/);

  addReports([{ kind: 'pending_review', payload: { name: '某候选', kind: 'concept' } }]);
  await assert.rejects(decideReport(reportIdOf('pending_review'), 'resolve'), /不支持/);

  // 同 issueKey+指纹的已关闭报告不会复活(addReports 既有幂等语义),换不同来源新建
  addReports([{ kind: 'single_source', payload: { pageId: page.id, title: '并发页', source: 'B.md' } }]);
  await assert.rejects(decideReport(reportIdOf('single_source'), 'bogus'), /处理动作无效/);
});

test('聚合组:keep_both 同步关闭重复与矛盾,两页都保留', async () => {
  clear();
  const a = createPage('Wiki/概念', '甲页');
  const b = createPage('Wiki/概念', '乙页');
  writePage(a.path, '# 甲页\n\nA 内容', { type: 'concept' });
  writePage(b.path, '# 乙页\n\nB 内容', { type: 'concept' });
  const payload = { a: { id: a.id, title: '甲页' }, b: { id: b.id, title: '乙页' } };
  addReports([{ kind: 'duplicate', payload }]);
  addReports([{ kind: 'contradiction', payload }]);
  const dupId = reportIdOf('duplicate');
  const conId = reportIdOf('contradiction');
  const result = await decideReportGroup([dupId, conId], 'keep_both');
  assert.equal(result.status, 'dismissed');
  assert.equal(reportStatus(dupId), 'dismissed');
  assert.equal(reportStatus(conId), 'dismissed');
  assert.ok(db.prepare(`SELECT id FROM pages WHERE id=? AND deleted=0`).get(a.id));
  assert.ok(db.prepare(`SELECT id FROM pages WHERE id=? AND deleted=0`).get(b.id));
});

test('聚合组:keep_a 异步入队合并,矛盾报告同步关闭,任务完成后归档', async () => {
  clear();
  const a = createPage('Wiki/概念', '甲页');
  const b = createPage('Wiki/概念', '乙页');
  writePage(a.path, '# 甲页\n\nA 内容', { type: 'concept' });
  writePage(b.path, '# 乙页\n\nB 内容', { type: 'concept' });
  const payload = { a: { id: a.id, title: '甲页' }, b: { id: b.id, title: '乙页' } };
  addReports([{ kind: 'duplicate', payload }]);
  addReports([{ kind: 'contradiction', payload }]);
  const dupId = reportIdOf('duplicate');
  const conId = reportIdOf('contradiction');
  const result = await decideReportGroup([dupId, conId], 'keep_a');
  assert.equal(result.async, true, '合并动作应异步入队');
  assert.ok(result.jobId, '应返回 jobId 供前端轮询进度');
  assert.equal(reportStatus(dupId), 'applying', '合并报告在任务执行前保持 applying');
  assert.equal(reportStatus(conId), 'resolved', '矛盾报告同步关闭');
  const job = db.prepare(`SELECT kind, status FROM jobs WHERE id=?`).get(result.jobId) as any;
  assert.equal(job.kind, 'dream_apply');
  // 手动执行队列任务完成合并(测试环境队列不自动运行)
  const { applyReportDecisions } = await import('./apply.js');
  await applyReportDecisions('duplicate', [{ reportId: dupId, action: 'keep_a' }]);
  assert.equal(reportStatus(dupId), 'resolved');
  assert.match((db.prepare(`SELECT path FROM pages WHERE id=?`).get(b.id) as any).path, /^Wiki\/归档\//);
});
