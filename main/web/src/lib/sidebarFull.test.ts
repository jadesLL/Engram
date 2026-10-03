import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEBAR_FULL_COLUMNS,
  SIDEBAR_FULL_BADGES,
  SIDEBAR_FULL_LABELS,
  sidebarFullChips,
  sidebarFullFileMark,
  sidebarFullVisibleTotal,
} from './sidebarFull.ts';

/** 满窗分栏扫描的纯计算：列顺序、筛选 chips 与「共 N 篇」的口径 */

test('列顺序：概念 → 实体 → 原始资料 → 归档（归档这个低流量分区放最后）', () => {
  assert.deepEqual([...SIDEBAR_FULL_COLUMNS], ['concept', 'entity', 'raw', 'archived']);
  for (const key of SIDEBAR_FULL_COLUMNS) {
    assert.ok(SIDEBAR_FULL_LABELS[key], `${key} 缺列名`);
    assert.ok(SIDEBAR_FULL_BADGES[key], `${key} 缺类型色`);
  }
});

test('chips：全部在最前，计数缺省按 0，总数等于四列之和', () => {
  const chips = sidebarFullChips({ concept: 6, entity: 14, raw: 10, archived: 4 });
  assert.deepEqual(chips.map((c) => c.key), ['all', 'concept', 'entity', 'raw', 'archived']);
  assert.equal(chips[0].count, 34);
  assert.equal(chips.find((c) => c.key === 'raw')?.label, '原始资料');
  // 空库（或旧服务端字段缺失）不该是 NaN
  const empty = sidebarFullChips({});
  assert.equal(empty[0].count, 0);
  assert.ok(empty.every((c) => Number.isFinite(c.count)));
});

test('「共 N 篇」跟着筛选走：选了某一类就只数那一列', () => {
  const counts = { concept: 6, entity: 14, raw: 10, archived: 4 };
  assert.equal(sidebarFullVisibleTotal(counts, 'all'), 34);
  assert.equal(sidebarFullVisibleTotal(counts, 'entity'), 14);
  assert.equal(sidebarFullVisibleTotal(counts, 'raw'), 10);
  assert.equal(sidebarFullVisibleTotal({}, 'all'), 0);
  assert.equal(sidebarFullVisibleTotal({ concept: -3 }, 'concept'), 0);
});

/**
 * 原始资料行的状态标（2026-10-03 用户报障「原始资料也要能显示已提炼」）：
 * 满窗列里原先只有标题和时间，优先级必须与窄栏 FileRow 的 v-if 顺序一字不差。
 */
test('已提炼：干净入库的 md 在满窗列里也要有这一格', () => {
  const mark = sidebarFullFileMark({ path: '原始资料/文档/a.md', distilled: true });
  assert.deepEqual(mark, {
    label: '已提炼',
    tone: 'success',
    tip: '已由外部 Agent 提炼入库（来源证据抽屉可复核）',
  });
});

test('优先级与窄栏同序：提炼中/失败 > 提取进度 > 已提炼 > 提取失败 > 部分提取 > 已提取 > 待提取', () => {
  const distilled = { path: '原始资料/灵感碎片/x.md', distilled: true };
  // 正在发生的提炼压过「已提炼」（窄栏行尾只有一格状态位）
  assert.equal(sidebarFullFileMark(distilled, null, { label: '提炼中', kind: 'running' })?.label, '提炼中');
  assert.equal(sidebarFullFileMark(distilled, null, { label: '提炼中', kind: 'running' })?.tone, 'running');
  assert.equal(sidebarFullFileMark(distilled, null, { label: '提炼失败', kind: 'failed' })?.tone, 'failed');
  // 提取进度压过「已提炼」，且文案与窄栏一致（阶段 + 百分比）
  const job = sidebarFullFileMark(distilled, { stage: '提取中', progress: 40, detail: '解析第 2 页' });
  assert.equal(job?.label, '提取中 40%');
  assert.equal(job?.tone, 'running');
  assert.equal(job?.tip, '解析第 2 页');
  assert.equal(sidebarFullFileMark({}, { stage: '提取中' })?.label, '提取中 0%', '进度缺省不该出现 NaN');
  // 提取状态：失败 / 部分 / 完成 / 其它（待提取）
  assert.equal(sidebarFullFileMark({ extractionStatus: 'failed' })?.label, '提取失败');
  assert.equal(sidebarFullFileMark({ extractionStatus: 'failed', extractionError: 'boom' })?.tone, 'failed');
  assert.equal(sidebarFullFileMark({ extractionStatus: 'partial' })?.tone, 'warning');
  assert.equal(sidebarFullFileMark({ extractionStatus: 'completed' })?.label, '已提取');
  assert.equal(sidebarFullFileMark({ extractionStatus: 'queued' })?.label, '待提取');
  // 已入库的干净 md / 空值：不占位（不给每一行都挂一个灰标）
  assert.equal(sidebarFullFileMark({ path: '原始资料/文档/b.md' }), null);
  assert.equal(sidebarFullFileMark({ extractionStatus: '' }), null);
  assert.equal(sidebarFullFileMark(null), null);
  assert.equal(sidebarFullFileMark(undefined, null, null), null);
});
