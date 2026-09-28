import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contentTypesOf,
  contentTypeOfPath,
  matchesContent,
  matchesOutcome,
  outcomeOf,
} from './logClassify.js';

/**
 * 同步日志分类回归（同步详情筛选栏的两排口径）：
 *  - 结果：有改动（成功且内容真的变了）/ 没改动（对账、检查、连接）/ 失败（警告 + 错误）；
 *  - 内容：原始资料 / 概念 / 实体 / 内置 Agent / 其他。
 *
 * 口径一旦漂移，用户看到的分类就会和实际同步行为对不上，所以这里把每个边界钉住。
 */

test('结果分类：对账、连接、成员上下线这类成功事件都是「没改动」', () => {
  const quiet = [
    'snapshot-served', 'connected', 'disconnected', 'reconnected', 'start', 'stopped',
    'sync-done', 'heal', 'reconcile-start', 'device-named', 'link-changed', 'link-probe-failed',
    'config-changed', 'role-changed', 'peer-online', 'peer-offline', 'peer-added', 'peer-removed',
    'oplog-trimmed', 'pull-missing', 'pull-local-newer',
  ];
  for (const event of quiet) {
    assert.equal(outcomeOf({ level: 'info', event }), 'none', event);
  }
});

test('结果分类：真有内容落地的事件才算「有改动」', () => {
  const changed = [
    'local-broadcast', 'push-ok', 'push-received', 'push-page', 'push-file', 'push-delete',
    'push-move', 'push-merged', 'move-superseded', 'pull-applied', 'pull-page', 'pull-file',
    'pull-delete', 'pull-move', 'file-pull-ok', 'file-received', 'file-pull-retry-ok',
    'session-pull-retry-ok', 'replay',
  ];
  for (const event of changed) {
    assert.equal(
      outcomeOf({ level: 'info', event, data: { count: 1, items: ['修改页面「A」'], paths: ['Wiki/概念/a.md'] } }),
      'changed',
      event,
    );
  }
});

test('结果分类：警告与错误一律算「失败」（含自动重试、已自愈的降级）', () => {
  const warn = ['push-retry', 'push-rejected', 'file-pull-retry-failed', 'session-pull-retry-failed', 'dualstack-ipv4-fallback', 'disconnected', 'file-pull-deferred', 'reconcile-item-failed', 'ledger-repair-failed'];
  for (const event of warn) {
    assert.equal(outcomeOf({ level: 'warn', event }), 'failed', event);
  }
  for (const event of ['apply-failed', 'reconcile-failed', 'file-rejected']) {
    assert.equal(outcomeOf({ level: 'error', event }), 'failed', event);
  }
});

test('结果分类：看着有数、其实什么都没改的批次不算「有改动」', () => {
  // 对账跑完但一项都没拉、账本也没补：这是一次「正常对账」
  assert.equal(outcomeOf({ level: 'info', event: 'reconcile-done', data: { entries: 128, pulled: 0, ledgerRepaired: 0, failed: 0 } }), 'none');
  assert.equal(outcomeOf({ level: 'info', event: 'reconcile-done', data: { pulled: 2 } }), 'changed', '拉了内容就算改动');
  assert.equal(outcomeOf({ level: 'info', event: 'reconcile-done', data: { pulled: 0, ledgerRepaired: 1 } }), 'changed', '补齐提炼账本也算改动');
  // 「应用中枢变更 12 项（均为系统页或无变化）」：count 有值但可见改动为空
  assert.equal(outcomeOf({ level: 'info', event: 'pull-applied', data: { count: 12, items: [], paths: [], changes: [] } }), 'none');
  assert.equal(outcomeOf({ level: 'info', event: 'pull-applied', data: { count: 1, paths: ['Wiki/概念/a.md'] } }), 'changed');
});

test('内容分类：按知识库目录归类，认不出的落「其他」', () => {
  assert.equal(contentTypeOfPath('原始资料/文档/2026.09.28_报价单.xlsx'), '原始资料');
  assert.equal(contentTypeOfPath('原始资料/灵感碎片/随手记.md'), '原始资料');
  assert.equal(contentTypeOfPath('Wiki/概念/供应商准入.md'), '概念');
  assert.equal(contentTypeOfPath('Wiki/实体/津亚电子.md'), '实体');
  assert.equal(contentTypeOfPath('AIWorks/log/log.md'), '内置 Agent');
  assert.equal(contentTypeOfPath('Wiki/归档/2026-08/会议纪要.md'), '其他');
  assert.equal(contentTypeOfPath(''), '其他');
});

test('内容分类：一条记录可以同时属于多类，会话与看板归「内置 Agent」', () => {
  assert.deepEqual(
    contentTypesOf('local-broadcast', { paths: ['Wiki/概念/a.md', 'Wiki/实体/b.md', '原始资料/文档/c.md'] }),
    ['原始资料', '概念', '实体'],
  );
  // 会话 / 任务看板不在 brain 目录里（path 是会话 id）：按 kind 归类，不能误算成「其他」
  assert.deepEqual(contentTypesOf('push-ok', { paths: ['sess-123'], kinds: { session: 1 } }), ['内置 Agent']);
  assert.deepEqual(contentTypesOf('push-ok', { kinds: { board: 1 } }), ['内置 Agent']);
  // 纯 AIWorks 同步（索引 / 日志 / 关联表）
  assert.deepEqual(contentTypesOf('reconcile-done', { paths: ['AIWorks/index/index.md', 'AIWorks/log/log.md'] }), ['内置 Agent']);
  // 有改动但没有任何路径信息（老记录只留了文字）：落到「其他」，不空着
  assert.deepEqual(contentTypesOf('push-ok', { count: 1 }), ['其他']);
  // 没改动的事件不凭空挂类型
  assert.deepEqual(contentTypesOf('connected', {}), []);
  assert.deepEqual(contentTypesOf('snapshot-served', { entries: 128 }), []);
});

test('查询判定：matchesOutcome / matchesContent 与分类结果一致', () => {
  const entry = { level: 'info', event: 'local-broadcast', data: { count: 1, paths: ['Wiki/概念/a.md'] } };
  assert.equal(matchesOutcome(entry, 'changed'), true);
  assert.equal(matchesOutcome(entry, 'none'), false);
  assert.equal(matchesContent(entry, '概念'), true);
  assert.equal(matchesContent(entry, '实体'), false);
});
