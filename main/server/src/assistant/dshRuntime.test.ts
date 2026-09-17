import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapSessionEvent, mapNotification } from './mapping.js';
import { buildTask } from './prompts.js';

/**
 * 事件映射是「dsh 事件 → 界面动作」的唯一翻译层，且字段形状来自 dsh 自身
 * 的 SessionEventMap（helper 不是稳定 API），所以这里按真实字段逐类钉住。
 */

test('assistant/message：抽出正文文本块', () => {
  const events = mapSessionEvent('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '总结如下' }, { type: 'toolCall', callId: 'c1' }] },
  });
  assert.deepEqual(events, [{ kind: 'text', text: '总结如下' }]);
});

test('assistant/message：中断标记随事件带出', () => {
  const events = mapSessionEvent('assistant/message', {
    message: { content: [{ type: 'text', text: '被截断' }] },
    interrupted: true,
  });
  assert.deepEqual(events, [{ kind: 'text', text: '被截断', interrupted: true }]);
});

test('assistant/message：只有推理块时不产出正文', () => {
  const events = mapSessionEvent('assistant/message', {
    message: { content: [{ type: 'reasoning', text: '想一下' }] },
  });
  assert.deepEqual(events, []);
});

test('tool/call：名称与原始参数字符串进工具卡', () => {
  const events = mapSessionEvent('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'mcp__engram__search',
    arguments: '{"query":"同步"}',
  });
  assert.deepEqual(events, [{
    kind: 'tool-call',
    callId: 'call-1',
    name: 'mcp__engram__search',
    args: '{"query":"同步"}',
  }]);
});

test('tool/result：isError 决定成败，文本来自内容块', () => {
  const ok = mapSessionEvent('tool/result', {
    message: { toolCallId: 'call-1', content: [{ type: 'text', text: '3 条结果' }] },
  });
  assert.deepEqual(ok, [{ kind: 'tool-result', callId: 'call-1', ok: true, text: '3 条结果' }]);

  const bad = mapSessionEvent('tool/result', {
    message: { toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: '权限不足' }] },
    error: { name: 'ToolError', code: 'denied' },
  });
  assert.deepEqual(bad, [{ kind: 'tool-result', callId: 'call-2', ok: false, text: '权限不足' }]);
});

test('step/start 与 turn/end：只做进度与收口', () => {
  assert.deepEqual(mapSessionEvent('step/start', { turn: 1, step: 2 }), [{ kind: 'status', text: '第 2 步' }]);
  assert.deepEqual(mapSessionEvent('turn/end', { turn: 1, reason: 'completed' }), [{ kind: 'turn-end', reason: 'completed' }]);
  // reason 实际是结构化对象（kind 标注结束原因），要落成一行可读文本
  assert.deepEqual(
    mapSessionEvent('turn/end', { turn: 1, reason: { kind: 'error', detail: 'x' } }),
    [{ kind: 'turn-end', reason: 'error' }]
  );
});

test('未知事件类型被忽略（dsh 插件可扩展事件表）', () => {
  assert.deepEqual(mapSessionEvent('compaction/summary', { text: 'x' }), []);
  assert.deepEqual(mapSessionEvent('assistant/message', { message: undefined }), []);
});

test('mapNotification：按根会话过滤，子 Agent 事件不透传', () => {
  const root = 'session-root';
  const mapped = mapNotification('session.event', {
    sessionId: root,
    event: { type: 'step/start', data: { turn: 1, step: 1 } },
  }, root);
  assert.deepEqual(mapped, [{ kind: 'status', text: '第 1 步' }]);

  const child = mapNotification('session.event', {
    sessionId: 'session-child',
    event: { type: 'step/start', data: { turn: 1, step: 1 } },
  }, root);
  assert.deepEqual(child, []);

  assert.deepEqual(mapNotification('session.status', { sessionId: root, status: 'running' }, root), [
    { kind: 'status', text: '处理中' },
  ]);
  assert.deepEqual(mapNotification('session.status', { sessionId: root, status: 'idle' }, root), []);
});

test('buildTask：约定与用户消息同时在场，界面上下文按不可信标注', () => {
  const bare = buildTask('列出待提炼的文件');
  assert.match(bare, /mcp__engram__/);
  assert.match(bare, /列出待提炼的文件$/);

  const withContext = buildTask('总结这页', {
    currentPage: { id: 'p1', title: '同步设计' },
    currentFile: { path: '原始资料/a.md' },
    selection: '  选中内容  ',
  });
  assert.match(withContext, /当前页面：《同步设计》（id=p1）/);
  assert.match(withContext, /当前文件：原始资料\/a\.md/);
  assert.match(withContext, /选中内容/);
  assert.match(withContext, /不可信输入/);
  assert.ok(withContext.endsWith('总结这页'));
});
