import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  cacheHitPercent,
  cacheHitText,
  formatTokens,
  mergeUsage,
  promptTokens,
  usageDetail,
} from './chatUsage.ts';
import type { ChatUsage } from '../stores/chat';

/** DeepSeek 官方形状的一步：prompt = 命中 9000 + 未命中 1000，输出 500（桶是 disjoint） */
const STEP: ChatUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 9000,
  totalTokens: 10_500,
  steps: 1,
};

test('分母是 prompt tokens（含命中部分），不是 inputTokens', () => {
  assert.equal(promptTokens(STEP), 10_000);
  // 拿 inputTokens 当分母会算成 900%（或反过来 10%）——这里必须是 90%
  assert.equal(cacheHitPercent(STEP), 90);
  assert.equal(cacheHitText(STEP), '90%');
});

test('totalTokens 缺席时退回加法口径（未命中输入 + 缓存读取 + 缓存写入）', () => {
  const usage: ChatUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 8000,
    cacheWriteTokens: 1000,
    steps: 1,
  };
  assert.equal(promptTokens(usage), 10_000);
  assert.equal(cacheHitPercent(usage), 80);
});

test('没报缓存字段（cacheReadTokens 缺省）时整块不显示，而不是显示 0%', () => {
  const usage: ChatUsage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, steps: 1 };
  assert.equal(cacheHitPercent(usage), null);
  assert.equal(cacheHitText(usage), '');
  assert.equal(cacheHitPercent(undefined), null);
  // 分母为 0 也不显示（除零会算出 Infinity）
  assert.equal(cacheHitPercent({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 1 }), null);
});

test('命中率文案：非零但不足 1% 写 <1%', () => {
  const usage: ChatUsage = {
    inputTokens: 99_990,
    outputTokens: 10,
    cacheReadTokens: 10,
    totalTokens: 100_010,
    steps: 1,
  };
  assert.equal(cacheHitText(usage), '<1%');
});

test('会话累计：缓存桶「任一轮报过就保留」，totalTokens 只有每轮都报过才求和', () => {
  const second: ChatUsage = { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 6000, totalTokens: 8400, steps: 2 };
  const merged = mergeUsage([STEP, second]);
  assert.deepEqual(merged, {
    inputTokens: 3000,
    outputTokens: 900,
    cacheReadTokens: 15_000,
    totalTokens: 18_900,
    steps: 3,
  });
  // 两轮合计命中 15000 / (18900 - 900 = 18000)，即 83.3%
  assert.equal(cacheHitPercent(merged), (15_000 / 18_000) * 100);

  // 有一轮没报 totalTokens → 丢掉 totalTokens，退回加法口径，缓存桶照旧保留
  const mixed = mergeUsage([STEP, { inputTokens: 2000, outputTokens: 400, steps: 1 }]);
  assert.equal(mixed?.totalTokens, undefined);
  assert.equal(mixed?.cacheReadTokens, 9000);
  assert.equal(promptTokens(mixed!), 1000 + 9000 + 2000);

  // 全都没用量（老轮次）→ 没有累计结果，界面整块不显示
  assert.equal(mergeUsage([undefined, undefined]), undefined);
});

test('token 短写与明细文案', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(23_456), '23k');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(usageDetail(STEP), '未命中输入 1.0k · 缓存读取 9.0k · 输出 500');
  assert.equal(usageDetail(undefined), '');
});
