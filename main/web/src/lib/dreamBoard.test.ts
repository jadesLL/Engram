import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardHint,
  changeKindText,
  durationText,
  roundMeta,
  roundMetrics,
  roundTone,
  statusText,
  summaryFoldNeeded,
  summaryPeek,
  type DreamBoardRound,
} from './dreamBoard.ts';

/** 提炼看板的展示口径：状态说法、耗时、指标行、折叠预览。数据本身由服务端算好。 */

function round(patch: Partial<DreamBoardRound> = {}): DreamBoardRound {
  return {
    runId: 'run-1',
    startedAt: '2026-09-27T03:00:00.000Z',
    finishedAt: '2026-09-27T03:12:00.000Z',
    durationMs: 12 * 60_000,
    trigger: 'schedule',
    status: 'completed',
    summary: '',
    error: '',
    before: { pendingFiles: 4, issues: 6 },
    after: { pendingFiles: 1, issues: 2, deadLinks: 1, duplicates: 1, outdatedPages: 0 },
    pages: [],
    sources: [],
    changes: [],
    counts: { pages: 0, sources: 0, changes: 0, calls: 0 },
    ...patch,
  };
}

test('roundTone / statusText：每种轮次状态都有说法与配色档', () => {
  assert.equal(roundTone('completed'), 'ok');
  assert.equal(roundTone('failed'), 'bad');
  assert.equal(roundTone('interrupted'), 'bad');
  assert.equal(roundTone('running'), 'busy');
  assert.equal(roundTone('queued'), 'busy');
  assert.equal(roundTone('cancelled'), 'plain');

  assert.equal(statusText('completed'), '完成');
  assert.equal(statusText('failed'), '失败');
  assert.equal(statusText('cancelled'), '已停止');
  assert.equal(statusText('interrupted'), '中断');
  assert.equal(statusText('running'), '运行中');
  assert.equal(statusText(''), '未知');
  assert.equal(statusText('weird'), 'weird', '认不出的状态原样显示，不吞掉信息');
});

test('durationText：秒级、分钟级、小时级都说人话', () => {
  assert.equal(durationText(0), '');
  assert.equal(durationText(-1), '');
  assert.equal(durationText(40_000), '不到 1 分钟');
  assert.equal(durationText(12 * 60_000), '12 分钟');
  assert.equal(durationText(60 * 60_000), '1 小时');
  assert.equal(durationText(95 * 60_000), '1 小时 35 分');
});

test('roundMeta：触发方式、耗时、工具调用次数拼成一行', () => {
  assert.equal(
    roundMeta(round({ counts: { pages: 2, sources: 1, changes: 0, calls: 42 } })),
    '计划触发 · 耗时 12 分钟 · 工具调用 42 次',
  );
  assert.equal(roundMeta(round({ trigger: 'manual' })), '手动触发 · 耗时 12 分钟');
  assert.equal(roundMeta(round({ trigger: '', durationMs: 0 })), '');
});

test('roundMetrics：有记账给「整理前 → 整理后」，没有则退化成本轮计数', () => {
  const withCounts = roundMetrics(round({ counts: { pages: 3, sources: 2, changes: 1, calls: 20 } }));
  assert.deepEqual(withCounts.slice(0, 2), ['待提炼 4 → 1 份', '待核查 6 → 2 处']);
  assert.match(withCounts[2], /剩余：死链 1 · 疑似重复 1 · 规则落后 0/);
  assert.deepEqual(withCounts.slice(3), ['写入页面 3', '读入资料 2', '纠错 1']);

  const legacy = roundMetrics(round({
    before: null,
    after: null,
    counts: { pages: 0, sources: 0, changes: 0, calls: 0 },
  }));
  assert.deepEqual(legacy, ['写入页面 0', '读入资料 0'], '老轮次没有前后计数就不硬编一个');

  const clean = roundMetrics(round({
    after: { pendingFiles: 0, issues: 0, deadLinks: 0, duplicates: 0, outdatedPages: 0 },
    counts: { pages: 1, sources: 1, changes: 0, calls: 8 },
  }));
  assert.equal(clean.some((item) => item.startsWith('剩余')), false, '清零后不再列剩余问题');
  assert.equal(clean.includes('纠错 0'), false, '没有纠错动作就不占位');
});

test('changeKindText：纠错动作的说法', () => {
  assert.equal(changeKindText('create'), '新建资料');
  assert.equal(changeKindText('rename'), '改名');
  assert.equal(changeKindText('move'), '移动');
  assert.equal(changeKindText('delete'), '删除');
});

test('summaryPeek：剥掉 Markdown 记号并截断，收起态只给一行预览', () => {
  assert.equal(summaryPeek('## 本轮完成\n\n- 提炼 2 份资料\n- 修 1 处死链'), '本轮完成 提炼 2 份资料 修 1 处死链');
  assert.equal(summaryPeek('```ts\nconst a = 1;\n```\n收尾'), '收尾', '代码块整段丢掉，别塞进预览');
  assert.equal(summaryPeek('短句'), '短句');
  const long = summaryPeek('很长的一句话'.repeat(30));
  assert.equal(long.length, 73);
  assert.ok(long.endsWith('…'));
});

test('summaryFoldNeeded：短小结不折叠（否则最后一行会被渐隐遮住），长文才折叠', () => {
  assert.equal(summaryFoldNeeded(''), false);
  assert.equal(summaryFoldNeeded('本轮提炼 2 份资料，更新 1 个页面，修正 1 处死链。'), false);
  assert.equal(summaryFoldNeeded('  短短  '), false, '首尾空白不计入长度');
  assert.equal(summaryFoldNeeded('很长的一句话'.repeat(60)), true);
});

test('boardHint：列表满了提示只列最近 N 轮，没满就说跑了多少轮', () => {
  assert.equal(boardHint(undefined), '');
  assert.equal(boardHint({ rounds: [], limit: 5 }), '');
  assert.equal(boardHint({ rounds: [round(), round()], limit: 5 }), '已跑 2 轮');
  assert.equal(boardHint({ rounds: [round(), round()], limit: 2 }), '只列最近 2 轮，更早的进对话里看');
});
