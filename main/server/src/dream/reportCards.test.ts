import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-report-cards-'));
process.env.DATA_DIR = temp;

let db: any;
let now: () => string;
let createPage: (dir: string, title: string) => any;
let addReports: (items: any[]) => number;
let buildReportsOverview: () => any;
let pendingCandidateList: () => any[];
let beginSourceVersion: any;
let activateSourceVersion: any;
let upsertCandidateOccurrence: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  ({ createPage } = await import('../lib/vault.js'));
  ({ addReports } = await import('./reports.js'));
  ({ buildReportsOverview, pendingCandidateList } = await import('./reportCards.js'));
  ({ beginSourceVersion, activateSourceVersion } = await import('../pipeline/sourceLedger.js'));
  ({ upsertCandidateOccurrence } = await import('../pipeline/candidateLedger.js'));
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

function seedSource(runId: string, sourcePath: string, content = '原始资料内容。') {
  const abs = path.join(temp, 'brain', ...sourcePath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const version = beginSourceVersion(sourcePath, `${runId}-hash`);
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, sourcePath, `${runId}-hash`, version.id, now());
  return version;
}

function seedCandidate(name: string, runId: string, sourcePath: string, opts: { reason?: string } = {}) {
  const version = seedSource(runId, sourcePath, `${name}的原始资料内容。`);
  db.prepare(
    `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)`
  ).run(runId, `${runId}-f1`, `${name}的事实`, JSON.stringify([{ chunkId: 'c1', quote: `${name}的事实` }]));
  activateSourceVersion(version.id, runId);
  const reason = opts.reason || '需要至少两个不同原始资料来源支持才能自动建页';
  const candidate = upsertCandidateOccurrence({
    name, kind: 'project', action: 'review', target: '', domain: '测试',
    confidence: '中', summary: `${name}摘要`, factIds: [`${runId}-f1`],
    relations: [], reason, content: `${name}的候选正文`, evidenceEligible: true,
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
      factIds: [`${runId}-f1`], content: `${name}的候选正文`,
      summary: `${name}摘要`, reason,
    },
  }]);
  return candidate;
}

test('overview 三区聚合:同页面对重复+矛盾合一,同页面提醒合一,候选不混入决策区', () => {
  clear();
  const src = createPage('Wiki/概念', '来源页');
  addReports([
    { kind: 'deadlink', payload: { srcId: src.id, srcTitle: '来源页', deadTitle: '缺失页', suggestedType: 'concept', suggestionReason: '是个概念' } },
    { kind: 'duplicate', payload: { a: { id: 'a', title: '甲' }, b: { id: 'b', title: '乙' }, detail: '疑似重复', recommendedAction: 'keep_b' } },
    { kind: 'contradiction', payload: { a: { id: 'a', title: '甲' }, b: { id: 'b', title: '乙' }, detail: '口径不一致' } },
    { kind: 'identity_ambiguity', payload: { pageId: src.id, title: '张三', type: 'person', ambiguity: { label: '同名', question: '是同一人吗' }, suggestedTargetId: 't', suggestedTargetTitle: '张三(产品)' } },
    { kind: 'single_source', payload: { pageId: src.id, title: '来源页', source: '资料A.md' } },
    { kind: 'missing_sections', payload: { pageId: src.id, title: '来源页', missing: ['时间线'] } },
    { kind: 'enrich', payload: { pageId: src.id, title: '来源页', detail: '可补充' } },
    { kind: 'stale', payload: { pageId: src.id, title: '来源页', detail: '可能过期' } },
  ]);
  seedCandidate('单来源候选', 'cards-run-1', '原始资料/候选.md');
  const overview = buildReportsOverview();
  const decisionKinds = overview.decisions.map((card: any) => card.kind);
  // duplicate+contradiction 同对页面聚合为一张卡
  assert.deepEqual(decisionKinds.sort(), ['deadlink', 'duplicate', 'identity_ambiguity']);
  const pairCard = overview.decisions.find((card: any) => card.kind === 'duplicate');
  assert.equal(pairCard.reportIds.length, 2, '聚合卡包含重复与矛盾两张报告');
  assert.match(pairCard.question, /2 个问题/);
  assert.match(pairCard.question, /疑似重复、内容矛盾/);
  // 同一页面的 4 条提醒聚合为一条
  assert.equal(overview.reminders.length, 1);
  assert.equal(overview.reminders[0].reportIds.length, 4);
  assert.match(overview.reminders[0].title, /4 个提醒/);
  assert.equal(overview.pendingCandidates.length, 1);
  assert.equal(overview.counts.decisions, 3);
  assert.equal(overview.counts.pending, 1);
  assert.equal(overview.counts.reminders, 1);
  assert.equal(overview.counts.actionable, 4);
  assert.equal(overview.done.length, 0);
});

