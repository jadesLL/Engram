// 更新检查节奏的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/update-cadence.test.js
//
// 锁住自适应退避的策略：发现更新立刻回到最短间隔、连续无更新逐级拉长到 1 小时封顶、
// 越界索引收敛到阶梯两端（调用方传脏值也不至于把一个检查定时器设成 NaN 而永不触发）。
const assert = require('node:assert/strict');
const cadence = require('../lib/update-cadence');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('退避阶梯递增且封顶 1 小时', () => {
  assert.deepEqual(cadence.BACKOFF_MS, [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]);
  for (let i = 1; i < cadence.BACKOFF_MS.length; i += 1) {
    assert.ok(cadence.BACKOFF_MS[i] > cadence.BACKOFF_MS[i - 1], `第 ${i} 级没有拉长`);
  }
  assert.equal(cadence.BACKOFF_MS[cadence.BACKOFF_MS.length - 1], 3_600_000);
});

test('连续没发现更新时逐级退避到顶后不再拉长', () => {
  let index = 0;
  const seen = [];
  for (let i = 0; i < 10; i += 1) {
    seen.push(cadence.backoffDelay(index));
    index = cadence.nextBackoffIndex(index, false);
  }
  assert.deepEqual(seen, [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000]);
});

test('发现更新立刻回到最短间隔', () => {
  assert.equal(cadence.nextBackoffIndex(5, true), 0);
  assert.equal(cadence.backoffDelay(cadence.nextBackoffIndex(5, true)), 60_000);
});

test('越界或脏索引收敛到阶梯两端，绝不产生 NaN 定时器', () => {
  assert.equal(cadence.backoffDelay(-3), 60_000);
  assert.equal(cadence.backoffDelay(99), 3_600_000);
  assert.equal(cadence.backoffDelay(Number.NaN), 60_000);
  assert.equal(cadence.backoffDelay(undefined), 60_000);
  assert.equal(cadence.nextBackoffIndex(99, false), cadence.BACKOFF_MS.length - 1);
  assert.equal(cadence.nextBackoffIndex(-5, false), 1);
});

test('启动首查在 5 秒内、补查去抖不超过 30 秒', () => {
  assert.ok(cadence.STARTUP_DELAY_MS > 0 && cadence.STARTUP_DELAY_MS <= 5_000);
  assert.ok(cadence.POKE_DEBOUNCE_MS >= 5_000 && cadence.POKE_DEBOUNCE_MS <= 30_000);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed) process.exit(1);
})();
