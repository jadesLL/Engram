import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_CHECK_BACKOFF_MS,
  UPDATE_CHECK_POKE_DEBOUNCE_MS,
  UPDATE_CHECK_STARTUP_MS,
  backoffDelay,
  nextBackoffIndex,
} from './updateCadence.ts';

test('退避阶梯递增且封顶 1 小时', () => {
  assert.deepEqual(UPDATE_CHECK_BACKOFF_MS, [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]);
  for (let i = 1; i < UPDATE_CHECK_BACKOFF_MS.length; i += 1) {
    assert.ok(UPDATE_CHECK_BACKOFF_MS[i] > UPDATE_CHECK_BACKOFF_MS[i - 1], `第 ${i} 级没有拉长`);
  }
  assert.equal(UPDATE_CHECK_BACKOFF_MS[UPDATE_CHECK_BACKOFF_MS.length - 1], 3_600_000);
});

test('连续没发现更新时逐级退避到顶后不再拉长', () => {
  let index = 0;
  const seen: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    seen.push(backoffDelay(index));
    index = nextBackoffIndex(index, false);
  }
  assert.deepEqual(seen, [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000]);
});

test('发现更新立刻回到最短间隔', () => {
  assert.equal(nextBackoffIndex(5, true), 0);
  assert.equal(backoffDelay(nextBackoffIndex(5, true)), 60_000);
});

test('越界或脏索引收敛到阶梯两端，绝不产生 NaN 定时器', () => {
  assert.equal(backoffDelay(-3), 60_000);
  assert.equal(backoffDelay(99), 3_600_000);
  assert.equal(backoffDelay(Number.NaN), 60_000);
  assert.equal(backoffDelay(undefined as unknown as number), 60_000);
  assert.equal(nextBackoffIndex(99, false), UPDATE_CHECK_BACKOFF_MS.length - 1);
  assert.equal(nextBackoffIndex(-5, false), 1);
});

test('启动首查在 5 秒内、补查去抖不超过 30 秒', () => {
  assert.ok(UPDATE_CHECK_STARTUP_MS > 0 && UPDATE_CHECK_STARTUP_MS <= 5_000);
  assert.ok(UPDATE_CHECK_POKE_DEBOUNCE_MS >= 5_000 && UPDATE_CHECK_POKE_DEBOUNCE_MS <= 30_000);
});
