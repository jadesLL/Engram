import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_SIZE_EXPANDED,
  WINDOW_SIZE_MEDIUM,
  WINDOW_SIZE_QUERIES,
  windowSizeClassFor,
  windowSizeClassFromMatches,
} from './windowSizeClass.ts';

test('窗口尺寸等级：compact / medium / expanded 三档边界', () => {
  assert.equal(windowSizeClassFor(320), 'compact');
  assert.equal(windowSizeClassFor(599), 'compact');
  assert.equal(windowSizeClassFor(600), 'medium');
  assert.equal(windowSizeClassFor(839), 'medium');
  assert.equal(windowSizeClassFor(840), 'expanded');
  assert.equal(windowSizeClassFor(1440), 'expanded');
});

test('窗口尺寸等级：媒体查询阈值与常量同源', () => {
  assert.equal(WINDOW_SIZE_MEDIUM, 600);
  assert.equal(WINDOW_SIZE_EXPANDED, 840);
  assert.equal(WINDOW_SIZE_QUERIES.medium, '(min-width: 600px)');
  assert.equal(WINDOW_SIZE_QUERIES.expanded, '(min-width: 840px)');
});

test('窗口尺寸等级：matchMedia 结果映射（展开优先于中等）', () => {
  assert.equal(windowSizeClassFromMatches(false, false), 'compact');
  assert.equal(windowSizeClassFromMatches(true, false), 'medium');
  assert.equal(windowSizeClassFromMatches(true, true), 'expanded');
  assert.equal(windowSizeClassFromMatches(false, true), 'expanded');
});
