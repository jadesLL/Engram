import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDSHAKE_RETRIES,
  INITIALIZE_TIMEOUT_MS,
  startWithRetry,
  type Startable,
} from './handshake.js';

/**
 * 握手策略是这次「升级后第一次用内置 Agent 报 initialize timed out」的修复本体：
 * 超时预算必须比 SDK 的 10s 宽，且首次握手失败要能自动重试成功。
 */

/** 前 failTimes 次 start() 抛错、之后成功；记录调用次数与每次重试的等待值 */
function fakeHarness(failTimes: number): { target: Startable; calls: () => number } {
  let calls = 0;
  return {
    target: {
      async start() {
        calls += 1;
        if (calls <= failTimes) throw new Error(`handshake failed #${calls}`);
      },
    },
    calls: () => calls,
  };
}

test('握手预算比 SDK 默认的 10s 宽，且默认带重试', () => {
  assert.ok(
    INITIALIZE_TIMEOUT_MS > 10_000,
    `冷启动要留出余量，当前预算 ${INITIALIZE_TIMEOUT_MS}ms 仍不比 SDK 默认宽`
  );
  assert.ok(HANDSHAKE_RETRIES >= 1, '首次握手失败必须有一次自动重试');
});

test('首次握手成功：只调一次，不等待', async () => {
  const harness = fakeHarness(0);
  const sleeps: number[] = [];
  await startWithRetry(harness.target, { sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(harness.calls(), 1);
  assert.deepEqual(sleeps, []);
});

test('首次握手失败后自动重试成功（升级后冷启动的实际形态）', async () => {
  const harness = fakeHarness(1);
  const sleeps: number[] = [];
  await startWithRetry(harness.target, { delayMs: 5, sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(harness.calls(), 2);
  assert.deepEqual(sleeps, [5]);
});

test('重试耗尽后抛出最后一次错误，不吞掉原因', async () => {
  const harness = fakeHarness(5);
  const sleeps: number[] = [];
  await assert.rejects(
    () => startWithRetry(harness.target, { retries: 2, delayMs: 5, sleep: async (ms) => void sleeps.push(ms) }),
    /handshake failed #3/
  );
  assert.equal(harness.calls(), 3);
  assert.deepEqual(sleeps, [5, 5]);
});

test('retries=0 可关掉重试（调用方显式选择）', async () => {
  const harness = fakeHarness(1);
  await assert.rejects(() => startWithRetry(harness.target, { retries: 0 }), /handshake failed #1/);
  assert.equal(harness.calls(), 1);
});
