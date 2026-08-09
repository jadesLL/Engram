import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineDiff } from './diff.js';

test('buildLineDiff keeps context and marks additions and removals', () => {
  const diff = buildLineDiff(
    '# Title\n\nold line\nsame tail',
    '# Title\n\nnew line\nextra\nsame tail'
  );
  assert.ok(diff.some((line) => line.kind === 'remove' && line.text === 'old line'));
  assert.ok(diff.some((line) => line.kind === 'add' && line.text === 'new line'));
  assert.ok(diff.some((line) => line.kind === 'add' && line.text === 'extra'));
  assert.ok(diff.some((line) => line.kind === 'same' && line.text === 'same tail'));
});

test('buildLineDiff returns a stable no-change marker', () => {
  assert.deepEqual(buildLineDiff('same', 'same'), [{ kind: 'same', text: '（内容无变化）' }]);
});

test('buildLineDiff bounds very large previews', () => {
  const before = Array.from({ length: 200 }, (_, index) => `old ${index}`).join('\n');
  const after = Array.from({ length: 200 }, (_, index) => `new ${index}`).join('\n');
  const diff = buildLineDiff(before, after);
  assert.ok(diff.length <= 81);
  assert.ok(diff.some((line) => line.text.includes('已截断')));
});
