import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOutputSchema, questionOutputSchema } from './ingestModel.js';
import { enforceWriteGate, whitelistFactIds } from './ingestGuards.js';

const base = {
  candidateId: 'candidate-base',
  name: '主题', kind: 'concept' as const, action: 'create' as const, target: '', domain: '',
  confidence: '高' as const, summary: '', factIds: ['f1'], relations: [], reason: '',
};

test('schemas accept question acceptance criteria and reject malformed compose output', () => {
  const questions = questionOutputSchema.parse({ questions: [{ question: '何时完成？', factIds: ['f1'], acceptance: ['给出日期'] }] });
  assert.deepEqual(questions.questions[0].acceptance, ['给出日期']);
  assert.equal(composeOutputSchema.safeParse({ items: [{ ...base, kind: 'unknown', content: '正文' }] }).success, false);
});

test('fact whitelist drops invalid ids but keeps items that still have valid facts', () => {
  const result = whitelistFactIds([{ ...base, factIds: ['f1', 'invented'] }], new Set(['f1']));
  assert.deepEqual(result.items[0].factIds, ['f1']);
  assert.equal(result.items[0].action, 'create');
  assert.deepEqual(result.rejected[0].invalidFactIds, ['invented']);
  assert.match(result.items[0].reason, /已忽略/);

  // 裁剪后无任何有效事实才转 review
  const empty = whitelistFactIds([{ ...base, factIds: ['invented'] }], new Set(['f1']));
  assert.equal(empty.items[0].action, 'review');
  assert.deepEqual(empty.items[0].factIds, []);
});

test('write gate reviews conflicts and missing facts, unsupported content is cleaned and kept', () => {
  const items = [
    { ...base, candidateId: 'low', name: '低', confidence: '低' as const, content: 'x' },
    { ...base, candidateId: 'unsupported', name: '无依据', content: 'x' },
    { ...base, candidateId: 'conflict', name: '冲突', content: 'x' },
    { ...base, candidateId: 'empty', name: '无事实', factIds: [], content: 'x' },
    { ...base, candidateId: 'pass', name: '通过', content: 'x' },
  ];
  const verified = { items: [
    { candidateId: 'low', name: '低', pass: true, unsupported: [], conflicts: [], content: 'x' },
    { candidateId: 'unsupported', name: '无依据', pass: false, unsupported: ['断言'], conflicts: [], content: 'fixed' },
    { candidateId: 'conflict', name: '冲突', pass: false, unsupported: [], conflicts: ['日期冲突'], content: 'fixed' },
    { candidateId: 'empty', name: '无事实', pass: true, unsupported: [], conflicts: [], content: 'x' },
    { candidateId: 'pass', name: '通过', pass: true, unsupported: [], conflicts: [], content: 'verified' },
  ] };
  const gated = enforceWriteGate(items, verified, new Set(['f1']));
  // 已验证低置信度通过；unsupported 用清理后正文入库不再 review；仅冲突/无事实转 review
  assert.deepEqual(gated.map((item) => item.action), ['create', 'create', 'review', 'review', 'create']);
  assert.equal(gated[1].content, 'fixed');
  assert.deepEqual(gated[1].unsupportedSections, ['断言']);
  assert.equal(gated.at(-1)?.content, 'verified');
});
