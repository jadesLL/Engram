import test from 'node:test';
import assert from 'node:assert/strict';
import { GAP, MAX_LANES, MIN_LANE_WIDTH, SINGLE_COLUMN_WIDTH, laneCount, maxSpan } from './masonryCalc.ts';

test('口径常量：改了就要同步看 .board-inner 的页宽预算与 .widget 的宽度档', () => {
  assert.equal(MIN_LANE_WIDTH, 168);
  assert.equal(GAP, 12);
  assert.equal(SINGLE_COLUMN_WIDTH, 360);
  assert.equal(MAX_LANES, 5);
});

test('laneCount：窄容器只开一条车道（退回普通文档流）', () => {
  assert.equal(laneCount(320, 4), 1);
  assert.equal(laneCount(359, 5), 1);
});

test('laneCount：宽够也不超过「页面需要的格数」', () => {
  // 1046px 能开 5 条车道，但页面上最大格数是 4 → 只开 4 条（1 格 = 1/4 页）
  assert.equal(laneCount(1046, 4), 4);
  assert.equal(laneCount(1046, 5), 5);
  assert.equal(laneCount(1046, 2), 2);
});

test('laneCount：宽不够时按「一条车道至少 168px」自动少开', () => {
  // (W + 12) / 180 取整
  assert.equal(laneCount(1046, 5), 5); // 5 条各 199.6px
  assert.equal(laneCount(900, 5), 5); // 5 条各 170.4px，刚够
  assert.equal(laneCount(880, 5), 4); // 5 条各 166.4px 不够 → 4 条
  assert.equal(laneCount(700, 5), 3); // 3 条各 225px
  assert.equal(laneCount(560, 5), 3);
  assert.equal(laneCount(520, 5), 2);
  assert.equal(laneCount(400, 5), 2);
  assert.equal(laneCount(340, 5), 1);
});

test('laneCount：异常输入不炸，至少一条车道', () => {
  assert.equal(laneCount(0, 4), 1);
  assert.equal(laneCount(Number.NaN, 4), 1);
  assert.equal(laneCount(1000, 0), 1);
  assert.equal(laneCount(1000, Number.NaN), 1);
  assert.equal(laneCount(1000, 99), MAX_LANES);
});

test('maxSpan：取最大值并夹在 1..5，非法值忽略', () => {
  assert.equal(maxSpan([1, 2, 1]), 2);
  assert.equal(maxSpan([4, 1]), 4);
  assert.equal(maxSpan([9, 1]), 5);
  assert.equal(maxSpan([0, -3]), 1);
  assert.equal(maxSpan([Number.NaN, 2]), 2);
  assert.equal(maxSpan([]), 1);
  assert.equal(maxSpan([undefined as any, null as any]), 1);
});
