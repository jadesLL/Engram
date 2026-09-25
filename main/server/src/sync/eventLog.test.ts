import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 同步事件日志（sync/eventLog）回归：
 *  - 一条事件必须带上级别 / 事件名 / 视角 / 成员 / 结构化字段，前端才能筛选、展开、导出；
 *  - 条数上限生效（超限淘汰最旧的），文件按上限的 10% 攒够后压缩，不会无限增长；
 *  - 超期（7 天）条目在加载/写入时清掉；
 *  - 清空后内存与文件都归零。
 *
 * 上限与保留天数走环境变量收紧，避免为了测淘汰真写 2000 条。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-evlog-'));
process.env.DATA_DIR = temp;
process.env.SYNC_LOG_MAX_ENTRIES = '5';
process.env.SYNC_LOG_RETENTION_DAYS = '7';

let log: typeof import('./eventLog.js');

const LOG_FILE = path.join(temp, 'logs', 'sync.jsonl');

before(async () => {
  log = await import('./eventLog.js');
});

after(() => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

function fileLines(): string[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter((line) => line.trim());
}

test('事件带结构化字段，可按级别 / 视角 / 事件 / 关键词查询', () => {
  log.logSyncEvent('info', 'connected', {
    detail: '中枢事件流已连接',
    scope: 'member',
    data: { hub: 'http://192.168.1.9:18080', device: '办公机' },
  });
  log.logSyncEvent('warn', 'push-retry', {
    detail: '推送失败，退避重试',
    scope: 'member',
    data: { kind: 'page', retryInMs: 3000 },
  });
  log.logSyncEvent('info', 'peer-online', {
    detail: '成员「客厅 NAS」已连接',
    scope: 'hub',
    peer: '客厅 NAS',
    data: { peerId: 'p1', device: 'nas' },
  });

  const all = log.querySyncLog({ limit: 50 });
  assert.equal(all.total, 3, '三条都应可查');
  assert.deepEqual(all.entries.map((e) => e.event), ['peer-online', 'push-retry', 'connected'], '默认新 → 旧');
  assert.equal(all.entries[0].peer, '客厅 NAS');
  assert.equal(all.entries[0].scope, 'hub');
  assert.deepEqual(all.entries[0].data, { peerId: 'p1', device: 'nas' });
  assert.equal(all.entries[0].level, 'info');
  assert.ok(all.entries[0].id > 0 && all.entries[0].ts);

  assert.equal(log.querySyncLog({ level: 'warn' }).total, 1);
  assert.equal(log.querySyncLog({ scope: 'member' }).total, 2);
  assert.equal(log.querySyncLog({ scope: 'hub' }).total, 1);
  assert.equal(log.querySyncLog({ event: 'connected' }).total, 1);
  assert.equal(log.querySyncLog({ q: '客厅' }).total, 1, '关键词命中成员名');
  assert.equal(log.querySyncLog({ q: '18080' }).total, 1, '关键词命中结构化字段');
  assert.equal(log.querySyncLog({ q: '不存在的词' }).total, 0);
});

test('分页：before 向前翻页，after 只看增量', () => {
  const first = log.querySyncLog({ limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.hasMore, true, '还有更旧的记录时应给 hasMore');

  const second = log.querySyncLog({ limit: 2, before: first.entries[0].id });
  assert.equal(second.total, 2);
  assert.ok(second.entries.every((e) => e.id < first.entries[0].id));

  const newest = first.entries[0];
  const incremental = log.querySyncLog({ after: newest.id - 1 });
  assert.equal(incremental.total, 1);
  assert.equal(incremental.entries[0].id, newest.id);
});

test('超过条数上限淘汰最旧条目，攒够 10% 后压缩文件', () => {
  const before5 = log.syncLogSummary().total;
  assert.equal(before5, 3, '前置状态：内存 3 条');

  // 上限 5：再写 30 条，内存恒定在上限，文件先长后压缩
  for (let i = 0; i < 30; i += 1) {
    log.logSyncEvent('info', 'heal', { detail: `周期自愈对账第 ${i} 次`, scope: 'member' });
  }
  const summary = log.syncLogSummary();
  assert.equal(summary.total, 5, '内存保留最近 5 条');
  const kept = log.querySyncLog({ limit: 5 }).entries;
  assert.equal(kept[0].detail, '周期自愈对账第 29 次', '最新的在最前');
  assert.equal(kept[4].detail, '周期自愈对账第 25 次', '只保留最近 5 条');
  assert.ok(summary.byEvent.some((item) => item.event === 'heal' && item.count === 5));
  assert.deepEqual(summary.byLevel, { info: 5, warn: 0, error: 0 });

  // 压缩后文件行数应等于内存条数（最多允许多攒 COMPACT_SLACK = max(20, 10%) 条）
  const lines = fileLines();
  assert.ok(lines.length <= 5 + 20, `文件行数应被压缩控制住，实际 ${lines.length}`);
  const last = JSON.parse(lines[lines.length - 1]) as { detail?: string; scope?: string };
  assert.equal(last.detail, '周期自愈对账第 29 次', '最后写入的一条必须已经在盘上');
  assert.equal(last.scope, 'member');
});

test('落盘可跨进程读取：文件是 JSONL，每行一条完整记录', () => {
  const lines = fileLines();
  assert.ok(lines.length > 0, '应有日志文件');
  for (const line of lines) {
    const item = JSON.parse(line) as { id: number; ts: string; level: string; event: string; detail?: string };
    assert.ok(item.id > 0 && item.ts && item.level && item.event, `每行都是完整记录: ${line}`);
  }
});

test('清空后内存与文件都归零', () => {
  const cleared = log.clearSyncLog();
  assert.ok(cleared >= 5);
  assert.equal(log.querySyncLog({}).total, 0);
  assert.equal(log.syncLogSummary().total, 0);
  assert.equal(fileLines().length, 0);
  // 清空后还能继续写，id 从 1 重新开始
  const next = log.logSyncEvent('error', 'reconcile-failed', { detail: '全量对账失败：连接超时' });
  assert.equal(next.id, 1);
  assert.equal(log.querySyncLog({}).entries[0].level, 'error');
});
