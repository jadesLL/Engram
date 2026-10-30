import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUSTOMER_RESEARCH_SECTIONS } from '../content/customerResearch.js';
import type { ResearchSnapshot } from './research.js';

/**
 * 客户调研（客户洞察）的跨端同步。
 *
 * 覆盖：只同步完成态、快照字段与 hash 稳定（含主体核验结论 verdict）、对账清单同投影、
 * 按 updatedAt 新者胜合并（相等只补空、坏数据不落库）、中枢 recordResearchChange 发号写 oplog、
 * 流程模板走 preference 管道、关闭客户洞察分类后不再参与同步。
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

/** 合法的流程快照 JSON（章节用服务端默认模板，避免与 content/customerResearch.ts 漂移） */
function rulesJson(): string {
  return JSON.stringify({
    version: 2,
    workflow: '测试流程',
    sections: CUSTOMER_RESEARCH_SECTIONS.map((section) => ({ id: section.id, title: section.title })),
  });
}

/**
 * 直接造一条任务行。同步层要测的是「报告已生成、任务行已落库」之后的那一段，
 * 不走 submit_customer_research：v2 的 submit 要求 identity、还校验三种报告模式，
 * 那属于 research/customerResearch.test.ts；这里从任务行开始造，正好覆盖旧版本行（verdict 默认空串）。
 */
