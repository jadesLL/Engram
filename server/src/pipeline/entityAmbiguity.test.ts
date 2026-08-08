import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntityName, guardAmbiguousEntityNames } from './entityAmbiguity.js';
import type { Candidate, PlanItem } from './ingestModel.js';

const roster = [
  { id: 'p1', title: '刘子谕', type: 'person', summary: '' },
  { id: 'p2', title: '张一龙', type: 'person', summary: '' },
  { id: 'o1', title: '衡创', type: 'org', summary: '' },
];

test('role titles are classified as incomplete names and suggest matching people', () => {
  const ambiguity = classifyEntityName('刘经理', 'person', roster, '刘经理负责跟进客户');
  assert.equal(ambiguity?.category, 'role_title');
  assert.deepEqual(ambiguity?.suggestions.map((item) => item.title), ['刘子谕']);
  assert.match(ambiguity?.question || '', /完整姓名/);
});

test('one-character person and organization variants are treated as possible typos', () => {
  const org = classifyEntityName('恒创', 'org', roster);
  const person = classifyEntityName('张依龙', 'person', roster);
  assert.equal(org?.category, 'possible_typo');
  assert.equal(org?.suggestions[0].title, '衡创');
  assert.equal(person?.category, 'possible_typo');
  assert.equal(person?.suggestions[0].title, '张一龙');
});

test('unrelated entities pass without an ambiguity finding', () => {
  assert.equal(classifyEntityName('远景科技', 'org', roster), null);
  assert.equal(classifyEntityName('销售方法论', 'concept', roster), null);
});

test('write guard forces ambiguous create items to review and preserves explicit merges', () => {
  const candidate: Candidate = {
    name: '恒创', kind: 'org', domain: '', summary: '客户公司',
    facts: [
      { id: 'f1', statement: '恒创是客户', sources: [{ chunkId: 'c1', quote: '恒创是客户' }] },
      { id: 'f2', statement: '恒创需要跟进', sources: [{ chunkId: 'c1', quote: '恒创需要跟进' }] },
    ],
    relations: [],
  };
  const create: PlanItem = {
    name: '恒创', kind: 'org', action: 'create', target: '', domain: '', confidence: '高',
    summary: '', factIds: ['f1', 'f2'], reason: '',
  };
  const merge: PlanItem = { ...create, action: 'merge', target: '衡创' };
  const invalidMerge: PlanItem = { ...create, action: 'merge', target: '衡創' };
  const guarded = guardAmbiguousEntityNames([create, merge, invalidMerge], [candidate], roster);
  assert.equal(guarded[0].action, 'review');
  assert.equal(guarded[0].ambiguity?.suggestions[0].title, '衡创');
  assert.equal(guarded[1].action, 'merge');
  assert.equal(guarded[1].ambiguity, undefined);
  assert.equal(guarded[2].action, 'review');
  assert.equal(guarded[2].ambiguity?.category, 'possible_typo');
});
