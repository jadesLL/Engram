import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEBAR_FULL_COLUMNS,
  SIDEBAR_FULL_BADGES,
  SIDEBAR_FULL_LABELS,
  sidebarFullChips,
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
