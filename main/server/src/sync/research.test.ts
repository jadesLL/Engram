import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResearchSnapshot } from './research.js';

/**
 * 客户调研（客户洞察）的跨端同步。
 *
 * 覆盖：只同步完成态、快照字段与 hash 稳定、对账清单同投影、按 updatedAt 新者胜合并
 * （相等只补空、坏数据不落库）、中枢 recordResearchChange 发号写 oplog、流程模板走 preference
 * 管道、关闭客户洞察分类后不再参与同步。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-research-sync-'));
process.env.DATA_DIR = temp;

let db: any;
let research: typeof import('../research/customerResearch.js');
let syncResearch: typeof import('./research.js');
let sync: typeof import('./index.js');
let categories: typeof import('./categories.js');
let preferences: typeof import('./preferences.js');
let store: typeof import('./store.js');

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  research = await import('../research/customerResearch.js');
  syncResearch = await import('./research.js');
  sync = await import('./index.js');
  categories = await import('./categories.js');
  preferences = await import('./preferences.js');
  store = await import('./store.js');
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 一份通过服务端校验的完整报告正文（无来源、无引用；只验证同步，不验证调研内容） */
function reportBody(): { sections: Record<string, string>; sources: [] } {
  const rules = research.customerResearchRules();
  return {
    sections: Object.fromEntries(rules.sections.map((section) => [section.id, '资料不足，待补充。'])),
    sources: [],
  };
}

/** 造一条完成态调研任务（report 非空）；save=true 时会同时生成本地原始资料 */
function makeCompleted(customer: string, save = false): string {
  const task = research.beginCustomerResearch({
    customer,
    scope: 'knowledge-only',
    client: 'Codex',
    timeZone: 'Asia/Hong_Kong',
  });
  research.submitCustomerResearch({ taskId: task.taskId, ...reportBody(), save });
  return task.taskId;
}

/** 手工构造一份远端快照（绕过本地 DB，模拟对端推来的那份） */
function snap(id: string, over: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  return {
    id,
    customer: over.customer ?? `客户-${id}`,
    scope: over.scope ?? 'knowledge-web',
    client: over.client ?? 'Codex',
    rules: over.rules ?? JSON.stringify({ version: 2, workflow: '测试流程', sections: [] }),
    saveRequested: over.saveRequested ?? 0,
    report: over.report ?? `报告-${id}`,
    path: over.path ?? '',
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-01-01T00:00:00.000Z',
    reportDate: over.reportDate ?? '2026-01-01',
    timeZone: over.timeZone ?? 'Asia/Hong_Kong',
  };
}

