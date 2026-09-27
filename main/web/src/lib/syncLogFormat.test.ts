import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_EVENT_META,
  buildSyncLogJson,
  buildSyncLogMarkdown,
  dataLabel,
  eventCategory,
  eventLabel,
  formatBytes,
  formatDataValue,
  formatDuration,
  formatLogClock,
  formatLogTime,
  formatRelative,
  type SyncLogEntry,
} from './syncLogFormat.ts';

/**
 * 同步详情抽屉的展示层回归：
 *  - 服务端事件名必须都有中文标签（漏一个用户在抽屉里就只能看到英文 id）；
 *  - 结构化字段要有中文名与人话格式（字节/耗时不能直接甩数字）；
 *  - 导出的 Markdown / JSON 要能被别人直接读（表格 + 字段清单 + 筛选说明）。
 */

function entry(over: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return {
    id: 1,
    ts: '2026-09-25T02:03:04.567Z',
    level: 'info',
    event: 'push-ok',
    scope: 'member',
    detail: '推送 2 项变更：页面 1 · 文件 1',
    data: { count: 2, kinds: { page: 1, file: 1 }, bytes: 2048, ms: 1500 },
    ...over,
  };
}

test('事件标签：已知事件给中文，未知事件原样透出', () => {
  assert.equal(eventLabel('push-conflict'), '冲突裁决');
  assert.equal(eventLabel('peer-token-reset'), '重置成员令牌');
  assert.equal(eventLabel('some-new-event'), 'some-new-event', '服务端新增事件不能显示成空白');
  assert.equal(eventCategory('push-conflict'), '冲突');
  assert.equal(eventCategory('peer-online'), '成员');
  assert.equal(eventCategory('some-new-event'), '其他');
});

test('事件标签表覆盖服务端全部事件（前端漏标签会导致抽屉里只剩英文 id）', () => {
  const serverEvents = [
    'start', 'stopped', 'connected', 'reconnected', 'disconnected',
    'push-ok', 'push-retry', 'push-received', 'push-rejected', 'push-merged', 'apply-failed', 'move-superseded',
    'local-broadcast',
    'file-pull-ok', 'file-pull-deferred', 'file-pull-retry-ok', 'file-pull-retry-failed', 'file-received', 'file-rejected',
    'replay', 'pull-applied', 'oplog-trimmed',
    'reconcile-start', 'reconcile-done', 'reconcile-item-failed', 'reconcile-failed', 'ledger-repair-failed', 'heal', 'snapshot-served',
    'push-conflict',
    'peer-online', 'peer-offline', 'peer-added', 'peer-removed', 'peer-token-reset',
    'role-changed', 'config-changed',
  ];
  // Android 成员端逐条记录：手机上的「同步详情」全靠这些事件名翻译成人话
  const androidEvents = [
    'sync-done', 'sync-paused', 'sync-failed', 'changes-too-large',
    'pull-page', 'pull-file', 'pull-delete', 'pull-move', 'pull-local-newer',
    'push-page', 'push-file', 'push-delete', 'push-move',
  ];
  for (const event of [...serverEvents, ...androidEvents]) {
    assert.ok(SYNC_EVENT_META[event], `事件 ${event} 缺少中文标签`);
    assert.ok(eventLabel(event) !== event, `事件 ${event} 的标签不能还是 id 本身`);
  }
});

test('逐条改动条目：动作与类型翻成中文，改名带原路径', () => {
  assert.equal(eventLabel('pull-page'), '拉取页面');
  assert.equal(eventCategory('pull-page'), '拉取');
  assert.equal(eventLabel('push-file'), '推送文件');
  assert.equal(eventCategory('push-file'), '推送');
  assert.equal(eventLabel('pull-local-newer'), '本机版本较新，未覆盖');
  assert.equal(eventLabel('sync-done'), '一轮同步完成');

  assert.equal(dataLabel('oldPath'), '改名原路径');
  assert.equal(dataLabel('verb'), '动作');
  assert.equal(formatDataValue('verb', 'push'), '推送本机改动');
  assert.equal(formatDataValue('verb', 'update'), '修改');
  assert.equal(formatDataValue('kind', 'page'), '页面');
  assert.equal(formatDataValue('revision', 42), '42', '版本号原样展示');
});

