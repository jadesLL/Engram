import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshnessProbe } from './freshness.ts';

/**
 * 推送兜底探针：SSE 丢事件/晚到时，侧栏与收集箱角标靠它在一个轮询周期内自愈；
 * 推送正常时必须「零额外刷新」（版本号没变不重读列表）。
 *
 * 全部用假定时器：探针本身按 3 秒轮询，真实定时器会让测试白等（也会掩盖泄漏的定时器）。
 */

function withFakeTimers(t: { after: (fn: () => void) => void }) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('首拍只取基线，不触发刷新', async (t) => {
  withFakeTimers(t);
  let revision = 7;
  let changes = 0;
  const probe = createFreshnessProbe({ fetchRevision: async () => revision, onChanged: () => { changes += 1; } });
  probe.start();
  await flush();
  assert.equal(changes, 0, '刚加载时列表自己会读一次，探针不该再刷');
  await probe.check();
  assert.equal(changes, 0, '版本没变不刷新');
  probe.stop();
});

test('版本号变化才刷新（推送失联时的自愈路径）', async (t) => {
  withFakeTimers(t);
  let revision = 1;
  let changes = 0;
  const probe = createFreshnessProbe({ fetchRevision: async () => revision, onChanged: () => { changes += 1; } });
  probe.start();
  await flush();
  revision = 2;
  await probe.check();
  assert.equal(changes, 1, '内容变了要重读侧栏');
  await probe.check();
  assert.equal(changes, 1, '同一次变化只刷一次');
  probe.stop();
});

test('SSE 已收到带 rev 的事件时，兜底轮询不重复刷新', async (t) => {
  withFakeTimers(t);
  let revision = 3;
  let changes = 0;
  const probe = createFreshnessProbe({ fetchRevision: async () => revision, onChanged: () => { changes += 1; } });
  probe.start();
  await flush();
  revision = 4;
  probe.noteRevision(4); // SSE 的事件（带 rev=4）已经处理过
  await probe.check();
  assert.equal(changes, 0, '事件已经刷新过，不该再打一次列表接口');
  revision = 5; // 下一个事件真丢了
  await probe.check();
  assert.equal(changes, 1);
  // 旧事件晚到（rev 比探针已见的小）：不回退版本号，也不额外刷新
  probe.noteRevision(2);
  revision = 5;
  await probe.check();
  assert.equal(changes, 1);
  probe.stop();
});

test('页面在后台时不发探针请求，回前台再对账', async (t) => {
  withFakeTimers(t);
  let revision = 10;
  let fetches = 0;
  let changes = 0;
  let visible = false;
  const probe = createFreshnessProbe({
    fetchRevision: async () => { fetches += 1; return revision; },
    onChanged: () => { changes += 1; },
    isVisible: () => visible,
    intervalMs: 3000,
  });
  probe.start();
  mock.timers.tick(9000);
  await flush();
  assert.equal(fetches, 0, '后台三个周期都不该打请求');
  visible = true;
  await probe.check();
  assert.equal(fetches, 1, '回前台立即对一次账');
  revision = 11;
  await probe.check();
  assert.equal(changes, 1);
  mock.timers.tick(3000);
  await flush();
  assert.equal(fetches, 3, '前台按周期轮询（回前台一次 + 两次手动 check + 这一拍）');
  probe.stop();
});

test('探针请求失败不建基线；恢复后首次成功只取基线，之后变化才刷新', async (t) => {
  withFakeTimers(t);
  let fail = true;
  let revision = 2;
  let changes = 0;
  let fetches = 0;
  const probe = createFreshnessProbe({
    fetchRevision: async () => { fetches += 1; if (fail) throw new Error('404'); return revision; },
    onChanged: () => { changes += 1; },
  });
  probe.start();
  await flush();
  assert.equal(fetches, 1);
  fail = false;
  await probe.check();
  assert.equal(changes, 0, '失败那拍没有基线，恢复后第一拍只当基线');
  revision = 3;
  await probe.check();
  assert.equal(changes, 1, '之后的真实变化照常刷新');
  probe.stop();
});

test('stop 之后不再轮询、check 也不再发请求', async (t) => {
  withFakeTimers(t);
  let fetches = 0;
  const probe = createFreshnessProbe({ fetchRevision: async () => { fetches += 1; return 1; }, onChanged: () => {} });
  probe.start();
  mock.timers.tick(3000);
  await flush();
  const before = fetches;
  assert.ok(before >= 1);
  probe.stop();
  mock.timers.tick(9000);
  await probe.check();
  assert.equal(fetches, before, '组件卸载后不再有探针请求');
});
