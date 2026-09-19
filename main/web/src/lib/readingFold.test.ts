import test from 'node:test';
import assert from 'node:assert/strict';
import { foldRangeSize, headingFoldRanges, type HeadingBlock } from './readingFold.ts';

/* 文档：H2(a) p p H3(b) p H4(c) p H3(d) p H2(e) p */
const blocks: HeadingBlock[] = [
  { level: 2, block: 0 },
  { level: 3, block: 3 },
  { level: 4, block: 5 },
  { level: 3, block: 7 },
  { level: 2, block: 9 },
];
const total = 11;

test('H2 收放覆盖到下一个 H2 之前的全部块（含子节）', () => {
  const ranges = headingFoldRanges(blocks, total);
  assert.deepEqual(ranges[0], { level: 2, block: 0, end: 9 });
  assert.equal(foldRangeSize(ranges[0]), 8);
});

test('H3 收放只覆盖自己那一节，遇到同级 H3 或更高级 H2 结束', () => {
  const ranges = headingFoldRanges(blocks, total);
  assert.deepEqual(ranges[1], { level: 3, block: 3, end: 7 });
  assert.deepEqual(ranges[3], { level: 3, block: 7, end: 9 });
  assert.equal(foldRangeSize(ranges[1]), 3);
});

test('H4 收放遇到 H3 结束，最后一个 H2 收放到文末', () => {
  const ranges = headingFoldRanges(blocks, total);
  assert.deepEqual(ranges[2], { level: 4, block: 5, end: 7 });
  assert.deepEqual(ranges[4], { level: 2, block: 9, end: 11 });
  assert.equal(foldRangeSize(ranges[4]), 1);
});

test('跳级标题（H2 后直接 H4）仍按层级比较，不会互相吞并', () => {
  const jumped: HeadingBlock[] = [
    { level: 2, block: 0 },
    { level: 4, block: 2 },
    { level: 2, block: 4 },
  ];
  const ranges = headingFoldRanges(jumped, 6);
  assert.deepEqual(ranges, [
    { level: 2, block: 0, end: 4 },
    { level: 4, block: 2, end: 4 },
    { level: 2, block: 4, end: 6 },
  ]);
});

test('空标题列表与末尾空节都安全', () => {
  assert.deepEqual(headingFoldRanges([], 5), []);
  assert.deepEqual(headingFoldRanges([{ level: 2, block: 4 }], 5), [
    { level: 2, block: 4, end: 5 },
  ]);
  assert.equal(foldRangeSize({ level: 2, block: 4, end: 5 }), 0);
});
