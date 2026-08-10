import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-dream-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let createPage: (dir: string, title: string) => any;
let readPage: (path: string) => any;
let readPageMeta: (path: string) => any;
let writePage: (path: string, content: string, extra?: Record<string, any>) => any;
let addReports: (items: any[]) => number;
let previewReportActions: (kind: any) => any;
let validateDecisions: (kind: any, decisions: any[]) => any[];
let claimReports: (kind: any, decisions: any[]) => void;
let applyReportDecisions: (kind: any, decisions: any[]) => any;
let recoverApplyingReports: () => void;

before(async () => {
  ({ db, migrate } = await import('../lib/db.js'));
  ({ createPage, readPage, readPageMeta, writePage } = await import('../lib/vault.js'));
  ({ addReports } = await import('./reports.js'));
  ({ previewReportActions, validateDecisions, claimReports, applyReportDecisions } = await import('./apply.js'));
  ({ recoverApplyingReports } = await import('../jobs.js'));
  migrate();
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function clear() {
  db.exec(`DELETE FROM reports; DELETE FROM jobs; DELETE FROM edges; DELETE FROM chunks; DELETE FROM pages_fts; DELETE FROM pages;`);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  fs.mkdirSync(path.join(temp, 'brain'), { recursive: true });
}

test('all nine categories expose the expected default selection', () => {
  clear();
  const kinds = ['deadlink', 'duplicate', 'contradiction', 'single_source', 'missing_sections', 'pending_review', 'ingest_questions', 'enrich', 'stale'];
  for (const kind of kinds) addReports([{ kind, payload: fixture(kind) }]);
  for (const kind of kinds) {
    const preview = previewReportActions(kind as any);
    assert.equal(preview.items.length, 1, kind);
    assert.equal(preview.items[0].selected, true, kind);
  }
});

test('deadlinks without a model recommendation stay unselected for manual typing', () => {
  clear();
  addReports([{
    kind: 'deadlink',
    payload: { srcId: 'src', srcTitle: '来源', deadTitle: '缺失页', srcUpdated: '2026-01-01' },
  }]);
  const preview = previewReportActions('deadlink');
  assert.equal(preview.items[0].selected, false);
  assert.equal(preview.items[0].suggestedAction, 'note');
  assert.equal(preview.items[0].disabled, false);
});

test('deadlink creates the selected page type and missing sections are idempotent', async () => {
  clear();
  const source = createPage('Wiki/概念', '来源页');
  const deadPayload = { srcId: source.id, srcTitle: source.title, deadTitle: '新组织', srcUpdated: source.updated_at };
  addReports([{ kind: 'deadlink', payload: deadPayload }]);
  const dead = previewReportActions('deadlink').items[0];
  const decision = [{ reportId: dead.id, action: 'org' }];
  claimReports('deadlink', decision);
  assert.deepEqual(await applyReportDecisions('deadlink', decision), { completed: 1, dismissed: 0, failed: 0, errors: [] });
  const created = db.prepare(`SELECT path, type FROM pages WHERE title='新组织' AND deleted=0`).get();
  assert.equal(created.type, 'org');
  assert.match(created.path, /^Wiki\/实体\//);

  const entity = createPage('Wiki/实体', '缺章节实体');
  writePage(entity.path, '# 缺章节实体\n\n正文', { type: 'person' });
  const current = db.prepare(`SELECT updated_at FROM pages WHERE id=?`).get(entity.id);
  addReports([{ kind: 'missing_sections', payload: { pageId: entity.id, title: entity.title, path: entity.path, missing: ['当前理解', '时间线'], pageUpdated: current.updated_at } }]);
  const report = previewReportActions('missing_sections').items[0];
  const repair = [{ reportId: report.id, action: 'repair' }];
  claimReports('missing_sections', repair);
  await applyReportDecisions('missing_sections', repair);
  const content = readPage(entity.path).content;
  assert.equal((content.match(/## 当前理解/g) || []).length, 1);
  assert.equal((content.match(/## 时间线/g) || []).length, 1);
});

test('stale review preserves page updated time and writes reviewed_at', async () => {
  clear();
  const page = createPage('Wiki/概念', '仍然有效');
  writePage(page.path, '# 仍然有效\n\n正文', { updated: '2020-01-01T00:00:00.000Z' });
  const beforeUpdated = db.prepare(`SELECT updated_at FROM pages WHERE id=?`).get(page.id).updated_at;
  addReports([{ kind: 'stale', payload: { pageId: page.id, title: page.title, path: page.path, pageUpdated: beforeUpdated, reviewedAt: '' } }]);
  const item = previewReportActions('stale').items[0];
  const decision = [{ reportId: item.id, action: 'review' }];
  claimReports('stale', decision);
  await applyReportDecisions('stale', decision);
  assert.equal(db.prepare(`SELECT updated_at FROM pages WHERE id=?`).get(page.id).updated_at, beforeUpdated);
  assert.match(String(readPageMeta(page.path).reviewed_at), /^\d{4}-\d{2}-\d{2}T/);
});

test('partial failure restores failed reports and keeps successful results', async () => {
  clear();
  addReports([
    { kind: 'deadlink', payload: { srcId: 'a', deadTitle: '可创建' } },
    { kind: 'deadlink', payload: { srcId: 'b', deadTitle: '' } },
  ]);
  const decisions = previewReportActions('deadlink').items.map((item: any) => ({ reportId: item.id, action: 'concept' }));
  claimReports('deadlink', decisions);
  const result = await applyReportDecisions('deadlink', decisions);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(db.prepare(`SELECT status, count(*) n FROM reports GROUP BY status ORDER BY status`).all(), [
    { status: 'open', n: 1 }, { status: 'resolved', n: 1 },
  ]);
});

test('fingerprint suppresses unchanged semantic findings and refreshes changed conclusions', () => {
  clear();
  const first = { kind: 'enrich', payload: { pageId: 'p1', pageUpdated: 'v1', detail: '缺少客户状态' } };
  assert.equal(addReports([first]), 1);
  assert.equal(addReports([first]), 0);
  assert.equal(addReports([{ kind: 'enrich', payload: { ...first.payload, detail: '缺少客户状态与策略' } }]), 1);
  assert.equal(db.prepare(`SELECT count(*) n FROM reports`).get().n, 1);
  db.prepare(`UPDATE reports SET status='dismissed'`).run();
  assert.equal(addReports([{ kind: 'enrich', payload: { ...first.payload, detail: '出现新的证据缺口' } }]), 1);
  assert.equal(db.prepare(`SELECT count(*) n FROM reports`).get().n, 2);
});

test('validation rejects cross-category actions and orphan applying reports recover', () => {
  clear();
  assert.throws(() => validateDecisions('deadlink', [{ reportId: 1, action: 'keep_a' }]), /处理动作无效/);
  addReports([{ kind: 'contradiction', payload: fixture('contradiction') }]);
  const item = previewReportActions('contradiction').items[0];
  const decision = [{ reportId: item.id, action: 'resolve' }];
  claimReports('contradiction', decision);
  recoverApplyingReports();
  assert.equal(db.prepare(`SELECT status FROM reports WHERE id=?`).get(item.id).status, 'open');
});

test('single-source pending reviews recommend ignore instead of a page type', () => {
  clear();
  const payload = {
    name: '恒创', source: '资料 A', runId: 'run-merge', factIds: ['f1'], kind: 'org',
    confidence: '高', summary: '代理商', content: '新增跟进记录。',
  };
  addReports([{ kind: 'pending_review', payload }]);
  const preview = previewReportActions('pending_review').items[0];
  assert.equal(preview.disabled, false);
  assert.equal(preview.selected, true);
  assert.equal(preview.suggestedAction, 'ignore');
  assert.equal(preview.payload.evidenceSourceCount, 1);
  assert.deepEqual(preview.options.map((option: any) => option.value), [
    'manual', 'approve:concept', 'approve:person', 'approve:project', 'approve:org', 'ignore',
  ]);
  assert.throws(
    () => validateDecisions('pending_review', [{ reportId: preview.id, action: 'manual' }]),
    /处理动作无效/,
  );
  assert.deepEqual(
    validateDecisions('pending_review', [{ reportId: preview.id, action: 'approve:org' }]),
    [{ reportId: preview.id, action: 'approve:org' }],
  );
});

function fixture(kind: string): any {
  const basePage = { id: `${kind}-page`, title: `${kind} 页面`, path: `Wiki/概念/${kind}.md`, updated_at: '2026-01-01' };
  const fixtures: Record<string, any> = {
    deadlink: {
      srcId: 'src',
      srcTitle: '来源',
      deadTitle: '缺失页',
      srcUpdated: '2026-01-01',
      suggestedType: 'concept',
    },
    duplicate: { a: basePage, b: { ...basePage, id: 'other', title: '另一页' }, similarity: .95 },
    contradiction: { a: basePage, b: { ...basePage, id: 'other', title: '另一页' }, detail: '描述冲突' },
    single_source: { pageId: basePage.id, title: basePage.title, source: '资料 A', pageUpdated: '2026-01-01' },
    missing_sections: { pageId: basePage.id, title: basePage.title, missing: ['时间线'], pageUpdated: '2026-01-01' },
    pending_review: { name: '候选', source: '资料 A', runId: 'run-1', factIds: ['f1'], kind: 'concept', content: '内容' },
    ingest_questions: { path: '原始资料/a.md', contentHash: 'hash', questions: [{ question: '问题' }] },
    enrich: { pageId: basePage.id, title: basePage.title, refs: 2, wordCount: 20, pageUpdated: '2026-01-01' },
    stale: { pageId: basePage.id, title: basePage.title, staleDays: 200, pageUpdated: '2026-01-01', reviewedAt: '' },
  };
  return fixtures[kind];
}
