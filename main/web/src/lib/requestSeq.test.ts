import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestSeq } from './requestSeq.ts';

test('只认最新一次：先发的响应在更新请求之后一律作废', () => {
  const seq = createRequestSeq();
  const first = seq.next();
  const second = seq.next();
  assert.equal(seq.isCurrent(second), true);
  assert.equal(seq.isCurrent(first), false, '旧的响应不该覆盖新一次请求');
});

test('bump 作废在途请求，但不影响之后的新请求', () => {
  const seq = createRequestSeq();
  const inflight = seq.next();
  seq.bump();
  assert.equal(seq.isCurrent(inflight), false, '离开页面后到达的响应要作废');
  const next = seq.next();
  assert.equal(seq.isCurrent(next), true);
  assert.equal(seq.isCurrent(inflight), false);
});

test('同一次请求重复判断结果稳定', () => {
  const seq = createRequestSeq();
  const one = seq.next();
  assert.equal(seq.isCurrent(one), true);
  assert.equal(seq.isCurrent(one), true);
  assert.equal(seq.isCurrent(one + 1), false, '未来序号不算当前');
});
