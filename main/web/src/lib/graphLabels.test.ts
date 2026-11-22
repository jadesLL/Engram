import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptGraphLabel, createLabelGrid, type GraphLabelBox } from './graphLabels.ts';

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
