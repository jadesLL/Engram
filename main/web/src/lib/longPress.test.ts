import test from 'node:test';
import assert from 'node:assert/strict';
import { createLongPress } from './longPress.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('长按 500ms 触发一次，松手后的 click 被吞掉', async () => {
  let fired = 0;
  const press = createLongPress({ delayMs: 20, onLongPress: () => { fired += 1; } });
  press.start({ clientX: 10, clientY: 10, pointerType: 'touch', button: 0 });
  await sleep(45);
  assert.equal(fired, 1, '长按没有在阈值后触发');
  assert.equal(press.consumeClick(), true, '长按后的松手 click 没有标记为消费');
  assert.equal(press.consumeClick(), false, '一次长按只能吞掉一次 click');
  press.end();
});

test('鼠标指针不触发（桌面右键/拖拽完全不受影响）', async () => {
  let fired = 0;
  const press = createLongPress({ delayMs: 10, onLongPress: () => { fired += 1; } });
  press.start({ clientX: 10, clientY: 10, pointerType: 'mouse', button: 0 });
  await sleep(30);
  assert.equal(fired, 0, '鼠标按下也触发了长按：桌面拖拽/右键会被抢');
  assert.equal(press.consumeClick(), false);
});

test('手指移动超过容差视为滚动，取消长按', async () => {
  let fired = 0;
  const press = createLongPress({ delayMs: 20, onLongPress: () => { fired += 1; } });
  press.start({ clientX: 10, clientY: 10, pointerType: 'touch', button: 0 });
  press.move({ clientX: 40, clientY: 12 });
  await sleep(45);
  assert.equal(fired, 0, '列表滚动时仍触发了长按：滑动会误进多选');
});

test('松手/指针离开会清掉未触发的长按', async () => {
  let fired = 0;
  const press = createLongPress({ delayMs: 20, onLongPress: () => { fired += 1; } });
  press.start({ clientX: 10, clientY: 10, pointerType: 'touch', button: 0 });
  press.end();
  await sleep(45);
  assert.equal(fired, 0, '松手后长按计时器没有取消');
});