test('已处理区:关闭的报告保留记录并带已处理/已阅标志,不计角标', async () => {
  clear();
  const src = createPage('Wiki/概念', '来源页');
  addReports([
    { kind: 'single_source', payload: { pageId: src.id, title: '来源页', source: '资料A.md' } },
    { kind: 'enrich', payload: { pageId: src.id, title: '来源页', detail: '可补充' } },
  ]);
  const { decideReport } = await import('./decide.js');
  const rows = db.prepare(`SELECT id, kind FROM reports WHERE status='open'`).all() as any[];
  await decideReport(rows.find((r) => r.kind === 'single_source').id, 'resolve');
  await decideReport(rows.find((r) => r.kind === 'enrich').id, 'dismiss');
  const overview = buildReportsOverview();
  assert.equal(overview.reminders.length, 0);
  assert.equal(overview.done.length, 2);
  const resolved = overview.done.find((item: any) => item.kind === 'single_source');
  const dismissed = overview.done.find((item: any) => item.kind === 'enrich');
  assert.equal(resolved.status, 'resolved');
  assert.equal(dismissed.status, 'dismissed');
  assert.match(resolved.title, /来源单一/);
  assert.equal(overview.counts.actionable, 0, '已处理不计入角标');
});

test('deadlink 卡片:有建议类型时推荐一键创建,无建议时只能手选类型', () => {
  clear();
  addReports([{
    kind: 'deadlink',
    payload: { srcId: 's1', srcTitle: '来源', deadTitle: '新页面', suggestedType: 'person', suggestionReason: '是人物' },
  }]);
  addReports([{
    kind: 'deadlink',
    payload: { srcId: 's2', srcTitle: '来源2', deadTitle: '无建议页' },
  }]);
  const overview = buildReportsOverview();
  const withSuggestion = overview.decisions.find((card: any) => card.subject === '新页面');
  assert.match(withSuggestion.question, /来源.*新页面/);
  assert.equal(withSuggestion.options[0].value, 'create');
  assert.equal(withSuggestion.options[0].label, '创建为人物');
  assert.equal(withSuggestion.options[0].primary, true);
  assert.equal(withSuggestion.options[1].needsInput, 'pageType');
  assert.equal(withSuggestion.options.at(-1).value, 'dismiss');
  const withoutSuggestion = overview.decisions.find((card: any) => card.subject === '无建议页');
  assert.equal(withoutSuggestion.options[0].value, 'create-custom');
  assert.equal(withoutSuggestion.options[0].needsInput, 'pageType');
  assert.equal(withoutSuggestion.options.length, 2);
});

test('deadlink 聚合:同一死链目标被多个页面引用时合并为一张卡', () => {
  clear();
  addReports([
    { kind: 'deadlink', payload: { srcId: 's1', srcTitle: '页面甲', deadTitle: '共同目标', suggestedType: 'concept' } },
    { kind: 'deadlink', payload: { srcId: 's2', srcTitle: '页面乙', deadTitle: '共同目标' } },
    { kind: 'deadlink', payload: { srcId: 's3', srcTitle: '页面丙', deadTitle: '另一目标' } },
  ]);
  const overview = buildReportsOverview();
  const deadlinks = overview.decisions.filter((card: any) => card.kind === 'deadlink');
  assert.equal(deadlinks.length, 2, '同目标死链聚合,不同目标分开');
  const grouped = deadlinks.find((card: any) => card.subject === '共同目标');
  assert.equal(grouped.reportIds.length, 2);
  assert.match(grouped.question, /被 2 个页面引用/);
  assert.equal(grouped.links.length, 2, '聚合卡列出全部来源页');
  assert.equal(grouped.options[0].value, 'create', '组内有建议类型时仍推荐一键创建');
});

