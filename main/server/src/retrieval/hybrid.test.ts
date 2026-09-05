import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-hybrid-'));
process.env.DATA_DIR = temp;

let db: any;
let mergeSearchResults: typeof import('./hybrid.js').mergeSearchResults;
type SearchHit = import('./hybrid.js').SearchHit;

before(async () => {
  ({ db } = await import('../lib/db.js'));
  ({ mergeSearchResults } = await import('./hybrid.js'));
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function hit(overrides: Partial<SearchHit> & { refId: string; title: string }): SearchHit {
  return {
    refType: 'page',
    path: `Wiki/概念/${overrides.title}.md`,
    heading: '',
    snippet: `${overrides.title} 摘要`,
    score: 1,
    evidence: ['语义'],
    ...overrides,
  };
}

test('merges multi-query results with cross-query RRF ranking', () => {
  const a1 = hit({ refId: 'p1', title: '共同命中' });
  const a2 = hit({ refId: 'p2', title: '仅查询一命中' });
  const b1 = hit({ refId: 'p1', title: '共同命中' });
  const b3 = hit({ refId: 'p3', title: '仅查询二命中' });

  const merged = mergeSearchResults([[a1, a2], [b1, b3]], 10);

  // p1 在两路都排第 1：RRF = 2/(60+1) > 单路的 1/(60+1)，必居首
  assert.equal(merged[0].refId, 'p1');
  assert.equal(merged.length, 3);
  assert.ok(merged[0].score > merged[1].score);
  assert.ok(merged[0].score > merged[2].score);
});

test('merges evidence labels across queries', () => {
  const semantic = hit({ refId: 'p1', title: '语义命中', evidence: ['语义'] });
  const keyword = hit({ refId: 'p1', title: '语义命中', evidence: ['关键词'] });

  const [merged] = mergeSearchResults([[semantic], [keyword]], 5);
  assert.deepEqual([...merged.evidence].sort(), ['关键词', '语义']);
});

test('keeps the richer chunk content when only one query has it', () => {
  const withChunk = hit({
    refId: 'p1',
    title: '同页命中',
    chunkContent: '完整的 chunk 内容',
    heading: '章节A',
  });
  const withoutChunk = hit({ refId: 'p1', title: '同页命中' });

  const [merged] = mergeSearchResults([[withoutChunk], [withChunk]], 5);
  assert.equal(merged.chunkContent, '完整的 chunk 内容');
  assert.equal(merged.heading, '章节A');
});

test('respects the limit after fusion', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    hit({ refId: `p${i}`, title: `页面${i}` }));
  const merged = mergeSearchResults([many], 3);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].refId, 'p0');
});

test('distinguishes page and file hits with the same id', () => {
  const pageHit = hit({ refType: 'page', refId: 'x1', title: '页面X' });
  const fileHit = hit({ refType: 'file', refId: 'x1', title: '文件X' });

  const merged = mergeSearchResults([[pageHit, fileHit]], 10);
  assert.equal(merged.length, 2);
});

test('returns empty for empty inputs', () => {
  assert.deepEqual(mergeSearchResults([], 10), []);
  assert.deepEqual(mergeSearchResults([[], []], 10), []);
});
