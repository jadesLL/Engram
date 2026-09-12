import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 提炼账本（「已提炼」标记）的跨端搬运与缺口判定。
 *
 * 「已提炼」只由 source_versions + active page_contributions 推导，页面正文里没有这份信息：
 * 内容同步到位 ≠ 标记到位。这里覆盖按来源路径收集账本、空账本端恢复标记、
 * 贡献按页路径重映射，以及全量对账赖以判断「落后超过保留窗口」的缺口判据。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-evidence-ledger-'));
process.env.DATA_DIR = temp;

let db: any;
let writePage: (rel: string, content: string, extra?: any) => any;
let agentWritePage: (input: any) => any;
let isDistilledPath: (rel: string) => boolean;
let distilledSourcePaths: () => Set<string>;
let collectEvidenceForPath: (rel: string) => any;
let applyEvidenceSnapshot: (snapshot: any) => number;
let appendOplog: (kind: 'page' | 'file' | 'delete' | 'move', target: string, revision: number, nodeId: string) => number;
let needsResync: (since: number) => boolean;

const ISO = '2026-01-01T00:00:00.000Z';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage } = await import('../lib/vault.js'));
  ({ agentWritePage } = await import('../pipeline/agentWrite.js'));
  ({ isDistilledPath, distilledSourcePaths } = await import('../pipeline/sourceLedger.js'));
  ({ collectEvidenceForPath, applyEvidenceSnapshot } = await import('./rows.js'));
  ({ appendOplog, needsResync } = await import('./store.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 模拟「账本从未到达的对端」：账本行清空，页面与原始资料文件都还在 */
function clearLedger(): void {
  db.prepare('DELETE FROM page_contributions').run();
  db.prepare('DELETE FROM ingest_facts').run();
  db.prepare('DELETE FROM ingest_runs').run();
  db.prepare('DELETE FROM source_versions').run();
}

/** 造一份「远端 id」的账本快照（版本/贡献 id 与本端不同，只有来源路径与页路径一致） */
function foreignSnapshot(sourcePath: string, pagePath: string, versionId: string): any {
  return {
    versions: [{
      id: versionId,
      path: sourcePath,
      content_hash: `hash-${versionId}`,
      previous_id: null,
      status: 'active',
      created_at: ISO,
      activated_at: ISO,
      error: null,
    }],
    runs: [],
    facts: [],
    contributions: [{
      id: `pc-${versionId}`,
      page_id: `page-${versionId}`,
      source_version_id: versionId,
      run_id: `run-${versionId}`,
      contribution_key: `key-${versionId}`,
      fact_ids: '[]',
      relations: '[]',
      content: '',
      summary: '',
      domain: 'agent',
      confidence: '中',
      source_ref: sourcePath,
      managed: 0,
      active: 1,
      created_at: ISO,
      updated_at: ISO,
      __page_path: pagePath,
    }],
  };
}

test('collectEvidenceForPath：按来源路径收集的账本能把「已提炼」搬到空账本端', () => {
  const source = '原始资料/提炼账本.md';
  writePage(source, '# 原始资料/提炼账本.md\n\n甲公司与乙公司2026年签署三年期供货协议，覆盖华东与华南。', { title: '提炼账本' });
  agentWritePage({
    path: 'Wiki/实体/甲公司.md',
    title: '甲公司',
    type: 'org',
    content: '# 甲公司\n\n## 当前理解\n\n自动化设备供货商。\n',
    evidence: [
      { path: source, quote: '甲公司与乙公司2026年签署三年期供货协议' },
      { path: source, quote: '覆盖华东与华南' },
    ],
  });
  assert.equal(isDistilledPath(source), true, '源端：带证据写页后来源应为已提炼');

  const snapshot = collectEvidenceForPath(source);
  assert.ok(snapshot, '已提炼的来源必须能按来源路径产出账本快照');
  assert.equal(snapshot.versions.length, 1, '同一来源的两次引用共用同一版本');
  assert.equal(snapshot.contributions.length, 1);
  assert.equal(snapshot.contributions[0].active, 1);
  assert.equal(snapshot.contributions[0].__page_path, 'Wiki/实体/甲公司.md', '贡献需带页路径供对端重映射');

  // 对端：页面与资料都同步到了，但载体页面 op 早已被 oplog 裁剪 → 账本一行都没有
  clearLedger();
  assert.equal(isDistilledPath(source), false, '只同步内容时对端标记本来就是缺的');

  assert.equal(applyEvidenceSnapshot(snapshot), 1, '账本快照应至少落位一条贡献');
  assert.equal(isDistilledPath(source), true, '补齐账本后对端「已提炼」必须恢复');

  // 对账可重复执行：再补一次不得把标记弄丢（按来源路径的精确状态替换）
  assert.equal(applyEvidenceSnapshot(collectEvidenceForPath(source)!), 1);
  assert.equal(isDistilledPath(source), true);
});

test('账本按页路径重映射 page_id：两端各自建页、id 不同也不会挂空', () => {
  const source = '原始资料/重映射.md';
  writePage(source, '# 原始资料/重映射.md\n\n丙公司2026年中标城市轨道项目。', { title: '重映射' });
  const local = writePage('Wiki/实体/丙公司.md', '# 丙公司\n\n中标城市轨道项目。\n', { title: '丙公司' });

  const applied = applyEvidenceSnapshot(foreignSnapshot(source, 'Wiki/实体/丙公司.md', 'sv-remap'));
  assert.equal(applied, 1, '本端存在同名页时贡献应落位');
  const row = db
    .prepare('SELECT page_id FROM page_contributions WHERE source_version_id = ?')
    .get('sv-remap') as { page_id: string } | undefined;
  assert.equal(row?.page_id, local.id, '贡献必须挂到本端同名页的 id 上，而不是远端的 id');
  assert.equal(isDistilledPath(source), true);
});

test('载体页面尚未到位：贡献不挂空，但 active 版本行先恢复「已提炼」标记', () => {
  const source = '原始资料/顺序.md';
  writePage(source, '# 原始资料/顺序.md\n\n丁公司2026年交付首批设备。', { title: '顺序' });
  const snapshot = foreignSnapshot(source, 'Wiki/实体/丁公司.md', 'sv-order');

  assert.equal(applyEvidenceSnapshot(snapshot), 0, '页面不在位时贡献应被跳过而不是挂空');
  assert.equal(isDistilledPath(source), true, 'active 版本行已落地，标记即恢复（否则产物页在中枢已删的来源在对端永远显示未提炼）');

  // 页面随后同步到位 → 同一份账本再补一次即落位（贡献只是证据抽屉的展示层）
  writePage('Wiki/实体/丁公司.md', '# 丁公司\n\n设备交付。\n', { title: '丁公司' });
  assert.equal(applyEvidenceSnapshot(snapshot), 1);
  assert.equal(isDistilledPath(source), true);
});

test('中枢产物页面已删除：快照仍带页路径的贡献，对端无此页也必须恢复标记', () => {
  const source = '原始资料/页已删.md';
  writePage(source, '# 原始资料/页已删.md\n\n庚公司2026年完成股权融资，金额三亿元。', { title: '页已删' });
  agentWritePage({
    path: 'Wiki/实体/庚公司.md',
    title: '庚公司',
    type: 'org',
    content: '# 庚公司\n\n## 当前理解\n\n完成股权融资。\n',
    evidence: [
      { path: source, quote: '庚公司2026年完成股权融资' },
      { path: source, quote: '金额三亿元' },
    ],
  });
  assert.equal(isDistilledPath(source), true, '源端提炼完成');

  // 中枢端删除产物页面（软删，账本贡献保留）→ 全量清单不再包含该页，对端永远不会收到它
  const page = db.prepare(`SELECT id FROM pages WHERE path = 'Wiki/实体/庚公司.md'`).get() as { id: string };
  db.prepare('UPDATE pages SET deleted = 1 WHERE id = ?').run(page.id);

  const snapshot = collectEvidenceForPath(source);
  assert.ok(snapshot, '页面删除不得连带丢失来源账本快照');
  // 对端视角（只按路径同步过账本、从未有过该页面行）：清掉本路径账本与页面行
  db.prepare(
    'DELETE FROM page_contributions WHERE source_version_id IN (SELECT id FROM source_versions WHERE path = ?)'
  ).run(source);
  db.prepare('DELETE FROM ingest_runs WHERE path = ?').run(source);
  db.prepare('DELETE FROM source_versions WHERE path = ?').run(source);
  db.prepare('DELETE FROM pages WHERE id = ?').run(page.id);

  assert.equal(applyEvidenceSnapshot(snapshot), 0, '对端无产物页，贡献确实挂不上');
  assert.equal(isDistilledPath(source), true, '仅凭 active 版本行就必须显示已提炼');
});

test('superseded 版本 + active 贡献：旧数据口径不回退', () => {
  const source = '原始资料/旧口径.md';
  const snapshot = foreignSnapshot(source, 'Wiki/实体/辛公司.md', 'sv-legacy');
  snapshot.versions[0].status = 'superseded';
  // 先造「页面在位」让贡献落位：验证旧口径数据（无 active 版本、靠 active 贡献）仍判定已提炼
  writePage('Wiki/实体/辛公司.md', '# 辛公司\n\n存量贡献。\n', { title: '辛公司' });
  assert.equal(applyEvidenceSnapshot(snapshot), 1);
  assert.equal(isDistilledPath(source), true, 'active 贡献仍应视为已提炼');
});

test('collectEvidenceForPath：未提炼的来源不产出账本（对端无需多拉）', () => {
  writePage('原始资料/未引用.md', '# 原始资料/未引用.md\n\n暂无引用。', { title: '未引用' });
  assert.equal(collectEvidenceForPath('原始资料/未引用.md'), null);
  assert.equal(collectEvidenceForPath('原始资料/根本不存在.md'), null);
});

test('distilledSourcePaths 与 isDistilledPath 同语义（清单打标由批量版推导）', () => {
  const paths = distilledSourcePaths();
  assert.equal(paths.has('原始资料/提炼账本.md'), true);
  assert.equal(paths.has('原始资料/未引用.md'), false);
  assert.equal(paths.has('原始资料/根本不存在.md'), false);
});

test('needsResync：缺口落在游标之后即算落后，不受「本轮是否取回 op」影响', () => {
  db.prepare('DELETE FROM sync_oplog').run();
  assert.equal(needsResync(0), false, '空 oplog 不算落后，否则每次重连都会触发全量对账');

  // seq 是 AUTOINCREMENT：本文件前面的写页已经把水位推高，清空后新 op 从高位继续，
  // 因此断言一律以实际 seq 为基准，不能假定第一条就是 1。
  const first = appendOplog('page', 'Wiki/甲.md', 1, 'test-hub');
  appendOplog('page', 'Wiki/乙.md', 2, 'test-hub');
  assert.equal(needsResync(first - 1), false, '游标之后的第一条仍在保留区里 → 无缺口');
  assert.equal(needsResync(first), false, '游标已追上保留区起点 → 无缺口');

  // 裁掉 first：游标停在 first-1 的成员需要的那条 op 已被裁剪，而保留区里还留着更新的 op。
  // 旧判据是「本轮取回 0 条」，此刻会取回更新的 op，于是把缺口当成正常增量静默跳过。
  db.prepare('DELETE FROM sync_oplog WHERE seq = ?').run(first);
  assert.equal(needsResync(first - 1), true, '缺口后面仍有新 op 时必须判定为落后');
  assert.equal(needsResync(first), false, '缺口在游标处已应用过 → 不算落后');
});
