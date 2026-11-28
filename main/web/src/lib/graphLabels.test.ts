import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptGraphLabel,
  computeFitBounds,
  computeLabelOpacity,
  createLabelGrid,
  type GraphLabelBox,
} from './graphLabels.ts';

test('label grid matches a full scan for boxes near cell borders', () => {
  const boxes: GraphLabelBox[] = [
    { x: 95, y: 95, w: 20, h: 20 },   // spans 0/1 cells on both axes
    { x: 300, y: 40, w: 10, h: 10 },
    { x: 40, y: 300, w: 30, h: 30 },
  ];
  const grid = createLabelGrid(96);
  for (const box of boxes) grid.add(box);
  const hit = (a: GraphLabelBox, b: GraphLabelBox) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const samples: GraphLabelBox[] = [
    { x: 100, y: 100, w: 5, h: 5 },   // inside first box
    { x: 116, y: 116, w: 5, h: 5 },   // touches first box after rounding
    { x: 305, y: 45, w: 2, h: 2 },    // inside second
    { x: 200, y: 200, w: 10, h: 10 }, // empty middle
    { x: 0, y: 0, w: 10, h: 10 },     // outside everything
  ];
  for (const sample of samples) {
    assert.equal(grid.intersects(sample), boxes.some((b) => hit(sample, b)));
  }
});

test('moving labels never paint over the focused title or an earlier label', () => {
  const occupied: GraphLabelBox[] = [{ x: 100, y: 50, w: 80, h: 16 }];
  assert.equal(acceptGraphLabel({ x: 170, y: 55, w: 90, h: 16 }, occupied), false);
  assert.equal(acceptGraphLabel({ x: 200, y: 90, w: 90, h: 16 }, occupied), true);
  assert.equal(acceptGraphLabel({ x: 250, y: 93, w: 75, h: 16 }, occupied), false);
  assert.equal(occupied.length, 2);
  // The same label is shown again after its node moves clear; its planned offset is unchanged.
  assert.equal(acceptGraphLabel({ x: 320, y: 93, w: 75, h: 16 }, occupied), true);
});

test('computeLabelOpacity fades labels continuously with scale, threshold and hub degree', () => {
  assert.equal(computeLabelOpacity(0.1, 100, 0, true), 1);
  assert.equal(computeLabelOpacity(0.2, 50, 0, false), 0);
  const hubAlpha = computeLabelOpacity(0.55, 50, 1, false);
  const leafAlpha = computeLabelOpacity(0.55, 50, 0, false);
  assert.ok(hubAlpha > leafAlpha, '高连接度 Hub 应比普通叶子节点更早显字');
  assert.ok(computeLabelOpacity(1.6, 50, 0, false) > 0.99, '高倍率放大后所有节点名应完全显现');
  assert.ok(
    computeLabelOpacity(0.6, 10, 0, false) > computeLabelOpacity(0.6, 90, 0, false),
    '调低文字淡出阈值应让更多标签在更远缩放下显示',
  );
  assert.ok(
    computeLabelOpacity(1.5, 50, 0, false, 170) < computeLabelOpacity(1.5, 50, 0, false, 30),
    '视口内挤满 170 个节点时应抑制普通节点全量出字，放大局部后才渐显',
  );
  assert.equal(computeLabelOpacity(1.5, 50, 0, true, 200), 1);
});

test('computeFitBounds ignores extreme outliers while keeping normal graphs intact', () => {
  const cluster = Array.from({ length: 40 }, (_, i) => ({
    x: (i % 8) * 30 - 105,
    y: Math.floor(i / 8) * 30 - 60,
    r: 8,
  }));
  const normal = computeFitBounds(cluster, true);
  assert.equal(normal.trimmed, false);
  assert.ok(normal.x0 <= -113 && normal.x1 >= 113);

  const withOutlier = [...cluster, { x: 5000, y: 4000, r: 8 }];
  const trimmed = computeFitBounds(withOutlier, true);
  assert.equal(trimmed.trimmed, true);
  assert.ok(trimmed.x1 < 500, '极端离群点不应把主星团包围盒拉成上千像素');

  const full = computeFitBounds(withOutlier, false);
  assert.equal(full.trimmed, false);
  assert.ok(full.x1 >= 5000);
});
