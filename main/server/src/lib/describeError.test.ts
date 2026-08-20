import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from './describeError.js';

test('describeError 展开嵌套 cause 链（fetch failed → DNS 失败）', () => {
  const root = new Error('getaddrinfo ENOTFOUND gitea.example.com');
  const outer = new Error('fetch failed');
  (outer as Error & { cause?: unknown }).cause = root;
  assert.equal(describeError(outer), 'fetch failed ← getaddrinfo ENOTFOUND gitea.example.com');
});

test('describeError 展开 AggregateError 的多路尝试错误', () => {
  const agg = new AggregateError(
    [new Error('connect ENETUNREACH 2408::1:11111'), new Error('connect ECONNREFUSED 192.168.1.102:443')],
    'All sockets failed',
  );
  const outer = new TypeError('fetch failed');
  (outer as Error & { cause?: unknown }).cause = agg;
  const text = describeError(outer);
  assert.ok(text.startsWith('fetch failed ← All sockets failed'));
  assert.ok(text.includes('ENETUNREACH'));
  assert.ok(text.includes('ECONNREFUSED'));
});

test('describeError 处理普通对象 cause（code/address/port）', () => {
  const outer = new Error('fetch failed');
  (outer as Error & { cause?: unknown }).cause = { code: 'ENOTFOUND', address: 'gitea.example.com' };
  assert.equal(describeError(outer), 'fetch failed ← ENOTFOUND gitea.example.com');
});

test('describeError 去重重复消息并防 cause 环', () => {
  const a = new Error('same');
  const b = new Error('same');
  (a as Error & { cause?: unknown }).cause = b;
  (b as Error & { cause?: unknown }).cause = a;
  assert.equal(describeError(a), 'same');
});

test('describeError 非错误输入回退 String()', () => {
  assert.equal(describeError('boom'), 'boom');
  assert.equal(describeError(undefined), 'undefined');
});

test('describeError 超长链截断', () => {
  const outer = new Error('fetch failed');
  (outer as Error & { cause?: unknown }).cause = new Error('x'.repeat(600));
  const text = describeError(outer);
  assert.ok(text.length <= 401 + '…'.length);
  assert.ok(text.endsWith('…'));
});
