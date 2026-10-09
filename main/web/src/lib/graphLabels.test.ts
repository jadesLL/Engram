import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptGraphLabel, type GraphLabelBox } from './graphLabels.ts';

test('moving labels never paint over the focused title or an earlier label', () => {
  const occupied: GraphLabelBox[] = [{ x: 100, y: 50, w: 80, h: 16 }];
  assert.equal(acceptGraphLabel({ x: 170, y: 55, w: 90, h: 16 }, occupied), false);
  assert.equal(acceptGraphLabel({ x: 200, y: 90, w: 90, h: 16 }, occupied), true);
  assert.equal(acceptGraphLabel({ x: 250, y: 93, w: 75, h: 16 }, occupied), false);
  assert.equal(occupied.length, 2);
  // The same label is shown again after its node moves clear; its planned offset is unchanged.
  assert.equal(acceptGraphLabel({ x: 320, y: 93, w: 75, h: 16 }, occupied), true);
});
