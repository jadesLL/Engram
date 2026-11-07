// 自动更新失败暂停的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/update-failure.test.js
//
// 锁住用户 2026-11-08 的要求：某个版本自动更新失败一次后，本版本不再自动重试；
// 版本写法不同（v1.5.9 / 1.5.9）也必须算同一版本；检查请求失败（未知目标版本）不写记录；
// 记录损坏时按「没有记录」处理，不能让脏配置永久停掉自动更新。
const assert = require('node:assert/strict');
const failure = require('../lib/update-failure');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('版本号归一化：v 前缀与后缀不影响比较', () => {
  assert.equal(failure.normalizeVersion('v1.5.9'), '1.5.9');
  assert.equal(failure.normalizeVersion('Engram 1.5.9-beta'), '1.5.9');
  assert.equal(failure.normalizeVersion(''), null);
  assert.equal(failure.normalizeVersion(null), null);
});

test('同版本才暂停自动更新，新版本自动恢复', () => {
  const record = failure.recordFailure(null, 'v1.5.9', '下载失败 HTTP 404');
  assert.equal(record.version, '1.5.9');
  assert.equal(failure.appliesTo(record, '1.5.9'), true);
  assert.equal(failure.appliesTo(record, 'v1.5.9'), true);
  assert.equal(failure.appliesTo(record, '1.6.0'), false);
  assert.equal(failure.appliesTo(record, null), false);
  assert.equal(failure.appliesTo(null, '1.5.9'), false);
});

test('没有目标版本号的检查失败不写记录（网络抖动不能停掉自动更新）', () => {
  assert.equal(failure.recordFailure(null, null, 'fetch failed'), null);
  assert.equal(failure.recordFailure(null, '', 'fetch failed'), null);
});

test('原因截断到上限，空原因不产生 undefined 文案', () => {
  const long = 'x'.repeat(failure.MAX_REASON + 200);
  const record = failure.recordFailure(null, '1.5.9', long);
  assert.equal(record.reason.length, failure.MAX_REASON);
  const empty = failure.recordFailure(null, '1.5.9', '');
  assert.equal(empty.reason, '');
  assert.ok(!failure.describeFailure(empty).includes('undefined'));
});

test('损坏或旧格式记录按没有记录处理', () => {
  assert.equal(failure.normalizeFailure(null), null);
  assert.equal(failure.normalizeFailure('1.5.9'), null);
  assert.equal(failure.normalizeFailure({ reason: 'x' }), null);
  assert.equal(failure.normalizeFailure({ version: 'abc' }), null);
  const clean = failure.normalizeFailure({ version: '1.5.9', at: 'bad', reason: 42 });
  assert.equal(clean.version, '1.5.9');
  assert.equal(clean.at, 0);
  assert.equal(clean.reason, '42');
  assert.equal(failure.appliesTo({ version: '1.5.9', reason: '' }, '1.5.9'), true);
});

test('提示文案包含版本号与原因，并说明可在设置里手动更新', () => {
  const record = failure.recordFailure(null, '1.5.9', 'sha256 不一致');
  const text = failure.describeFailure(record);
  assert.ok(text.includes('v1.5.9'));
  assert.ok(text.includes('sha256 不一致'));
  assert.ok(text.includes('设置'));
  assert.ok(text.includes('不会再自动重试'));
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