function insertTask(over: {
  customer: string;
  report?: string;
  path?: string;
  verdict?: string;
  updatedAt?: string;
}): string {
  const id = randomUUID();
  const at = over.updatedAt ?? '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO customer_research_tasks(id, customer, scope, client, rules, save_requested, session_id, run_id,
                                         report, path, verdict, created_at, updated_at, report_date, time_zone)
     VALUES(?,?,'knowledge-only','Codex',?,0,'','',?,?,?,?,?,'2026-01-01','Asia/Hong_Kong')`
  ).run(
    id,
    over.customer,
    rulesJson(),
    over.report ?? '# 客户洞察\n\n资料不足，待补充。',
    over.path ?? '',
    over.verdict ?? '',
    at,
    at,
  );
  return id;
}

/** 造一条完成态调研任务（report 非空）；save=true 时带上已保存报告的路径 */
function makeCompleted(customer: string, save = false): string {
  return insertTask({
    customer,
    path: save ? `原始资料/文档/2026.10.30_${customer}调研报告.md` : '',
  });
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
    verdict: over.verdict ?? '',
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
  assert.equal(snapshot!.verdict, '', '没有主体核验结论的任务（旧版本/未核验）：verdict 为空串');
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
  const pendingId = insertTask({ customer: '进行中客户', report: '' });
  assert.equal(syncResearch.collectResearchSnapshot(pendingId), null);
  assert.equal(syncResearch.researchContentHash(pendingId), '');
  assert.ok(syncResearch.researchUpdatedAt(pendingId), '未完成任务仍有更新时间（本机执行状态）');
  assert.ok(!syncResearch.researchManifest().some((item) => item.id === pendingId));

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

test('主体核验结论（verdict）：随快照往返、参与 hash 投影、旧版本快照缺字段按空串落库', () => {
  const verified = JSON.stringify({
    mode: 'full',
    status: 'verified',
    method: 'registry',
    fullName: '客户洞察主体核验有限公司',
    webSources: 2,
    kbSources: 1,
    reason: '',
    attempts: ['企查查命中工商全称'],
  });

  // 新 id 插入：verdict 原样落库，快照与对账清单的 hash 用同一投影
  assert.deepEqual(syncResearch.mergeResearchSnapshot(snap('verdict-a', { verdict: verified })), {
    created: true,
    updated: false,
  });
  const collected = syncResearch.collectResearchSnapshot('verdict-a')!;
  assert.equal(collected.verdict, verified, 'verdict 要随快照原样带出（JSON 字符串，同步层不解析）');
  assert.equal(
    syncResearch.researchSnapshotHash(collected),
    syncResearch.researchSnapshotHash(snap('verdict-a', { verdict: verified })),
    '同一份内容两端必须算出同一个 hash'
  );
  const entry = syncResearch.researchManifest().find((item) => item.id === 'verdict-a');
  assert.ok(entry, '带核验结论的完成态记录同样进对账清单');
  assert.equal(entry!.hash, syncResearch.researchSnapshotHash(collected), '清单 hash 与快照 hash 同一投影');

  // 不同 verdict 是不同的内容：hash 必须不同，对账才会把这一条拉过去
  assert.notEqual(
    syncResearch.researchSnapshotHash(snap('verdict-a', { verdict: '' })),
    syncResearch.researchSnapshotHash(snap('verdict-a', { verdict: verified })),
    'verdict 变化必须改变快照 hash（否则对端不会拉这一条）'
  );

  // 更新时间更晚的远端快照：整行覆盖时一起换 verdict（核验结论可能被重新调研改写）
  const rechecked = JSON.stringify({
    mode: 'brief', status: 'kb-docs', method: 'kb-documents', webSources: 0, kbSources: 3, reason: '未联网核验', attempts: [],
  });
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot(
      snap('verdict-a', { verdict: rechecked, updatedAt: '2026-01-02T00:00:00.000Z' })
    ),
    { created: false, updated: true },
    '更新的快照整行覆盖时一起换 verdict'
  );
  assert.equal(syncResearch.collectResearchSnapshot('verdict-a')!.verdict, rechecked);

  // 同一时刻：本端没有核验结论才由远端补上；本端已有结论时不被同一时刻的快照顶掉
  const fillAt = '2026-01-05T00:00:00.000Z';
  const fillId = insertTask({ customer: '补空客户', report: '已有报告', updatedAt: fillAt });
  const fill = snap(fillId, { customer: '补空客户', report: '已有报告', updatedAt: fillAt });
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...fill, verdict: verified }),
    { created: false, updated: true },
    '同一时刻本端没有结论时补上'
  );
  assert.equal(syncResearch.collectResearchSnapshot(fillId)!.verdict, verified);
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...fill, verdict: rechecked }),
    { created: false, updated: false },
    '本端已有的结论不被同一时刻的远端顶掉'
  );
  assert.equal(syncResearch.collectResearchSnapshot(fillId)!.verdict, verified, '补空不覆盖已有结论');

  // 旧版本快照在 JSON 里没有 verdict 字段：按空串落库，不能写成字符串 "undefined"
  const legacy = { ...snap('verdict-legacy'), verdict: undefined } as unknown as ResearchSnapshot;
  assert.deepEqual(syncResearch.mergeResearchSnapshot(legacy), { created: true, updated: false });
  assert.equal(syncResearch.collectResearchSnapshot('verdict-legacy')!.verdict, '');
  // 旧版本快照时间更晚推过来时按 '' 覆盖——与「整行最新者胜」口径一致，不沿用本端旧结论
  assert.deepEqual(
    syncResearch.mergeResearchSnapshot({ ...legacy, updatedAt: '2026-01-03T00:00:00.000Z' }),
    { created: false, updated: true }
  );
  assert.equal(syncResearch.collectResearchSnapshot('verdict-legacy')!.verdict, '');

  // 非空但不是 JSON 对象（坏串 / 数组 / null）：合并前归一为 ''，不让脏数据跨端
  for (const [id, bad] of [
    ['verdict-bad-text', '不是 JSON'],
    ['verdict-bad-array', '[]'],
    ['verdict-bad-null', 'null'],
  ] as const) {
    assert.deepEqual(syncResearch.mergeResearchSnapshot(snap(id, { verdict: bad })), {
      created: true,
      updated: false,
    });
    assert.equal(syncResearch.collectResearchSnapshot(id)!.verdict, '', `坏 verdict 落库要归一为空串：${bad}`);
  }
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