test('duplicate/identity 卡片:推荐动作与选项随 payload 变化', () => {
  clear();
  addReports([{
    kind: 'duplicate',
    payload: { a: { id: 'a', title: '甲' }, b: { id: 'b', title: '乙' }, recommendedAction: 'keep_b' },
  }]);
  addReports([{
    kind: 'identity_ambiguity',
    payload: { pageId: 'p1', title: '李四', type: 'person', ambiguity: { question: '是同一人吗' }, suggestedTargetId: '', suggestedTargetTitle: '' },
  }]);
  const overview = buildReportsOverview();
  const dup = overview.decisions.find((card: any) => card.kind === 'duplicate');
  assert.equal(dup.options.find((o: any) => o.value === 'keep_b').primary, true);
  assert.equal(dup.options.length, 3);
  const identity = overview.decisions.find((card: any) => card.kind === 'identity_ambiguity');
  assert.equal(identity.question, '是同一人吗');
  assert.ok(!identity.options.some((o: any) => o.value === 'merge'), '无建议目标时不提供合并选项');
  assert.ok(identity.options.some((o: any) => o.needsInput === 'rename'));
  assert.equal(identity.options.at(-1).value, 'dismiss');
});

test('追问卡片按资料聚合并 hydrate 活跃问题,全部处理中时文案切换', () => {
  clear();
  const version = seedSource('q-run-1', '原始资料/追问.md');
  const insert = db.prepare(
    `INSERT INTO ingest_questions(id,run_id,source_version_id,path,question,fact_ids,acceptance,answer,status,created_at,updated_at)
     VALUES(?,?,?,?,?,'[]','[]','',?,?,?)`
  );
  insert.run('q1', 'q-run-1', version.id, '原始资料/追问.md', '问题一', 'open', now(), now());
  insert.run('q2', 'q-run-1', version.id, '原始资料/追问.md', '问题二', 'open', now(), now());
  let overview = buildReportsOverview();
  let card = overview.decisions.find((item: any) => item.kind === 'ingest_questions');
  assert.ok(card, '追问报告应由 sync 自动生成');
  assert.equal(card.questions.length, 2);
  assert.match(card.question, /2 个问题/);
  assert.equal(card.options[0].value, 'resolve');
  db.prepare(`UPDATE ingest_questions SET status='answered' WHERE id='q1'`).run();
  db.prepare(`UPDATE ingest_questions SET status='answered' WHERE id='q2'`).run();
  overview = buildReportsOverview();
  card = overview.decisions.find((item: any) => item.kind === 'ingest_questions');
  assert.match(card.question, /等待重新整理/);
});

test('待入库清单:同名跨来源候选聚合为一行,对账就绪并排最前', () => {
  clear();
  seedCandidate('单来源项目', 'pc-run-1', '原始资料/单来源.md');
  seedCandidate('双来源项目', 'pc-run-2', '原始资料/双来源A.md');
  seedCandidate('双来源项目', 'pc-run-3', '原始资料/双来源B.md');
  const list = pendingCandidateList();
  assert.equal(list.length, 2, '同名候选在多个来源产生的报告必须聚合为一行');
  assert.equal(list[0].name, '双来源项目');
  assert.equal(list[0].autoReconcileReady, true);
  assert.equal(list[0].sourceCount, 2);
  assert.equal(list[0].reportIds.length, 2, '聚合行保留全部报告 id 供逐条关闭');
  assert.equal(list[0].facts.length, 2, '事实明细跨来源合并');
  assert.equal(list[1].name, '单来源项目');
  assert.equal(list[1].autoReconcileReady, false);
  assert.equal(list[1].sourceCount, 1);
  assert.equal(list[1].evidenceEligible, true);
  assert.equal(list[1].facts.length, 1);
  assert.equal(list[1].facts[0].statement, '单来源项目的事实');
});

test('同名页面已存在的单来源候选同样视为对账就绪', () => {
  clear();
  createPage('Wiki/实体', '已有项目');
  seedCandidate('已有项目', 'pc-run-exist', '原始资料/已有.md');
  const list = pendingCandidateList();
  assert.equal(list.length, 1);
  assert.equal(list[0].autoReconcileReady, true);
});
