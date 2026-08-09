import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLosslessly } from './losslessChunker.js';
import { sourceExcerpts } from './sourceDocument.js';

test('source excerpts reopen context around original quotes and candidate mentions', () => {
  const text = [
    '# 会议记录',
    '',
    '前置背景信息。'.repeat(80),
    '',
    '泰通焊接产线调试，做整线联动以及数字化展示。',
    '',
    '后续计划是完成现场验收并记录问题。'.repeat(40),
  ].join('\n');
  const document = {
    path: '原始资料/测试.md',
    title: '测试.md',
    contentHash: 'hash',
    text,
    chunks: chunkLosslessly(text, { maxChars: 1200, overlapChars: 100 }),
  };
  const quote = '泰通焊接产线调试，做整线联动以及数字化展示。';
  const excerpts = sourceExcerpts(document, '泰通', [{ quote }], {
    maxExcerptChars: 1400,
  });
  assert.ok(excerpts.length >= 1);
  assert.ok(excerpts.some((excerpt) => excerpt.content.includes(quote)));
  assert.ok(excerpts.some((excerpt) => excerpt.content.includes('后续计划')));
});
