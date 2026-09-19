import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(process.cwd(), '../web/src/lib/readingPreview.ts'),
).href;

test('reading preview utilities cover preferences, headings and metrics', async () => {
  const {
    clampReadingFontSize,
    DEFAULT_READING_PREFERENCES,
    headingNumbers,
    isDuplicateDocumentTitle,
    parseReadingPreferences,
    READING_FONT_SIZE_MAX,
    READING_FONT_SIZE_MIN,
    readingMetrics,
    requiredReadingTailSpace,
    uniqueHeadingId,
  } = await import(moduleUrl);

  assert.deepEqual(parseReadingPreferences(null), DEFAULT_READING_PREFERENCES);
  assert.deepEqual(parseReadingPreferences('{broken'), DEFAULT_READING_PREFERENCES);
  assert.deepEqual(parseReadingPreferences(JSON.stringify({
    fontSize: 18,
    width: 960,
    lineHeight: 2,
    numberedHeadings: true,
    outline: false,
  })), {
    fontSize: 18,
    width: 960,
    lineHeight: 2,
    numberedHeadings: true,
    outline: false,
  });
  // 字号不再限制为固定档位：任意整数保留，宽度/行距仍回落默认
  assert.deepEqual(parseReadingPreferences(JSON.stringify({
    fontSize: 17,
    width: 1000,
    lineHeight: 1.7,
  })), { ...DEFAULT_READING_PREFERENCES, fontSize: 17 });

  assert.equal(clampReadingFontSize(23), 23);
  assert.equal(clampReadingFontSize(20.6), 21);
  assert.equal(clampReadingFontSize(4), READING_FONT_SIZE_MIN);
  assert.equal(READING_FONT_SIZE_MIN, 8);
  assert.equal(clampReadingFontSize(999), READING_FONT_SIZE_MAX);
  assert.equal(READING_FONT_SIZE_MAX, 48);
  assert.equal(clampReadingFontSize('large'), DEFAULT_READING_PREFERENCES.fontSize);
  assert.equal(clampReadingFontSize(undefined), DEFAULT_READING_PREFERENCES.fontSize);
  assert.equal(clampReadingFontSize(null), DEFAULT_READING_PREFERENCES.fontSize);
  assert.equal(clampReadingFontSize(''), DEFAULT_READING_PREFERENCES.fontSize);
  assert.equal(parseReadingPreferences(JSON.stringify({ fontSize: 27 })).fontSize, 27);
  assert.equal(parseReadingPreferences(JSON.stringify({ fontSize: 999 })).fontSize, 48);

  assert.equal(isDuplicateDocumentTitle('  Engram 阅读模式 ', 'Engram  阅读模式'), true);
  assert.equal(isDuplicateDocumentTitle('阅读模式', '编辑模式'), false);

  assert.deepEqual(headingNumbers([
    { level: 2, text: '概述' },
    { level: 3, text: '背景' },
    { level: 3, text: '目标' },
    { level: 2, text: '实现' },
    { level: 4, text: '降级' },
  ]), ['1.', '1.1.', '1.2.', '2.', '2.1.']);
  assert.deepEqual(headingNumbers([
    { level: 2, text: '1. 概述' },
    { level: 3, text: '背景' },
  ]), ['', '']);

  const used = new Set<string>();
  assert.equal(uniqueHeadingId('公式与关系图', used), '公式与关系图');
  assert.equal(uniqueHeadingId('公式与关系图', used), '公式与关系图-2');
  assert.equal(uniqueHeadingId('API / 网关', used), 'api-网关');

  assert.deepEqual(readingMetrics('知识库 reading mode 2026'), { units: 6, minutes: 1 });
  assert.deepEqual(readingMetrics('知'.repeat(801)), { units: 801, minutes: 3 });

  assert.equal(requiredReadingTailSpace({
    lastHeadingY: 3152,
    anchorOffset: 105,
    scrollHeightWithoutTail: 3681,
    viewportHeight: 720,
  }), 110);
  assert.equal(requiredReadingTailSpace({
    lastHeadingY: 1200,
    anchorOffset: 105,
    scrollHeightWithoutTail: 2200,
    viewportHeight: 720,
  }), 0);
});
