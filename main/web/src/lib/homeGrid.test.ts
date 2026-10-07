import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_COLS,
  GRID_MAX_H,
  GRID_MAX_ROWS,
  GRID_MAX_W,
  GRID_MIN_H,
  GRID_MIN_W,
  autoArrange,
  clampH,
  clampW,
  compact,
  findFreeSpot,
  intersects,
  isSane,
  normalizePlace,
  placeItem,
  usedRows,
  type GridPlace,
} from './homeGrid.ts';

const rect = (col: number, row: number, w = 2, h = 2): GridPlace => ({ col, row, w, h });

test('栅格口径：6 列、宽 1..6、高 1..12、默认查找 48 行', () => {
  assert.equal(GRID_COLS, 6);
  assert.equal(GRID_MAX_W, 6);
  assert.equal(GRID_MAX_H, 12);
  assert.equal(GRID_MIN_W, 1);
  assert.equal(GRID_MIN_H, 1);
  assert.equal(GRID_MAX_ROWS, 48);
});

test('clampW / clampH：非法与非整数都收敛到合法值', () => {
  assert.equal(clampW(0), 1);
  assert.equal(clampW(-3), 1);
  assert.equal(clampW(99), GRID_MAX_W);
  assert.equal(clampW(3.4), 3);
  assert.equal(clampW(Number.NaN), 1);
  assert.equal(clampH(0), 1);
  assert.equal(clampH(99), GRID_MAX_H);
  assert.equal(clampH(undefined as any), 1);
});

test('normalizePlace：宽先夹，再按夹后的宽算 col 上限（不会横向溢出）', () => {
  assert.deepEqual(normalizePlace({ col: 99, row: 5, w: 99, h: 99 }), { col: 0, row: 5, w: 6, h: 12 });
  assert.deepEqual(normalizePlace({ col: 4, row: 2, w: 6, h: 2 }), { col: 0, row: 2, w: 6, h: 2 });
  assert.deepEqual(normalizePlace({ col: -4, row: -2, w: 2, h: 2 }), { col: 0, row: 0, w: 2, h: 2 });
  assert.deepEqual(normalizePlace(null), { col: 0, row: 0, w: 1, h: 1 });
});

test('intersects：只在真正交叠时为真（相切不算）', () => {
  assert.equal(intersects(rect(0, 0, 2, 2), rect(2, 0, 2, 2)), false, '左右相切');
  assert.equal(intersects(rect(0, 0, 2, 2), rect(0, 2, 2, 2)), false, '上下相切');
  assert.equal(intersects(rect(0, 0, 2, 2), rect(1, 1, 2, 2)), true);
  assert.equal(intersects(rect(0, 0, 2, 2), rect(0, 0, 2, 2)), true);
});

test('findFreeSpot：行优先找第一个放得下的位置', () => {
  assert.deepEqual(findFreeSpot([], 2, 2), rect(0, 0, 2, 2));
  // (0,0) 被占：同一行还能放 (2,0)
  assert.deepEqual(findFreeSpot([rect(0, 0, 2, 2)], 2, 2), rect(2, 0, 2, 2));
  // 整行被占：落到下一行
  assert.deepEqual(findFreeSpot([rect(0, 0, 6, 2)], 2, 2), rect(0, 2, 2, 2));
  // 6 格宽卡在有两张小卡的页面里要落到下面
  assert.deepEqual(findFreeSpot([rect(0, 0, 3, 2), rect(3, 0, 3, 2)], 6, 2), rect(0, 2, 6, 2));
});

test('placeItem：目标空着就放目标位置；没变时内容等价', () => {
  const items = [rect(0, 0, 2, 2), rect(2, 0, 2, 2)];
  const placed = placeItem(items, 1, rect(4, 0, 2, 2));
  assert.deepEqual(placed[1], rect(4, 0, 2, 2));
  assert.ok(isSane(placed));
});

test('placeItem：目标被占 → 当前卡片落点不变，其他卡片向下让位', () => {
  const items = [rect(0, 0, 2, 2), rect(2, 0, 2, 2)];
  // 当前卡片占据目标，原卡片向下让位
  const stacked = placeItem(items, 1, rect(0, 0, 2, 2));
  assert.ok(isSane(stacked));
  assert.deepEqual(stacked[1], rect(0, 0, 2, 2));
  assert.deepEqual(stacked[0], rect(0, 2, 2, 2), '冲突卡片向下让位');
});

test('placeItem：整行卡扩宽后保持目标位置，冲突卡片下移', () => {
  // 两张 3 格卡占满第一行，将第一张扩宽后推开第二张
  const items = [rect(0, 0, 3, 2), rect(3, 0, 3, 2)];
  const placed = placeItem(items, 0, rect(0, 0, 6, 2));
  assert.ok(isSane(placed));
  assert.deepEqual(placed[0], rect(0, 0, 6, 2), '选定落点不变');
  assert.deepEqual(placed[1], rect(3, 2, 3, 2), '重叠卡片下移');
});

