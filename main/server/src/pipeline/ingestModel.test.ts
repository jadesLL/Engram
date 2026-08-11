import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOutputSchema } from './ingestModel.js';

const goodFact = (id: string) => ({ id, statement: `${id} 陈述`, sources: [{ chunkId: 'c1', quote: '原文片段' }] });
const goodCandidate = (name: string, facts = 1) => ({
  name, kind: 'concept' as const, domain: '', summary: '',
  facts: Array.from({ length: facts }, (_, i) => goodFact(`${name}-f${i}`)),
});

test('map schema preserves candidates within the bounded map batch', () => {
  const candidates = Array.from({ length: 15 }, (_, i) => goodCandidate(`候选${i}`));
  const out = mapOutputSchema.parse({ candidates });
  assert.equal(out.candidates.length, 15);
  assert.equal(out.candidates[0].name, '候选0');
  assert.equal(out.candidates[14].name, '候选14');
});

test('map schema rejects an oversized batch instead of truncating it', () => {
  const candidates = Array.from({ length: 17 }, (_, i) => goodCandidate(`候选${i}`));
  assert.equal(mapOutputSchema.safeParse({ candidates }).success, false);
});

test('map schema drops malformed facts (missing id/statement/sources) instead of failing', () => {
  const candidates = [
    goodCandidate('好候选', 2),
    {
      name: '坏候选', kind: 'concept',
      facts: [
        { id: '', statement: 'x', sources: [{ chunkId: 'c1', quote: 'q' }] }, // 空 id
        { id: 'f', statement: '', sources: [{ chunkId: 'c1', quote: 'q' }] }, // 空 statement
        { id: 'f', statement: 'x' }, // 缺 sources
        { id: 'f', statement: 'x', sources: [{ chunkId: '', quote: 'q' }] }, // source 缺 chunkId
        { id: 'f', statement: 'x', sources: [] }, // 空 sources
      ],
    },
  ];
  const out = mapOutputSchema.parse({ candidates });
  assert.equal(out.candidates.length, 2);
  assert.equal(out.candidates[0].name, '好候选');
  assert.equal(out.candidates[0].facts.length, 2);
  // 坏候选所有 fact 均被丢弃 -> facts 为空（由下游 validateFacts 进一步过滤）
  assert.equal(out.candidates[1].name, '坏候选');
  assert.equal(out.candidates[1].facts.length, 0);
});

test('map schema accepts non-array candidates by falling back to empty', () => {
  const out = mapOutputSchema.parse({ candidates: 'oops' });
  assert.deepEqual(out.candidates, []);
});
