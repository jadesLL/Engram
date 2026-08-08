import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOutputSchema, questionOutputSchema } from './ingestModel.js';
import { enforceWriteGate, whitelistFactIds } from './ingestGuards.js';

const base = {
  name: '主题', kind: 'concept' as const, action: 'create' as const, target: '', domain: '',
  confidence: '高' as const, summary: '', factIds: ['f1'], reason: '',
};

test('schemas accept question acceptance criteria and reject malformed compose output', () => {
  const questions = questionOutputSchema.parse({ questions: [{ question: '何时完成？', factIds: ['f1'], acceptance: ['给出日期'] }] });
  assert.deepEqual(questions.questions[0].acceptance, ['给出日期']);
  assert.equal(composeOutputSchema.safeParse({ items: [{ ...base, kind: 'unknown', content: '正文' }] }).success, false);
});

test('fact whitelist deterministically removes unknown ids and forces review', () => {
  const result = whitelistFactIds([{ ...base, factIds: ['f1', 'invented'] }], new Set(['f1']));
  assert.deepEqual(result.items[0].factIds, ['f1']);
  assert.equal(result.items[0].action, 'review');
  assert.deepEqual(result.rejected[0].invalidFactIds, ['invented']);
});

test('write gate reviews low confidence, unsupported, conflicts and missing facts', () => {
  const items = [
    { ...base, name: '低', confidence: '低' as const, content: 'x' },
    { ...base, name: '无依据', content: 'x' },
    { ...base, name: '冲突', content: 'x' },
    { ...base, name: '无事实', factIds: [], content: 'x' },
    { ...base, name: '通过', content: 'x' },
  ];
  const verified = { items: [
    { name: '低', pass: true, unsupported: [], conflicts: [], content: 'x' },
    { name: '无依据', pass: false, unsupported: ['断言'], conflicts: [], content: 'fixed' },
    { name: '冲突', pass: false, unsupported: [], conflicts: ['日期冲突'], content: 'fixed' },
    { name: '无事实', pass: true, unsupported: [], conflicts: [], content: 'x' },
    { name: '通过', pass: true, unsupported: [], conflicts: [], content: 'verified' },
  ] };
  const gated = enforceWriteGate(items, verified, new Set(['f1']));
  assert.deepEqual(gated.map((item) => item.action), ['review', 'review', 'review', 'review', 'create']);
  assert.equal(gated.at(-1)?.content, 'verified');
});
