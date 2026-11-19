import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 全局 SSE 事件流必须是「多订阅者共享一条连接」：
 * 2026-11-19 用户报障——打开内置 Agent 抽屉后，抽屉又调了一次 openPageStream，
 * 把 Home 的连接关掉；抽屉只处理 session-changed，page-changed 被吞掉，编辑器再也不刷新。
 * 这里用最小 EventSource 桩锁住这个回归。
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  readyState = FakeEventSource.OPEN;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: { data: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) || []) fn({ data: JSON.stringify(data) });
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
}

(globalThis as any).EventSource = FakeEventSource;

const { openPageStream, closePageStream } = await import('./events.ts');

function latest(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

beforeEach(() => {
  closePageStream();
  FakeEventSource.instances.length = 0;
});

test('多个订阅者共享同一条连接，各自都能收到 page-changed', () => {
  const home: string[] = [];
  const drawer: string[] = [];
  openPageStream((ev) => home.push(ev.type));
  openPageStream((ev) => drawer.push(ev.type));

  assert.equal(FakeEventSource.instances.length, 1, '第二次订阅不得新建连接');
  latest().emit('page-changed', { path: 'Wiki/A.md', id: 'a' });

  assert.deepEqual(home, ['page-changed'], 'Home 的页面事件不能被后订阅的抽屉吞掉');
  assert.deepEqual(drawer, ['page-changed']);
});

test('抽屉注销后 Home 仍能收到事件，最后一个订阅者才关闭连接', () => {
  const home: string[] = [];
  openPageStream((ev) => home.push(ev.type));
  const unsubscribeDrawer = openPageStream(() => {});
  unsubscribeDrawer();

  const es = latest();
  assert.equal(es.closed, false, '还有订阅者时不能关闭连接');
  es.emit('page-changed', { path: 'Wiki/A.md', id: 'a' });
  assert.deepEqual(home, ['page-changed']);

  closePageStream();
  assert.equal(es.closed, true);
});

test('断线重连只通知已连接过之后的重新 open', () => {
  let reconnects = 0;
  openPageStream(() => {}, () => { reconnects += 1; });
  const es = latest();

  es.open(); // 首次连接：不算重连
  assert.equal(reconnects, 0);
  es.open(); // 同一条连接再次 open（EventSource 断线重连）才补对账
  assert.equal(reconnects, 1);
});

test('一个订阅者抛错不影响其他订阅者', () => {
  const got: string[] = [];
  openPageStream(() => { throw new Error('boom'); });
  openPageStream((ev) => got.push(ev.type));

  latest().emit('page-changed', { path: 'Wiki/A.md', id: 'a' });
  assert.deepEqual(got, ['page-changed']);
});
