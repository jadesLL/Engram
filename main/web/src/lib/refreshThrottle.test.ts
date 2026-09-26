import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottledReload } from './refreshThrottle.ts';

/**
 * 首轮全量对账期间的重读节流：既要「过程中会刷」，也要「不刷爆本地服务」。
 */

function withFakeTimers(t: { after: (fn: () => void) => void }) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
}

test('首次触发立即重读', (t) => {
  withFakeTimers(t);
  let calls = 0;
  const schedule = createThrottledReload(() => { calls += 1; }, 5000);
  schedule();
  assert.equal(calls, 1);
});

test('窗口内的连续触发合并成一次，且不往后顺延', (t) => {
  withFakeTimers(t);
  let calls = 0;
  const schedule = createThrottledReload(() => { calls += 1; }, 5000);
  schedule();
  assert.equal(calls, 1);

  mock.timers.tick(1000);
  schedule(); // 窗口内第一次触发 → 排到第 5 秒
  mock.timers.tick(1000);
  schedule(); // 窗口内再来：合并进同一次，不重排
  schedule();
  assert.equal(calls, 1, '窗口内不该立刻重读');

  mock.timers.tick(2999);
  assert.equal(calls, 1, '还没到 5 秒窗口');
  mock.timers.tick(1);
  assert.equal(calls, 2, '窗口到点补一次');

  mock.timers.tick(4000);
  assert.equal(calls, 2, '补的那次不会再排一次');
});

test('窗口外的触发立即重读，不等定时器', (t) => {
  withFakeTimers(t);
  let calls = 0;
  const schedule = createThrottledReload(() => { calls += 1; }, 5000);
  schedule();
  mock.timers.tick(5000);
  schedule();
  assert.equal(calls, 2);
});

test('同步进行中的稳定节奏：每 5 秒最多一次', (t) => {
  withFakeTimers(t);
  let calls = 0;
  const schedule = createThrottledReload(() => { calls += 1; }, 5000);
  // 模拟状态轮询：每 1 秒触发一次，持续 20 秒
  for (let i = 0; i < 20; i += 1) {
    schedule();
    mock.timers.tick(1000);
  }
  assert.equal(calls, 5, 't=0/5/10/15/20 各一次：稳定的 5 秒节奏');
});
