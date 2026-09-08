import test from 'node:test';
import assert from 'node:assert/strict';
import { RELATION_WORDS, extractTypedRelations } from './extractor.js';

test('词表关系抽取：通用新词与存量旧词都可抽取，词表外不误抽', () => {
  const md = [
    '# 页面',
    '',
    '[[Engram]]::属于::[[知识库]]',
    '[[仓库]]::位于::[[园区]]',
    '[[张三]]::主责::[[项目甲]]',
    '[[李四]]::带教::[[王五]]',
    '[[A]]::讨厌::[[B]]',
  ].join('\n');

  const rels = extractTypedRelations(md);
  const rel = (r: { src: string; rel: string; dst: string }) => `${r.src}:${r.rel}:${r.dst}`;

  assert.ok(rels.some((r) => rel(r) === 'Engram:属于:知识库'), '通用词 属于 应可抽取');
  assert.ok(rels.some((r) => rel(r) === '仓库:位于:园区'), '通用词 位于 应可抽取');
  assert.ok(rels.some((r) => rel(r) === '张三:主责:项目甲'), '存量旧词 主责 应继续可抽取（兼容）');
  assert.ok(rels.some((r) => rel(r) === '李四:带教:王五'), '存量旧词 带教 应继续可抽取（兼容）');
  assert.ok(!rels.some((r) => r.rel === '讨厌'), '词表外关系词不得抽取');
  assert.ok(RELATION_WORDS.includes('属于' as any), '词表必须包含通用词');
  assert.ok(RELATION_WORDS.includes('主责' as any), '词表必须保留旧词');
});
