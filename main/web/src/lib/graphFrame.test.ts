import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphFrame } from './graphFrame.ts';

function clock() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    request: (cb: FrameRequestCallback) => { callbacks.set(++id, cb); return id; },
    cancel: (key: number) => { callbacks.delete(key); },
    step() { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach((cb) => cb(0)); },
    pending: () => callbacks.size,
  };
}

test('pointer bursts paint only the latest position once per frame', () => {
  const time = clock();
  let position = 0;
  const painted: number[] = [];
  const frame = createGraphFrame(() => painted.push(position), time.request, time.cancel);
  for (let i = 1; i <= 500; i++) { position = i; frame.schedule(); }
  assert.equal(time.pending(), 1);
  assert.deepEqual(painted, []);
  time.step();
  assert.deepEqual(painted, [500]);
  position = 501; frame.schedule(); time.step();
  assert.deepEqual(painted, [500, 501]);
});

test('label requests survive later pointer events and clear after paint', () => {
  const time = clock();
  const plans: boolean[] = [];
  const frame = createGraphFrame((labels) => plans.push(labels), time.request, time.cancel);
  frame.schedule(true);
  frame.schedule();
  time.step();
  frame.schedule(); time.step();
  assert.deepEqual(plans, [true, false]);
});

test('unmount cancels pending work and a paint may schedule the next frame', () => {
  const time = clock();
  let paints = 0;
  const frame = createGraphFrame(() => { if (++paints === 1) frame.schedule(); }, time.request, time.cancel);
  frame.schedule(true); frame.cancel(); time.step();
  assert.equal(paints, 0);
  frame.schedule(); time.step();
  assert.equal(time.pending(), 1);
  time.step();
  assert.equal(paints, 2);
});
