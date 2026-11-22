import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_WIDTH_RATIO_MAX,
  CONTENT_WIDTH_RATIO_MIN,
  CONTENT_WIDTH_RATIO_STEPS,
  DEFAULT_CONTENT_WIDTH_RATIO,
  READING_ARTICLE_MIN_WIDTH,
  READING_OUTLINE_RAIL_MIN_WIDTH,
  clampContentWidthRatio,
  contentColumnWidth,
  formatContentWidthRatio,
  readingColumnWidth,
  readingTitleSize,
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

test('阅读正文列有 460px 下限：容器不够时取满，够宽才按偏好收窄', () => {
  assert.equal(READING_ARTICLE_MIN_WIDTH, 460);
  // 318px 主列：70% 只有 223px，必须取满，否则标题一行放不下几个字
  assert.equal(readingColumnWidth(0.7, 318), 318);
  // 460px 主列：70% 的 322px 与下限取大后再和主列取小，仍是取满
  assert.equal(readingColumnWidth(0.7, 460), 460);
  // 657px 主列：70% = 460px，正好踩到下限
  assert.equal(readingColumnWidth(0.7, 657), 460);
  // 756px 主列：70% = 529px，高于下限后按偏好收窄
  assert.equal(readingColumnWidth(0.7, 756), 529);
  // 100% 偏好始终取满
  assert.equal(readingColumnWidth(1, 900), 900);
  // 可用区非法时与 contentColumnWidth 同样回落 0
  assert.equal(readingColumnWidth(0.7, 0), 0);
  assert.equal(readingColumnWidth(0.7, Number.NaN), 0);
});

test('阅读目录列阈值是 700px：正文下限 + 220px 目录 + 栅格留白', () => {
  assert.equal(READING_OUTLINE_RAIL_MIN_WIDTH, 700);
});

test('文档标题字号跟正文列收敛在 22–38px，改窄不会把标题挤成竖排', () => {
  assert.equal(readingTitleSize(1000), 38);
  assert.equal(readingTitleSize(500), 38);
  assert.equal(readingTitleSize(460), 35);
  assert.equal(readingTitleSize(318), 24);
  assert.equal(readingTitleSize(240), 22);
  assert.equal(readingTitleSize(120), 22);
  // 量不到列宽时回落到桌面最大值，等首帧量到再收敛
  assert.equal(readingTitleSize(0), 38);
  assert.equal(readingTitleSize(Number.NaN), 38);
});
