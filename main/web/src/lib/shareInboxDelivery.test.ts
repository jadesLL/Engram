import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareInboxDelivery } from './shareInboxDelivery.ts';

test('冷启动和登录前先接收，登录导航完成后打开并刷新收集箱', async () => {
  let ready = false;
  const calls: string[] = [];
  const delivery = createShareInboxDelivery({
    ready: () => ready,
    open: async () => { calls.push('open'); },
    refresh: async () => { calls.push('refresh'); },
  });
  assert.equal(delivery.receive(), true);
  await delivery.flush();
  assert.deepEqual(calls, []);
  ready = true;
  await delivery.flush();
  assert.deepEqual(calls, ['open', 'refresh']);
  await delivery.flush();
  assert.equal(calls.length, 2);
});

test('正在打开收集箱时再次分享仍会刷新新内容', async () => {
  let release!: () => void;
  let opens = 0;
  let refreshes = 0;
  const delivery = createShareInboxDelivery({
    ready: () => true,
    open: async () => { if (++opens === 1) await new Promise<void>((resolve) => { release = resolve; }); },
    refresh: async () => { refreshes++; },
  });
  delivery.receive();
  delivery.receive();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(opens, 2);
  assert.equal(refreshes, 2);
});

test('导航失败保留通知供下一次导航重试', async () => {
  let fail = true;
  let refreshes = 0;
  const delivery = createShareInboxDelivery({
    ready: () => true,
    open: async () => { if (fail) throw new Error('navigation unavailable'); },
    refresh: async () => { refreshes++; },
  });
  delivery.receive();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fail = false;
  await delivery.flush();
  assert.equal(refreshes, 1);
});