test('结构化字段：中文名 + 人话格式', () => {
  assert.equal(dataLabel('bytes'), '字节数');
  assert.equal(dataLabel('ms'), '耗时');
  assert.equal(dataLabel('unknownField'), 'unknownField');
  assert.equal(formatDataValue('bytes', 2048), '2.0 KB（2048 B）');
  assert.equal(formatDataValue('ms', 1500), '1.5 秒（1500 ms）');
  assert.equal(formatDataValue('retryInMs', 30000), '30 秒');
  assert.equal(formatDataValue('theirWins', true), '是');
  assert.equal(formatDataValue('kinds', { page: 1 }), '{"page":1}');
  assert.equal(formatDataValue('path', 'Wiki/概念/测试.md'), 'Wiki/概念/测试.md');
});

test('结构化字段：条目清单与体积按行 / 人话展示', () => {
  const items = ['新增页面「会议纪要」（+6 行，1.2 KB）', '修改页面「周报」（+2 −1 行）'];
  assert.equal(formatDataValue('items', items), items.join('\n'), '条目清单逐行展示');
  assert.equal(formatDataValue('paths', ['Wiki/概念/a.md', '原始资料/b.bin']), 'Wiki/概念/a.md\n原始资料/b.bin');
  assert.equal(formatDataValue('beforeBytes', 2048), '2.0 KB（2048 B）');
  assert.equal(formatDataValue('downMs', 42_000), '42.0 秒（42000 ms）');
  assert.equal(dataLabel('items'), '涉及的条目');
  assert.equal(dataLabel('added'), '新增行');
});

test('时间与体量格式化：毫秒精度、相对时间分档', () => {
  const iso = new Date(2026, 8, 25, 10, 3, 4, 567).toISOString();
  assert.equal(formatLogTime(iso), '2026-09-25 10:03:04.567');
  assert.equal(formatLogClock(iso), '10:03:04.567');
  assert.equal(formatLogTime('不是时间'), '不是时间', '解析不了时原样返回，不能显示 Invalid Date');

  const now = new Date('2026-09-25T10:00:00.000Z').getTime();
  assert.equal(formatRelative(null, now), '—');
  assert.equal(formatRelative(new Date(now - 3_000).toISOString(), now), '刚刚');
  assert.equal(formatRelative(new Date(now - 42_000).toISOString(), now), '42 秒前');
  assert.equal(formatRelative(new Date(now - 5 * 60_000).toISOString(), now), '5 分钟前');
  assert.equal(formatRelative(new Date(now - 3 * 3_600_000).toISOString(), now), '3 小时前');
  assert.equal(formatRelative(new Date(now - 2 * 86_400_000).toISOString(), now), '2 天前');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatDuration(320), '320 毫秒');
  assert.equal(formatDuration(1500), '1.5 秒');
  assert.equal(formatDuration(95_000), '1 分 35 秒');
});

test('导出 JSON：条目与筛选说明都带上，且能被 JSON.parse 回来', () => {
  const text = buildSyncLogJson([entry()], { filters: { level: 'warn' } });
  const parsed = JSON.parse(text) as { count: number; filters: { level: string }; entries: SyncLogEntry[] };
  assert.equal(parsed.count, 1);
  assert.equal(parsed.filters.level, 'warn');
  assert.equal(parsed.entries[0].event, 'push-ok');
  assert.equal(parsed.entries[0].data?.bytes, 2048);
});

test('导出 Markdown：表格 + 结构化字段清单，管道符转义', () => {
  const text = buildSyncLogMarkdown([
    entry(),
    entry({
      id: 2,
      level: 'warn',
      event: 'push-conflict',
      scope: 'hub',
      peer: '客厅 NAS',
      detail: '「A|B.md」冲突：按修改时间以中枢为准',
      data: { path: 'A|B.md', theirWins: false, copyPath: 'A-20260925.md' },
    }),
  ], { level: '全部', scope: '中枢', q: '客厅' });

  assert.ok(text.startsWith('# Engram 同步日志导出'), '带标题');
  assert.ok(text.includes('- 条目数：2'), '带条目数');
  assert.ok(text.includes('- 级别：全部'), '筛选说明按中文名写');
  assert.ok(text.includes('- 视角：中枢') && text.includes('- 关键词：客厅'), '其余筛选也写进去');
  assert.ok(text.includes('| 2026-09-25'), '表格里有完整时间');
  assert.ok(text.includes('推送完成') && text.includes('冲突裁决'), '事件显示中文标签');
  assert.ok(text.includes('客厅 NAS'), '中枢侧事件带成员名');
  assert.ok(text.includes('A\\|B.md'), '表格里的管道符必须转义，否则列会错位');
  assert.ok(text.includes('## 结构化字段'), '带结构化字段章节');
  assert.ok(text.includes('- 字节数：2.0 KB（2048 B）'), '结构化字段用人话格式');
  assert.ok(text.includes('- 推送方胜出：否'), '布尔字段转中文');
});
