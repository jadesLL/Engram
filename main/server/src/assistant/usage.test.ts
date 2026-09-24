import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, parseUsage, type UsageDto } from './usage.js';
import { mapChildSessionEvent, mapSessionEvent } from './mapping.js';

test('parseUsage：正常载荷逐字段取，缺省桶不补 0（缺省 = 这条路由没报）', () => {
  assert.deepEqual(parseUsage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000 }), {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 9000,
  });
  // 输入/输出是必需桶，拿不到就整步作废（宁可不显示，也不显示错的）
  assert.equal(parseUsage({ outputTokens: 500 }), undefined);
  assert.equal(parseUsage({ inputTokens: 1000 }), undefined);
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage('1000'), undefined);
  // 异常数值（负 / NaN / 字符串）一律当没上报
  assert.equal(parseUsage({ inputTokens: -1, outputTokens: 0 }), undefined);
  assert.equal(parseUsage({ inputTokens: Number.NaN, outputTokens: 0 }), undefined);
  // 单个桶坏了只丢那个桶，不拖垮整步
  assert.deepEqual(parseUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: '9' }), {
    inputTokens: 10,
    outputTokens: 5,
  });
});

test('addUsage：逐步累加，缓存桶任一步报过就保留（没报过的步按 0）', () => {
  const first = addUsage(undefined, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, totalTokens: 10_500 });
  assert.deepEqual(first, {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 9000,
    totalTokens: 10_500,
    steps: 1,
  });

  // 第二步来自不报缓存的路由：命中量按 0 累加，但键仍保留（第一步报过）
  const second = addUsage(first, { inputTokens: 2000, outputTokens: 400, totalTokens: 2400 });
  assert.deepEqual(second, {
    inputTokens: 3000,
    outputTokens: 900,
    cacheReadTokens: 9000,
    totalTokens: 12_900,
    steps: 2,
  });

  // 反过来的顺序：第一步没报缓存 → 还没有这个键；第二步报了就补上
  const growing = addUsage(addUsage(undefined, { inputTokens: 100, outputTokens: 10 }), {
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 800,
  });
  const expected: UsageDto = { inputTokens: 300, outputTokens: 30, cacheReadTokens: 800, steps: 2 };
  assert.deepEqual(growing, expected);

  // totalTokens 只要有任何一步没报就必须丢掉：部分求和会让分母偏小、命中率虚高
  const partial = addUsage(addUsage(undefined, { inputTokens: 10, outputTokens: 1, totalTokens: 11 }), {
    inputTokens: 20,
    outputTokens: 2,
  });
  assert.equal(partial.totalTokens, undefined);
});

test('映射层：一步的 usage 变成 usage 事件，子会话的变成 subagent-usage', () => {
  const message = {
    message: { content: [{ type: 'text', text: '好了' }] },
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, totalTokens: 10_500 },
  };
  const events = mapSessionEvent('assistant/message', message);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['text', 'usage']
  );
  assert.deepEqual(
    events.find((event) => event.kind === 'usage'),
    { kind: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, totalTokens: 10_500 } }
  );

  // 没有 usage 的老事件：不凭空造一条用量事件
  const plain = mapSessionEvent('assistant/message', { message: { content: [{ type: 'text', text: '嗯' }] } });
  assert.deepEqual(plain.map((event) => event.kind), ['text']);

  // 子代理的用量单独成事件，并带上子会话 id（不混进主对话的命中率）
  const child = mapChildSessionEvent('child-1', 'assistant/message', message);
  assert.deepEqual(child.map((event) => event.kind), ['subagent-text', 'subagent-usage']);
  assert.deepEqual(
    child.find((event) => event.kind === 'subagent-usage'),
    { kind: 'subagent-usage', childSessionId: 'child-1', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, totalTokens: 10_500 } }
  );
});