test('placeItem：页面塞满时也能放下（不许把卡片丢出栅格外）', () => {
  // 2 行 × 6 列全被占满；把第三张挪到 (0,2) 的位置 → 它得挤进某个空位或把别人让开
  const items = [rect(0, 0, 3, 2), rect(3, 0, 3, 2), rect(0, 2, 3, 2), rect(3, 2, 3, 2)];
  const placed = placeItem(items, 2, rect(0, 0, 3, 2));
  assert.ok(isSane(placed));
  const moved = placed[2];
  assert.equal(moved.w, 3);
  assert.equal(moved.h, 2);
  assert.ok(moved.col >= 0 && moved.col + moved.w <= GRID_COLS);
  assert.ok(moved.row >= 0);
  // 谁都没被压出 48 行以外
  for (const item of placed) assert.ok(item.row + item.h <= 48);
});

test('placeItem：越界请求被夹进栅格（这就是「卡片不会飞出页面」的保证）', () => {
  const items = [rect(0, 0, 2, 2)];
  for (const wanted of [rect(99, 99, 2, 2), rect(-9, -9, 6, 3), rect(5, 0, 2, 2)]) {
    const placed = placeItem(items, 0, wanted);
    assert.ok(isSane(placed), `越界后仍要干净：${JSON.stringify(placed)}`);
    assert.ok(placed[0].col >= 0 && placed[0].col + placed[0].w <= GRID_COLS);
  }
  // index 非法时原样返回
  const same = placeItem(items, 5, rect(2, 0, 2, 2));
  assert.deepEqual(same, items);
});

test('placeItem：反复随机放置 200 次，布局始终干净', () => {
  let items: GridPlace[] = autoArrange(Array.from({ length: 32 }, (_, i) => ({ w: (i % 6) + 1, h: (i % 12) + 1 })));
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 200; i++) {
    const w = clampW(Math.round(next() * GRID_COLS));
    const h = clampH(Math.round(next() * 6));
    items = placeItem(items, Math.floor(next() * items.length), {
      col: Math.round(next() * 8) - 2,
      row: Math.round(next() * 20) - 2,
      w,
      h,
    });
    assert.ok(isSane(items), `第 ${i} 次放置后不干净：${JSON.stringify(items)}`);
  }
});

test('compact：往上收掉空洞，横向位置与宽高不变', () => {
  const items = [rect(0, 5, 2, 2), rect(2, 9, 2, 2)];
  const packed = compact(items);
  assert.deepEqual(packed[0], rect(0, 0, 2, 2));
  assert.deepEqual(packed[1], rect(2, 0, 2, 2), '横向位置保持');
  assert.ok(isSane(packed));
  // 已经紧凑时不再变化
  assert.deepEqual(compact(packed), packed);
  // 下面有卡时不会被压进别人身上
  const stacked = compact([rect(0, 0, 6, 2), rect(0, 9, 6, 2)]);
  assert.deepEqual(stacked[1], rect(0, 2, 6, 2));
});

test('autoArrange：顺次铺满，宽度不够换行；越界宽度被夹', () => {
  const arranged = autoArrange([
    { w: 3, h: 2 },
    { w: 3, h: 3 },
    { w: 6, h: 2 },
    { w: 99, h: 1 },
  ]);
  assert.deepEqual(arranged[0], { col: 0, row: 0, w: 3, h: 2 });
  assert.deepEqual(arranged[1], { col: 3, row: 0, w: 3, h: 3 });
  // 第三张 6 格放不进剩下的 0 格 → 换行，行高取本行最高的 3
  assert.deepEqual(arranged[2], { col: 0, row: 3, w: 6, h: 2 });
  assert.equal(arranged[3].w, GRID_COLS, '超宽被夹到整行');
  assert.ok(isSane(arranged));
});

test('usedRows：取最底边的行数，空布局为 0', () => {
  assert.equal(usedRows([]), 0);
  assert.equal(usedRows([rect(0, 0, 2, 2), rect(2, 3, 2, 4)]), 7);
});

test('isSane：能识别越界与重叠', () => {
  assert.equal(isSane([]), true);
  assert.equal(isSane([rect(0, 0, 6, 2)]), true);
  assert.equal(isSane([rect(1, 0, 6, 2)]), false, '越界');
  assert.equal(isSane([rect(0, -1, 2, 2)]), false, '负行');
  assert.equal(isSane([rect(0, 0, 2, 2), rect(1, 1, 2, 2)]), false, '重叠');
  assert.equal(isSane([{ col: 0, row: 0, w: 0, h: 2 }]), false, '宽为 0');
});


test('32 张最大卡片超过 48 行，拖动、紧凑、新增仍不重叠', () => {
  const items = autoArrange(Array.from({ length: 32 }, () => ({ w: 6, h: 12 })));
  const placed = placeItem(items, 31, rect(0, 0, 6, 12));
  assert.deepEqual(placed[31], rect(0, 0, 6, 12));
  assert.ok(isSane(placed));
  assert.ok(isSane(compact(placed)));
  assert.deepEqual(findFreeSpot(placed, 6, 12), rect(0, 384, 6, 12));
});
