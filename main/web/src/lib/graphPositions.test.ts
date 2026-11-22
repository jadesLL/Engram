import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGraphPositions, getGraphPosition, graphPositionCount, hasGraphPosition, rememberGraphPosition,
} from './graphPositions.ts';

test('positions survive re-mounts and ignore non-finite coordinates', () => {
  clearGraphPositions();
  assert.equal(hasGraphPosition('p1'), false);
  rememberGraphPosition('p1', 12, -8);
  assert.deepEqual(getGraphPosition('p1'), { x: 12, y: -8 });
  rememberGraphPosition('p1', 30, 40);
  assert.deepEqual(getGraphPosition('p1'), { x: 30, y: 40 });
  rememberGraphPosition('p2', Number.NaN, 4);
  assert.equal(hasGraphPosition('p2'), false);
  assert.equal(graphPositionCount(), 1);
  clearGraphPositions();
  assert.equal(hasGraphPosition('p1'), false);
});
