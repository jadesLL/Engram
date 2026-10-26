import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 内容版本号（/api/events/state 的数据源）回归：
 *  - 只有会改动知识库内容的事件（页面增删改/移动、资料变更）推进版本号；
 *  - 内容事件的载荷带上 rev，前端收到后据此跳过兜底轮询的重复刷新；
 *  - 非内容事件（会话/看板/设置/提问）不动版本号，也不塞 rev。
 */

// 每个测试文件独立进程：导入后版本号从 0 开始
const { emit, stateRevision, subscribe } = await import('./events.js');

function capture() {
  const events: Array<{ event: string; data: any }> = [];
  const unsubscribe = subscribe({ send: (event: string, data: unknown) => { events.push({ event, data }); }, raw: { write() { return true; } } as any });
  return { events, unsubscribe };
}

test('内容事件推进版本号，并在载荷里带 rev', () => {
  const { events, unsubscribe } = capture();
  const base = stateRevision();
  emit('page-changed', { path: 'Wiki/概念/A.md', id: 'id-a' });
  emit('file-changed', { path: '原始资料/文档/B.pdf' });
  emit('page-moved', { oldPath: 'Wiki/a.md', newPath: 'Wiki/b.md', id: 'id-a' });
  emit('page-deleted', { path: 'Wiki/c.md', id: 'id-c' });
  unsubscribe();

  assert.equal(stateRevision(), base + 4, '四种内容事件各推进一次');
  assert.deepEqual(events.map((e) => e.event), ['page-changed', 'file-changed', 'page-moved', 'page-deleted']);
  assert.equal(events[0].data.rev, base + 1, '事件带当前版本号');
  assert.equal(events[0].data.path, 'Wiki/概念/A.md', '原有字段保持不变');
  assert.equal(events[3].data.rev, base + 4);
});

test('非内容事件不推进版本号、不塞 rev（会话/看板/设置/提问）', () => {
  const { events, unsubscribe } = capture();
  const base = stateRevision();
  emit('session-changed', { sessionId: 's1' });
  emit('board-changed', {});
  emit('settings-changed', { key: 'theme' });
  emit('agent-question', { type: 'agent-question', id: 'q1' });
  unsubscribe();

  assert.equal(stateRevision(), base, '这些事件不动知识库内容版本');
  assert.equal(events.length, 4);
  for (const event of events) assert.equal('rev' in (event.data || {}), false);
});

test('写失败的死连接被剔除，后续事件不再投递', () => {
  let attempts = 0;
  const unsubscribe = subscribe({
    send() { attempts += 1; throw new Error('client gone'); },
    raw: { write() { return true; } } as any,
  });
  emit('file-changed', { path: 'a.txt' });
  emit('file-changed', { path: 'b.txt' });
  unsubscribe();
  assert.equal(attempts, 1, '第一次写失败即剔除，第二次不再尝试');
});
