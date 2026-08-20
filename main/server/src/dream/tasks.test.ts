import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-dream-semantic-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let createPage: any;
let writePage: any;
let taskPairAudit: any;
let taskPageHealth: any;
let taskDeadlinks: any;
let wirePageEdges: any;
let closeStaleIdentityAmbiguityReports: any;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const system = body.messages.find((message: any) => message.role === 'system')?.content || '';
    const output = system.includes('两个页面')
      ? {
          duplicate: true,
          preserveBoth: false,
          duplicateReason: '模型判断两页描述同一知识对象。',
          recommendedAction: 'keep_a',
          contradiction: true,
          contradictionDetail: '模型发现同一状态描述冲突。',
        }
      : {
          needsEnrichment: true,
          enrichmentReason: '模型判断缺少关键状态和后续动作。',
          stale: true,
          staleReason: '模型判断页面中的状态性事实需要复核。',
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('chat_models', JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
  }]));
  dbModule.setSetting('active_chat_model', 'mock');
  ({ createPage, writePage } = await import('../lib/vault.js'));
  ({ taskPairAudit, taskPageHealth, taskDeadlinks } = await import('./tasks.js'));
  ({ wirePageEdges } = await import('../pipeline/extractor.js'));
  ({ closeStaleIdentityAmbiguityReports } = dbModule);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('Dream Cycle uses model decisions instead of vector, length or age thresholds', async () => {
  const a = createPage('Wiki/概念', '语义页面 A');
  const b = createPage('Wiki/概念', '语义页面 B');
  writePage(a.path, '# 语义页面 A\n\n状态是启用，包含足够正文。', { type: 'concept' });
  writePage(b.path, '# 语义页面 B\n\n状态是停用，表达不同。', { type: 'concept' });

  const pair = await taskPairAudit();
  assert.deepEqual(pair, { duplicate: 1, contradiction: 1 });
  const duplicate = db.prepare(`SELECT payload FROM reports WHERE kind='duplicate'`).get();
  assert.match(duplicate.payload, /模型判断两页描述同一知识对象/);

  const health = await taskPageHealth();
  assert.deepEqual(health, { enrich: 2, stale: 2 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM semantic_events WHERE scope='dream'`).get().n, 3);
});

test('wirePageEdges resolves .md-suffixed links to existing pages', () => {
  const target = createPage('Wiki/概念', 'Docker 笔记');
  writePage(target.path, '# Docker 笔记\n\n内容', { type: 'concept' });
  const src = createPage('Wiki/概念', '链接来源页');
  writePage(src.path, '# 链接来源页\n\n参见 [[Docker 笔记.md]]。', { type: 'concept' });
  wirePageEdges(src.id, '# 链接来源页\n\n参见 [[Docker 笔记.md]]。');
  const edge = db.prepare(
    `SELECT dst_page, dst_title FROM edges WHERE src_page = ? AND rel = 'link'`
  ).get(src.id) as any;
  assert.equal(edge.dst_page, target.id, '带 .md 后缀的链接应解析为实边');
  assert.equal(edge.dst_title, null);
});

test('taskDeadlinks backfills .md dead edges and closes the stale open report', async () => {
  const target = createPage('Wiki/概念', '死链目标页');
  writePage(target.path, '# 死链目标页\n\n内容', { type: 'concept' });
  const src = createPage('Wiki/概念', '死链来源页');
  writePage(src.path, '# 死链来源页\n\n引用 [[死链目标页.md]]。', { type: 'concept' });
  // 旧版本建出的死链边:dst_page NULL、dst_title 带 .md
  db.prepare(
    `INSERT INTO edges(src_page, dst_page, dst_title, entity_id, rel, created_at) VALUES(?, NULL, ?, NULL, 'link', datetime('now'))`
  ).run(src.id, '死链目标页.md');
  // 对应的 open 死链报告
  const { addReports } = await import('./reports.js');
  addReports([{
    kind: 'deadlink',
    payload: { srcId: src.id, srcTitle: src.title, deadTitle: '死链目标页.md', srcUpdated: '' },
  }]);
  const openBefore = db.prepare(
    `SELECT COUNT(*) n FROM reports WHERE kind='deadlink' AND status='open'`
  ).get().n;
  assert.equal(openBefore, 1);

  const added = await taskDeadlinks();
  assert.equal(added, 0, '死链边已回填,不再产出新报告');
  const edge = db.prepare(
    `SELECT dst_page FROM edges WHERE src_page = ? AND rel = 'link' AND dst_title = '死链目标页.md'`
  ).get(src.id) as any;
  assert.equal(edge, undefined, '原死链边应被回填(dst_title 清空)');
  const linked = db.prepare(
    `SELECT COUNT(*) n FROM edges WHERE src_page = ? AND rel = 'link' AND dst_page = ?`
  ).get(src.id, target.id).n;
  assert.ok(linked >= 1, '存在指向目标页的实边');
  const openAfter = db.prepare(
    `SELECT COUNT(*) n FROM reports WHERE kind='deadlink' AND status='open'`
  ).get().n;
  assert.equal(openAfter, 0, '已恢复的死链报告被关闭');
});

test('closeStaleIdentityAmbiguityReports dismisses reports whose pages are gone', async () => {
  const page = createPage('Wiki/实体', '清扫存活页');
  writePage(page.path, '# 清扫存活页\n\n内容', { type: 'person' });
  const { addReports } = await import('./reports.js');
  const now = new Date().toISOString();
  // 涉页活跃的报告:保持 open
  addReports([{
    kind: 'identity_ambiguity',
    payload: { key: page.id, pageId: page.id, title: '清扫存活页', type: 'person', pageUpdated: now, ambiguity: { category: 'possible_typo', question: 'Q' }, suggestedTargetId: '', suggestedTargetTitle: '' },
  }]);
  // 目标页已删除的报告:应被关闭(模拟已删目标)
  db.prepare(
    `INSERT INTO reports(run_at, kind, payload, status, issue_key, fingerprint) VALUES(?, 'identity_ambiguity', ?, 'open', 'stale-cleanup-test', 'stale-cleanup-test')`
  ).run(now, JSON.stringify({
    key: page.id, pageId: page.id, title: '清扫存活页', type: 'person', pageUpdated: now,
    ambiguity: { category: 'possible_typo', question: 'Q' },
    suggestedTargetId: 'deleted-page-id', suggestedTargetTitle: '已删页',
  }));
  const closed = closeStaleIdentityAmbiguityReports();
  assert.equal(closed, 1);
  const statuses = db.prepare(
    `SELECT status FROM reports WHERE kind='identity_ambiguity' ORDER BY id`
  ).all() as any[];
  assert.equal(statuses[0].status, 'open', '涉页活跃的报告保持 open');
  assert.equal(statuses[1].status, 'dismissed', '目标已删的报告被关闭');
});
