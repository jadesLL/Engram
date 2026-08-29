import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-autodecide-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let now: () => string;
let createPage: (dir: string, title: string) => any;
let readPage: (path: string) => any;
let addReports: (items: any[]) => number;
let runAutoDecideCycle: (signal?: AbortSignal) => Promise<any>;

before(async () => {
  // autodecide 不需要 LLM(采纳管线阶段建议),但 duplicate keep_a/keep_b 会入队
  // dream_apply 异步合并任务,这里只断言任务入队,不执行合并。
  server = http.createServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ index: 0, embedding: Array(1536).fill(0) }],
      choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
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
  ({ createPage, readPage } = await import('../lib/vault.js'));
  ({ addReports } = await import('./reports.js'));
  ({ runAutoDecideCycle } = await import('./autodecide.js'));
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
}

function pageWithEntityStructure(title: string, type: string): { id: string; path: string } {
  const page = createPage(type === 'person' ? 'Wiki/实体' : 'Wiki/概念', title);
  return { id: page.id, path: page.path };
}

test('自动决策:死链按建议类型建页、矛盾自动知悉、追问自动接受、待补章节修补、过期确认有效', async () => {
  clear();
  // 页面供给:stale/missing_sections 需要真实页面
  const stalePage = pageWithEntityStructure('过期页', 'person');
  const sectionPage = pageWithEntityStructure('缺章页', 'person');
  addReports([
    { kind: 'deadlink', payload: { deadTitle: '神秘新页面', suggestedType: 'concept', suggestionReason: '概念类', srcTitle: '来源页' } },
    { kind: 'contradiction', payload: { a: { title: 'A 页' }, b: { title: 'B 页' }, detail: '细节' } },
    { kind: 'ingest_questions', payload: { path: stalePage.path, questions: [{ question: '张三的任职时间?' }] } },
    { kind: 'stale', payload: { pageId: stalePage.id, title: '过期页' } },
    { kind: 'missing_sections', payload: { pageId: sectionPage.id, title: '缺章页' } },
  ]);

  const stats = await runAutoDecideCycle();
  assert.equal(stats.cardsResolved + stats.remindersHandled, 5, '五张卡应全部自动处理');
  assert.equal(stats.failed, 0);

  // 死链:按建议类型建页
  const created = readPage('Wiki/概念/神秘新页面.md');
  assert.ok(created, '死链目标页应按建议类型创建');
  // 矛盾:dismissed(可 reopen)
  const conRow = db.prepare(`SELECT status FROM reports WHERE kind='contradiction'`).get();
  assert.equal(conRow.status, 'dismissed');
  // 追问:resolved
  const qRow = db.prepare(`SELECT status FROM reports WHERE kind='ingest_questions'`).get();
  assert.equal(qRow.status, 'resolved');
  // stale:resolved;missing_sections:resolved
  const staleRow = db.prepare(`SELECT status FROM reports WHERE kind='stale'`).get();
  assert.equal(staleRow.status, 'resolved');
  const msRow = db.prepare(`SELECT status FROM reports WHERE kind='missing_sections'`).get();
  assert.equal(msRow.status, 'resolved');
});

test('自动决策:重复对按审计建议入队异步合并,待丰富留人工', async () => {
  clear();
  const aPath = pageWithEntityStructure('重复甲', 'person');
  const enrichPath = pageWithEntityStructure('待丰富页', 'person');
  addReports([
    { kind: 'duplicate', payload: { key: 'k1', a: { title: '重复甲', id: 'pa' }, b: { title: '重复乙', id: 'pb' }, detail: '高度重合', recommendedAction: 'keep_a' } },
    { kind: 'enrich', payload: { pageId: enrichPath, title: '待丰富页', recompose: true } },
  ]);

  const stats = await runAutoDecideCycle();
  assert.equal(stats.cardsResolved, 1, '重复对自动处理,待丰富留人工');
  assert.equal(stats.skipped, 1, '待丰富跳过留人工');

  // duplicate:入队 dream_apply 异步合并,报告置 applying
  const dupRow = db.prepare(`SELECT status FROM reports WHERE kind='duplicate'`).get();
  assert.equal(dupRow.status, 'applying');
  const job = db.prepare(`SELECT kind FROM jobs WHERE kind='dream_apply' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(job, 'dream_apply 合并任务应入队');
  assert.ok(aPath, 'sanity');
});

test('自动决策:候选按管线类型一步式入库,类型无效留人工', async () => {
  clear();
  addReports([
    { kind: 'pending_review', payload: { name: '强来源候选', kind: 'person', summary: '这是一个来源足够充分的候选实体,包含充足的上下文信息用于入库判断。' } },
    { kind: 'pending_review', payload: { name: '怪类型候选', kind: 'alien', summary: '类型不在白名单内的候选,应保留人工处理。' } },
  ]);

  const stats = await runAutoDecideCycle();
  assert.equal(stats.candidatesApproved, 1, '白名单类型候选自动入库');
  assert.equal(stats.skipped, 1, '无效类型候选留人工');

  const approved = db.prepare(`SELECT status FROM reports WHERE kind='pending_review' AND payload LIKE '%强来源候选%'`).get();
  assert.equal(approved.status, 'applying');
  const job = db.prepare(`SELECT kind FROM jobs WHERE kind='candidate_review_batch' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(job, 'candidate_review_batch 入库任务应入队');
  const left = db.prepare(`SELECT status FROM reports WHERE kind='pending_review' AND payload LIKE '%怪类型候选%'`).get();
  assert.equal(left.status, 'open');
});

test('自动决策统计落库,overview 返回 lastAutoDecide', async () => {
  clear();
  addReports([
    { kind: 'contradiction', payload: { a: { title: 'X' }, b: { title: 'Y' }, detail: '' } },
  ]);
  await runAutoDecideCycle();
  const raw = db.prepare(`SELECT value FROM settings WHERE key='dream_auto_decide_last'`).get();
  assert.ok(raw, '统计应落库');
  const parsed = JSON.parse(raw.value);
  assert.equal(parsed.cardsResolved, 1);
  const { buildReportsOverview } = await import('./reportCards.js');
  const overview = buildReportsOverview();
  assert.equal(overview.lastAutoDecide?.cardsResolved, 1);
});
