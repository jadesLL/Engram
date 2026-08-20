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
let reopenReport: (id: number) => void;

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
        message: {
          content: JSON.stringify({
            content: '# 合并结果\n\n## 当前理解\n\n综合后的内容。\n\n## 相关页面\n\n\n## 时间线\n\n',
            aliases: [],
            rationale: '测试合并',
          }),
        },
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
  ({ decideReport, decideReportGroup, reopenReport } = await import('./decide.js'));
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

test('identity_ambiguity:mergeKeep=page 反转方向,保留歧义页归档目标页', async () => {
  clear();
  const target = createPage('Wiki/实体', '赵六(研发)');
  writePage(target.path, '# 赵六(研发)\n\n## 当前理解\n\n目标内容', { type: 'person' });
  const ambiguous = createPage('Wiki/实体', '赵六');
  writePage(ambiguous.path, '# 赵六\n\n## 当前理解\n\n歧义内容', { type: 'person' });
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: ambiguous.id, title: '赵六', type: 'person', suggestedTargetId: target.id, suggestedTargetTitle: '赵六(研发)' },
  }]);
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'merge', { mergeKeep: 'page' })).status, 'resolved');
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(ambiguous.id) as any).path,
    /^Wiki\/实体\//,
    '歧义页应保留在实体目录',
  );
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(target.id) as any).path,
    /^Wiki\/归档\//,
    '建议目标页应移入归档目录',
  );
});

test('identity_ambiguity:同一对页面的镜像报告去重,合并后其余 open 报告一并关闭', async () => {
  clear();
  const pageA = createPage('Wiki/实体', '镜像甲');
  writePage(pageA.path, '# 镜像甲\n\n## 当前理解\n\n甲内容', { type: 'person' });
  const pageB = createPage('Wiki/实体', '镜像乙');
  writePage(pageB.path, '# 镜像乙\n\n## 当前理解\n\n乙内容', { type: 'person' });

  // A→B 与 B→A 两个方向各产出一条(带 key=单页 id 的真实扫描形态):归一后是同一 issueKey,幂等只留一条
  addReports([
    { kind: 'identity_ambiguity', payload: { key: pageA.id, pageId: pageA.id, title: pageA.title, type: 'person', suggestedTargetId: pageB.id, suggestedTargetTitle: pageB.title } },
  ]);
  addReports([
    { kind: 'identity_ambiguity', payload: { key: pageB.id, pageId: pageB.id, title: pageB.title, type: 'person', suggestedTargetId: pageA.id, suggestedTargetTitle: pageA.title } },
  ]);
  const openReports = db.prepare(`SELECT id FROM reports WHERE kind='identity_ambiguity' AND status='open'`).all() as any[];
  assert.equal(openReports.length, 1, '镜像方向的第二条不得再建,同一对只问一次');

  // 模拟存量库里已存在的镜像旧记录:手动插入第二条 open,合并后也必须联动关闭
  db.prepare(
    `INSERT INTO reports(run_at, kind, payload, status, issue_key, fingerprint) VALUES(?, 'identity_ambiguity', ?, 'open', 'legacy-mirror', 'legacy-mirror')`
  ).run(now(), JSON.stringify({
    pageId: pageB.id, title: pageB.title, type: 'person',
    suggestedTargetId: pageA.id, suggestedTargetTitle: pageA.title,
  }));
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'merge')).status, 'resolved');
  const remaining = db.prepare(
    `SELECT count(*) n FROM reports WHERE kind='identity_ambiguity' AND status='open'`
  ).get() as any;
  assert.equal(remaining.n, 0, '合并后同对的 open 镜像报告一并关闭');
});

test('identity_ambiguity:finalTitle 合并后保留页改名,同名跳过改名', async () => {  clear();
  const target = createPage('Wiki/实体', '孙七(产品)');
  writePage(target.path, '# 孙七(产品)\n\n## 当前理解\n\n目标内容', { type: 'person' });
  const ambiguous = createPage('Wiki/实体', '孙七');
  writePage(ambiguous.path, '# 孙七\n\n## 当前理解\n\n歧义内容', { type: 'person' });
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: ambiguous.id, title: '孙七', type: 'person', suggestedTargetId: target.id, suggestedTargetTitle: '孙七(产品)' },
  }]);
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'merge', { finalTitle: '孙七(综合)' })).status, 'resolved');
  assert.ok(
    db.prepare(`SELECT id FROM pages WHERE title='孙七(综合)' AND deleted=0`).get(),
    '保留页应改名为自定义标题',
  );
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(ambiguous.id) as any).path,
    /^Wiki\/归档\//,
    '歧义页仍被归档',
  );

  // finalTitle 与保留页现名相同:跳过改名不报错
  const target2 = createPage('Wiki/实体', '周八(运营)');
  writePage(target2.path, '# 周八(运营)\n\n## 当前理解\n\n内容', { type: 'person' });
  const ambiguous2 = createPage('Wiki/实体', '周八');
  writePage(ambiguous2.path, '# 周八\n\n## 当前理解\n\n内容', { type: 'person' });
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: ambiguous2.id, title: '周八', type: 'person', suggestedTargetId: target2.id, suggestedTargetTitle: '周八(运营)' },
  }]);
  assert.equal((await decideReport(reportIdOf('identity_ambiguity'), 'merge', { finalTitle: '周八(运营)' })).status, 'resolved');
  assert.ok(db.prepare(`SELECT id FROM pages WHERE title='周八(运营)' AND deleted=0`).get());
});

