import test from 'node:test';
import assert from 'node:assert/strict';
import { createInflightGuard } from './inflight.ts';

test('批量动作在途时忽略重复触发，结束后能再次执行', async () => {
  const guard = createInflightGuard();
  const runs: string[] = [];
  // 用具名数组存 resolve，而不是 `let release: (() => void) | null`：
  // 后者在 TS 的控制流分析里会被收窄成 null（赋值发生在 Promise 执行器内，分析看不到），
  // 调用点于是报 「Type 'never' has no call signatures」
  const releases: Array<() => void> = [];
  const action = () => new Promise<void>((resolve) => {
    runs.push('start');
    releases.push(resolve);
  });

  const first = guard.run('batch', action);
  assert.equal(guard.busy.value, true, '执行期间 busy 为真（按钮可绑 disabled）');
  const second = await guard.run('batch', action);
  assert.equal(second, false, '同一键在途期间的第二次触发被挡住');
  assert.equal(runs.length, 1, '被挡住的那次没有真的执行');

  releases.shift()?.();
  await first;
  assert.equal(guard.busy.value, false);
  assert.equal(await guard.run('batch', async () => { runs.push('again'); }), true);
  assert.deepEqual(runs, ['start', 'again']);
});

test('不同键互不阻塞：两行的行内动作可以各跑各的', async () => {
  const guard = createInflightGuard();
  const releases: Array<() => void> = [];
  const first = guard.run('p:1', () => new Promise<void>((resolve) => { releases.push(resolve); }));
  assert.equal(guard.isBusy('p:1'), true);
  assert.equal(guard.isBusy('p:2'), false);
  assert.equal(await guard.run('p:2', async () => { /* 另一行 */ }), true);
  assert.equal(await guard.run('p:1', async () => { /* 重复点击同一行 */ }), false);
  releases.shift()?.();
  await first;
  assert.equal(guard.busy.value, false);
});

test('动作抛错也会解锁（不会把按钮永久卡在禁用态）', async () => {
  const guard = createInflightGuard();
  await assert.rejects(() => guard.run('batch', async () => { throw new Error('失败'); }), /失败/);
  assert.equal(guard.busy.value, false);
  assert.equal(guard.isBusy('batch'), false);
});
