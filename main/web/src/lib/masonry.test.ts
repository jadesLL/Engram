import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAP,
  MAX_LANES,
  MIN_LANE_WIDTH,
  SINGLE_COLUMN_WIDTH,
  laneCount,
  maxSpan,
  overlaps,
  placeCards,
} from './masonryCalc.ts';

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

/* ===== 排布：碰撞检测 + 补空档 ===== */

test('overlaps：只有 x 与 y 同时交叠才算重叠', () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  assert.equal(overlaps(a, { x: 0, y: 10, width: 100, height: 50 }), true);
  assert.equal(overlaps(a, { x: 0, y: 50, width: 100, height: 50 }), false, '上下相切不算重叠');
  assert.equal(overlaps(a, { x: 100, y: 0, width: 100, height: 50 }), false, '左右相切不算重叠');
  assert.equal(overlaps(a, { x: 50, y: 10, width: 100, height: 50 }), true);
});

test('placeCards：整行卡按顺序堆叠，窄卡贴在其下方', () => {
  const rects = placeCards([4, 4, 2, 2], [100, 80, 60, 60], 1000, 4);
  assert.deepEqual(rects[0], { x: 0, y: 0, width: 1000, height: 100 });
  assert.equal(rects[1].y, 112, '第二张整行卡在上一张下面（含间距）');
  assert.equal(rects[1].x, 0);
  assert.equal(rects[2].y, 204, '半宽卡跟在整行卡下方');
  assert.equal(rects[2].x, 0);
  assert.equal(rects[3].x, 506, '第二张半宽卡并排到右边');
  assert.equal(rects[3].y, 204);
});

test('placeCards：能并排的窄卡会补进上面留出的空档（不悬空、不留大洞）', () => {
  // 4 车道各 241px：先两张 1 格（左、次左），再一张 2 格 —— 后者应贴到 y=0 的右侧，
  // 而不是被推到两张矮卡的下面（这正是「贪心放最矮车道」看不出、碰撞检测能做到的补空档）
  const rects = placeCards([1, 1, 2], [200, 80, 150], 1000, 4);
  assert.equal(rects[0].y, 0);
  assert.equal(rects[1].y, 0);
  assert.equal(rects[2].y, 0, '2 格卡应并排在同一行，而不是垫到 200+ 下面');
  assert.equal(rects[2].width, 494);
  // 它只能落在右侧：左边两条车道被前两张占了（第 2 张只占 80 高，2 格卡要跨两条车道，
  // 左侧两条里有一条被 200 高的卡压着 → 只能往右）
  assert.ok(rects[2].x >= 500, `2 格卡应落在右侧空档：x=${rects[2].x}`);
});

test('placeCards：每张卡都放在「当前能放的最上面」（不会无故往下掉）', () => {
  const spans = [1, 2, 1, 3, 2, 1];
  const heights = [140, 90, 110, 200, 130, 70];
  const width = 1000;
  const lanes = 4;
  const gap = 12;
  const laneWidth = (width - gap * (lanes - 1)) / lanes;
  const rects = placeCards(spans, heights, width, lanes);

  // 独立复算：对每张卡，扫遍候选位取最小的合法 y —— 应等于实际落点
  for (let index = 0; index < rects.length; index++) {
    const span = Math.max(1, Math.min(lanes, spans[index]));
    const cardWidth = span * laneWidth + (span - 1) * gap;
    const prior = rects.slice(0, index);
    const offsets = new Set<number>([0]);
    for (const rect of prior) offsets.add(rect.y + rect.height + gap);
    let lowest = Infinity;
    for (const y of offsets) {
      for (let lane = 0; lane + span <= lanes; lane++) {
        const candidate = { x: lane * (laneWidth + gap), y, width: cardWidth, height: heights[index] };
        if (prior.some((rect) => overlaps(candidate, rect))) continue;
        lowest = Math.min(lowest, y);
      }
    }
    assert.equal(rects[index].y, lowest, `第 ${index} 张没放在最上面（复算 ${lowest}，实际 ${rects[index].y}）`);
  }
});

test('placeCards：任何两张都不重叠', () => {
  const spans = [2, 1, 4, 1, 2, 1, 3, 2];
  const heights = [120, 260, 90, 80, 140, 70, 200, 110];
  const rects = placeCards(spans, heights, 1046, 4);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(overlaps(rects[i], rects[j]), false, `${i} 与 ${j} 重叠了`);
    }
  }
  // 每张卡都在页宽以内
  for (const rect of rects) {
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 1046 + 0.01, `越界：${JSON.stringify(rect)}`);
  }
});

test('placeCards：整行卡不插到前面卡片上边（保持视觉顺序）', () => {
  // 先一张高整行、再两张矮半宽、最后一张整行：最后这张必须在矮卡下面，不能回到 y=0
  const rects = placeCards([4, 2, 2, 4], [200, 60, 60, 50], 1000, 4);
  const last = rects[3];
  const above = rects[1];
  assert.ok(last.y >= above.y + above.height, `整行卡插队了：last.y=${last.y}, above=${above.y}+${above.height}`);
});

test('placeCards：宽度为 0 / 车道为 1 等边界不炸', () => {
  const rects = placeCards([1, 1], [50, 50], 0, 1);
  assert.equal(rects.length, 2);
  assert.equal(rects[0].width, 0);
  assert.equal(rects[1].y, 62, '单车道时就是普通竖向堆叠');
  assert.deepEqual(placeCards([], [], 100, 4), []);
});
