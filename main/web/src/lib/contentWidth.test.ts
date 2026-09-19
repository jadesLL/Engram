import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_WIDTH_RATIO_MAX,
  CONTENT_WIDTH_RATIO_MIN,
  CONTENT_WIDTH_RATIO_STEPS,
  DEFAULT_CONTENT_WIDTH_RATIO,
  clampContentWidthRatio,
  contentColumnWidth,
  formatContentWidthRatio,
} from './contentWidth.ts';

test('默认列宽比例是 70%', () => {
  assert.equal(DEFAULT_CONTENT_WIDTH_RATIO, 0.7);
  assert.equal(formatContentWidthRatio(DEFAULT_CONTENT_WIDTH_RATIO), '70%');
});

test('clampContentWidthRatio 收敛到 40%–100% 并按 1% 归整', () => {
  assert.equal(clampContentWidthRatio(0.7), 0.7);
  assert.equal(clampContentWidthRatio(0.1), CONTENT_WIDTH_RATIO_MIN);
  assert.equal(clampContentWidthRatio(2), CONTENT_WIDTH_RATIO_MAX);
  assert.equal(clampContentWidthRatio(0.734), 0.73);
  assert.equal(clampContentWidthRatio(0.735), 0.74);
});

test('clampContentWidthRatio 对缺失与非法值回落到默认 70%', () => {
  for (const bad of [null, undefined, '', Number.NaN, 'abc', {}]) {
    assert.equal(clampContentWidthRatio(bad), DEFAULT_CONTENT_WIDTH_RATIO, `输入 ${String(bad)}`);
  }
  // 数字字符串是合法来源（localStorage / 表单）
  assert.equal(clampContentWidthRatio('0.55'), 0.55);
});

test('档位都落在合法区间内且含默认档', () => {
  for (const step of CONTENT_WIDTH_RATIO_STEPS) {
    assert.equal(clampContentWidthRatio(step), step);
  }
  assert.ok(CONTENT_WIDTH_RATIO_STEPS.includes(DEFAULT_CONTENT_WIDTH_RATIO as 0.7));
});

test('contentColumnWidth 按可用区换算，可用区非法时返回 0', () => {
  assert.equal(contentColumnWidth(0.7, 1000), 700);
  assert.equal(contentColumnWidth(1, 1000), 1000);
  assert.equal(contentColumnWidth(0.5, 833), 417);
  assert.equal(contentColumnWidth(0.7, 0), 0);
  assert.equal(contentColumnWidth(0.7, -100), 0);
  assert.equal(contentColumnWidth(0.7, Number.NaN), 0);
});