function countResearchOps(): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM sync_oplog WHERE kind = 'research'`).get() as { n: number }).n
  );
}

test('完成态快照：字段齐全、hash 稳定，对账清单带同一条与同 hash', () => {
  const id = makeCompleted('快照客户', true);
  const snapshot = syncResearch.collectResearchSnapshot(id);
  assert.ok(snapshot, '有报告的任务才有快照');
  assert.equal(snapshot!.id, id);
  assert.equal(snapshot!.customer, '快照客户');
  assert.equal(snapshot!.scope, 'knowledge-only');
  assert.equal(snapshot!.client, 'Codex');
  assert.equal(snapshot!.saveRequested, 0);
  assert.ok(snapshot!.rules.includes('"version"'), '流程快照是创建任务时的 JSON');
  assert.match(snapshot!.report, /资料不足/);
  assert.match(snapshot!.path, /^原始资料\/文档\//, '保存后的报告路径随快照带出');
  assert.ok(snapshot!.createdAt && snapshot!.updatedAt && snapshot!.reportDate);
  assert.equal(snapshot!.timeZone, 'Asia/Hong_Kong');

  const hash = syncResearch.researchSnapshotHash(snapshot!);
  assert.equal(syncResearch.researchContentHash(id), hash, '单条内容 hash 由快照投影算出');
  assert.equal(syncResearch.researchContentHash(id), hash, '同一行反复算 hash 必须稳定（对账靠它去重）');
  assert.equal(syncResearch.researchUpdatedAt(id), snapshot!.updatedAt);

  const entry = syncResearch.researchManifest().find((item) => item.id === id);
  assert.ok(entry, '完成态记录要进对账清单');
  assert.equal(entry!.hash, hash, '清单 hash 与快照 hash 必须同一投影，否则对账会每轮重复拉取');
  assert.equal(entry!.customer, '快照客户');
  assert.equal(entry!.updatedAt, snapshot!.updatedAt);
});

test('只同步完成态：report 空的任务没有快照、不进清单；不存在的任务返回空', () => {
  const pending = research.beginCustomerResearch({ customer: '进行中客户' });
  assert.equal(syncResearch.collectResearchSnapshot(pending.taskId), null);
  assert.equal(syncResearch.researchContentHash(pending.taskId), '');
  assert.ok(syncResearch.researchUpdatedAt(pending.taskId), '未完成任务仍有更新时间（本机执行状态）');
  assert.ok(!syncResearch.researchManifest().some((item) => item.id === pending.taskId));

  assert.equal(syncResearch.collectResearchSnapshot('missing-task'), null);
  assert.equal(syncResearch.researchContentHash('missing-task'), '');
  assert.equal(syncResearch.researchUpdatedAt('missing-task'), '');
});

test('合并快照：新 id 插入、更旧不动、更新覆盖、同一时刻只补空、坏数据拒绝', () => {
  const base = snap('merge-a', { report: '第一版' });
  assert.deepEqual(syncResearch.mergeResearchSnapshot(base), { created: true, updated: false });
  assert.equal(syncResearch.collectResearchSnapshot('merge-a')!.report, '第一版');
  assert.deepEqual(syncResearch.mergeResearchSnapshot({ ...base }), { created: false, updated: false }, '同一份快照应用两次是幂等的');

  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...base, report: '更旧的版本', updatedAt: '2025-12-31T00:00:00.000Z' }),
    { created: false, updated: false },
    '更旧的快照不能顶掉本端'
  );
  assert.equal(syncResearch.collectResearchSnapshot('merge-a')!.report, '第一版');

  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...base, report: '第二版', path: '原始资料/文档/新.md', updatedAt: '2026-01-02T00:00:00.000Z' }),
    { created: false, updated: true },
    '更新的快照整行覆盖'
  );
  const updated = syncResearch.collectResearchSnapshot('merge-a')!;
  assert.equal(updated.report, '第二版');
  assert.equal(updated.path, '原始资料/文档/新.md');

  // 同一时刻：只补本端空着的字段
  const fillBase = snap('merge-fill', { report: '已有报告', path: '' });
  assert.deepEqual(syncResearch.mergeResearchSnapshot(fillBase), { created: true, updated: false });
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...fillBase, path: '原始资料/文档/补.md', report: '对端报告' }),
    { created: false, updated: true },
    '同一时刻补上空路径'
  );
  const filled = syncResearch.collectResearchSnapshot('merge-fill')!;
  assert.equal(filled.path, '原始资料/文档/补.md');
  assert.equal(filled.report, '已有报告', '同一时刻不覆盖已有正文');
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...fillBase, path: '原始资料/文档/另一份.md', report: '对端报告' }),
    { created: false, updated: false },
    '没有空字段可补时什么都不做'
  );

  // 本端同 id 还停在「未完成」（report 空）且时刻相同：用远端正文补上
  db.prepare(
    `INSERT INTO customer_research_tasks(id, customer, scope, client, rules, save_requested, session_id, run_id,
                                         report, path, created_at, updated_at, report_date, time_zone)
     VALUES('merge-empty','客户-merge-empty','knowledge-web','Codex',?,0,'','','','',
            '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01','Asia/Hong_Kong')`
  ).run(JSON.stringify({ version: 1, workflow: '本机流程', sections: [] }));
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot(snap('merge-empty', { report: '对端补的报告' })),
    { created: false, updated: true },
    '同一时刻补上空正文'
  );
  assert.equal(syncResearch.collectResearchSnapshot('merge-empty')!.report, '对端补的报告');

  // 坏数据不进库：缺 id / 缺报告 / rules 不是 JSON / 客户名为空
  assert.deepEqual(syncResearch.mergeResearchSnapshot({ ...base, id: '' }), { created: false, updated: false });
  assert.deepEqual(syncResearch.mergeResearchSnapshot({ ...base, id: 'merge-no-report', report: '' }), { created: false, updated: false });
  assert.deepEqual(syncResearch.mergeResearchSnapshot({ ...base, id: 'merge-bad-rules', rules: '不是 JSON' }), { created: false, updated: false });
  assert.deepEqual(syncResearch.mergeResearchSnapshot({ ...base, id: 'merge-no-customer', customer: '  ' }), { created: false, updated: false });
  assert.equal(syncResearch.collectResearchSnapshot('merge-bad-rules'), null);
  assert.equal(syncResearch.collectResearchSnapshot('merge-no-customer'), null);
  // 坏 rules 不落库，客户洞察列表接口（直接 JSON.parse(rules)）照常可用
  assert.ok(Array.isArray(research.customerResearchTasks()));

  // 范围只有两个合法值：未知值按默认的 knowledge-web 归一
  syncResearch.mergeResearchSnapshot({ ...snap('merge-scope'), scope: 'weird-scope' });
  const scopeRow = db.prepare(`SELECT scope FROM customer_research_tasks WHERE id = ?`).get('merge-scope') as { scope: string };
  assert.equal(scopeRow.scope, 'knowledge-web');

  // 快照不含执行轮次：合并进来的行不能带 sessionId/runId（对端没有对应轮次）
  const owned = db.prepare(`SELECT session_id, run_id FROM customer_research_tasks WHERE id = ?`).get('merge-a') as {
    session_id: string;
    run_id: string;
  };
  assert.equal(owned.session_id, '');
  assert.equal(owned.run_id, '');
});

test('中枢挂点：recordResearchChange 发号写 oplog；关闭客户洞察分类后不再记录', async () => {
  await sync.configure({ role: 'hub' });
  try {
    const id = makeCompleted('中枢挂点客户');
    const revisionBefore = store.currentRevision();
    const opsBefore = countResearchOps();

    sync.recordResearchChange(id);
    assert.ok(store.currentRevision() > revisionBefore, '中枢本机写入要发号');
    assert.equal(countResearchOps(), opsBefore + 1, 'oplog 里应多一条 kind=research');
    const latest = db.prepare(`SELECT kind, target FROM sync_oplog ORDER BY seq DESC LIMIT 1`).get() as {
      kind: string;
      target: string;
    };
    assert.equal(latest.kind, 'research');
    assert.equal(latest.target, id);

    // 再调一次允许再次发号（本机写入不靠 hash 去重），但不该抛错、日志只增不减
    sync.recordResearchChange(id);
    assert.ok(countResearchOps() >= opsBefore + 1);

    // 关闭客户洞察分类：不发号、不写 oplog
    categories.saveSyncCategories({ customerResearch: false });
    const revisionOff = store.currentRevision();
    const opsOff = countResearchOps();
    sync.recordResearchChange(id);
    assert.equal(store.currentRevision(), revisionOff);
    assert.equal(countResearchOps(), opsOff);
    categories.saveSyncCategories({ customerResearch: true });
  } finally {
    await sync.configure({ role: 'none' });
  }
});

test('规则模板走 preference 管道：保存后带偏好时间戳且可同步，关闭分类后不可同步', () => {
  const rules = research.customerResearchRules();
  const next = research.updateCustomerResearchRules({
    workflow: `${rules.workflow}\n补充：同步测试用流程。`,
    titles: rules.sections.map((section) => section.title),
  });
  const preference = preferences.preferenceValue('customer_research_rules');
  assert.ok(preference, '规则保存后要有偏好元数据');
  assert.ok(preference!.updatedAt > 0, '要有本机写入时间戳（最新写入者胜的依据）');
  assert.ok(preference!.nodeId, '要有来源节点 id');
  assert.equal(preference!.value, JSON.stringify(next));
  assert.equal(categories.syncAllowed('preference', 'customer_research_rules'), true);

  categories.saveSyncCategories({ customerResearch: false });
  assert.equal(categories.syncAllowed('preference', 'customer_research_rules'), false);
  assert.equal(categories.syncAllowed('research', '任意 id'), false);
  categories.saveSyncCategories({ customerResearch: true });
  assert.equal(preferences.preferenceValue('customer_research_rules')!.value, JSON.stringify(next), '关闭分类不能删除本机模板');
});
