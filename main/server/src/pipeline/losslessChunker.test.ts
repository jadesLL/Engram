import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLosslessly, assertLosslessChunks } from './losslessChunker.js';

function coveredText(text: string, chunks: ReturnType<typeof chunkLosslessly>): string {
  let cursor = 0;
  let result = '';
  for (const chunk of chunks) {
    if (chunk.end <= cursor) continue;
    const start = Math.max(cursor, chunk.start);
    result += chunk.content.slice(start - chunk.start);
    cursor = chunk.end;
  }
  return result;
}

test('lossless chunker covers long input without gaps or changes', () => {
  const text = `${'# 标题\n\n段落。'.repeat(300)}尾部`;
  const chunks = chunkLosslessly(text, { maxChars: 1000, overlapChars: 100 });
  assert.ok(chunks.length > 1);
  assert.doesNotThrow(() => assertLosslessChunks(text, chunks));
  assert.equal(coveredText(text, chunks), text);
});

test('lossless chunker handles empty input', () => {
  assert.deepEqual(chunkLosslessly(''), []);
  assert.doesNotThrow(() => assertLosslessChunks('', []));
});