test('identity_ambiguity:异步合并任务携带 input,执行时按用户选择反转方向', async () => {
  clear();
  const target = createPage('Wiki/实体', '吴九(市场)');
  writePage(target.path, '# 吴九(市场)\n\n## 当前理解\n\n目标内容', { type: 'person' });
  const ambiguous = createPage('Wiki/实体', '吴九');
  writePage(ambiguous.path, '# 吴九\n\n## 当前理解\n\n歧义内容', { type: 'person' });
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: ambiguous.id, title: '吴九', type: 'person', suggestedTargetId: target.id, suggestedTargetTitle: '吴九(市场)' },
  }]);
  const reportId = reportIdOf('identity_ambiguity');
  const result = await decideReportGroup([reportId], 'merge', { mergeKeep: 'page', finalTitle: '吴九(负责人)' });
  assert.equal(result.async, true, 'identity 合并应异步入队');
  assert.ok(result.jobId);
  assert.equal(reportStatus(reportId), 'applying', '合并报告在任务执行前保持 applying');
  // 任务 payload 中的 decision 应携带 input
  const job = db.prepare(`SELECT payload FROM jobs WHERE id=?`).get(result.jobId) as any;
  const decisions = JSON.parse(job.payload).decisions;
  assert.equal(decisions[0].input.mergeKeep, 'page');
  assert.equal(decisions[0].input.finalTitle, '吴九(负责人)');
  // 手动执行队列任务(测试环境队列不自动运行)
  const { applyReportDecisions } = await import('./apply.js');
  await applyReportDecisions('identity_ambiguity', decisions);
  assert.equal(reportStatus(reportId), 'resolved');
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(target.id) as any).path,
    /^Wiki\/归档\//,
    '目标页应按 mergeKeep=page 被归档',
  );
  assert.ok(
    db.prepare(`SELECT id FROM pages WHERE title='吴九(负责人)' AND deleted=0`).get(),
    '保留页应按 finalTitle 改名',
  );
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

test('重新打开:已阅报告恢复待处理,已处理报告拒绝重开', async () => {
  clear();
  const page = createPage('Wiki/概念', '重开页');
  addReports([{ kind: 'single_source', payload: { pageId: page.id, title: '重开页', source: 'A.md' } }]);
  const id = reportIdOf('single_source');
  await decideReport(id, 'dismiss');
  assert.equal(reportStatus(id), 'dismissed');
  reopenReport(id);
  assert.equal(reportStatus(id), 'open', '已阅报告应恢复为待处理');
  // 幂等:open 状态重复调不报错
  reopenReport(id);
  assert.equal(reportStatus(id), 'open');

  // resolved(已执行实际动作)不可重开
  addReports([{ kind: 'single_source', payload: { pageId: page.id, title: '重开页', source: 'C.md' } }]);
  const resolvedId = reportIdOf('single_source');
  await decideReport(resolvedId, 'resolve');
  assert.equal(reportStatus(resolvedId), 'resolved');
  assert.throws(() => reopenReport(resolvedId), /不能重新打开/);
});

test('重新打开待入库候选:候选恢复 open 重新进入对账通道', async () => {
  clear();
  const abs = path.join(temp, 'brain', '原始资料', '重开候选.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '重开候选的资料内容。');
  const { beginSourceVersion, activateSourceVersion } = await import('../pipeline/sourceLedger.js');
  const { upsertCandidateOccurrence, getCandidate } = await import('../pipeline/candidateLedger.js');
  const version = beginSourceVersion('原始资料/重开候选.md', 'reopen-run-hash');
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run('reopen-run', '原始资料/重开候选.md', 'reopen-run-hash', version.id, now());
  activateSourceVersion(version.id, 'reopen-run');
  const candidate = upsertCandidateOccurrence({
    candidateId: '', name: '重开候选', kind: 'concept', action: 'review', target: '', domain: '',
    confidence: '中', summary: '摘要', factIds: [], relations: [],
    reason: '需要至少两个不同原始资料来源支持才能自动建页', content: '正文', evidenceEligible: true,
  }, { runId: 'reopen-run', sourceVersionId: version.id, sourcePath: '原始资料/重开候选.md', sourceName: '重开候选.md' });
  addReports([{ kind: 'pending_review', payload: { candidateId: candidate.id, name: '重开候选', kind: 'concept', sourcePath: '原始资料/重开候选.md', sourceVersionId: version.id, runId: 'reopen-run' } }]);
  const reportId = reportIdOf('pending_review');
  // 忽略 → 候选 ignored
  const { ignoreCandidateReview } = await import('../pipeline/candidateReview.js');
  ignoreCandidateReview(reportId, '测试忽略');
  assert.equal(reportStatus(reportId), 'dismissed');
  assert.equal(getCandidate(candidate.id)!.status, 'ignored');
  // 重开 → 候选回 open
  reopenReport(reportId);
  assert.equal(reportStatus(reportId), 'open');
  assert.equal(getCandidate(candidate.id)!.status, 'open');
});
