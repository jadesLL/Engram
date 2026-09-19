import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  buildChatTimeline,
  reasoningDurationMs,
  showStreamName,
  startsNewRun,
  toolCallSummary,
} from './chatTimeline.ts';
import type { ChatMessage, ChatRun, ChatSubagent, ChatToolCall } from '../stores/chat';
import type { ChatStreamItem } from './chatTimeline.ts';

/** 用最少字段造一条消息 / 一张工具卡 / 一轮运行 / 一张子代理卡 */
function message(id: string, role: 'user' | 'assistant', at: string, runId?: string): ChatMessage {
  return { id, sessionId: 's1', ...(runId ? { runId } : {}), role, content: id, metadata: {}, createdAt: at };
}

/** 子代理卡：默认是最小可用形状，测试只覆盖关心到的字段 */
function subagent(
  id: string,
  at: string,
  runId: string,
  extra: Partial<ChatSubagent> = {}
): ChatSubagent {
  return {
    id,
    runId,
    parentSessionId: 'session-root',
    childSessionId: `child-${id}`,
    label: id,
    mode: 'one-shot',
    provider: 'spawn',
    prompt: '',
    status: 'running',
    stopReason: '',
    result: '',
    activity: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

/** 思考段：服务端按 metadata.kind='reasoning' 落库 */
function thinking(id: string, at: string, runId: string, ms?: number): ChatMessage {
  return {
    id,
    sessionId: 's1',
    runId,
    role: 'assistant',
    content: id,
    metadata: { kind: 'reasoning', ...(ms ? { ms } : {}) },
    createdAt: at,
  };
}

function call(id: string, at: string, runId: string): ChatToolCall {
  return { id, runId, name: 'mcp__engram__search', args: '{}', status: 'completed', ok: true, text: '', createdAt: at };
}

function run(id: string, at: string): ChatRun {
  return { id, sessionId: 's1', status: 'completed', createdAt: at };
}

/** 取出流里的思考段消息（类型收窄，便于断言） */
function reasoningMessages(items: ChatStreamItem[]): ChatMessage[] {
  return items
    .filter((item): item is Extract<ChatStreamItem, { kind: 'reasoning' }> => item.kind === 'reasoning')
    .map((item) => item.message);
}

test('工具卡插在它发生的那两步之间（按步分段的正文不被打乱）', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    message('a1', 'assistant', '2026-01-01T00:00:01.000Z', 'r1'),
    message('a2', 'assistant', '2026-01-01T00:00:03.000Z', 'r1'),
    message('a3', 'assistant', '2026-01-01T00:00:05.000Z', 'r1'),
  ];
  const calls = [call('t1', '2026-01-01T00:00:02.000Z', 'r1'), call('t2', '2026-01-01T00:00:04.000Z', 'r1')];

  assert.deepEqual(
    buildChatTimeline(messages, calls, runs).map((item) => item.key),
    ['u1', 'a1', 't1', 'a2', 't2', 'a3']
  );
});

test('同一毫秒内的正文段排在工具卡前面', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'), message('a1', 'assistant', '2026-01-01T00:00:01.000Z', 'r1')];
  const calls = [call('t1', '2026-01-01T00:00:01.000Z', 'r1')];

  assert.deepEqual(
    buildChatTimeline(messages, calls, runs).map((item) => item.key),
    ['u1', 'a1', 't1']
  );
});

test('多轮按轮的时间顺序串起来，轮内不乱', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z'), run('r2', '2026-01-01T00:01:00.000Z')];
  const messages = [
    message('u2', 'user', '2026-01-01T00:01:00.000Z', 'r2'),
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    message('a2', 'assistant', '2026-01-01T00:01:02.000Z', 'r2'),
    message('a1', 'assistant', '2026-01-01T00:00:01.000Z', 'r1'),
  ];
  const calls = [call('t2', '2026-01-01T00:01:01.000Z', 'r2')];

  assert.deepEqual(
    buildChatTimeline(messages, calls, runs).map((item) => item.key),
    ['u1', 'a1', 'u2', 't2', 'a2']
  );
});

test('没挂到轮上的消息（乐观插入/旧数据）按自身时间落位，不跳到最前或最后', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [
    message('legacy', 'user', '2025-12-31T23:00:00.000Z'),
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    message('pending', 'user', '2026-01-01T00:02:00.000Z', 'r-unknown'),
  ];

  assert.deepEqual(
    buildChatTimeline(messages, [], runs).map((item) => item.key),
    ['legacy', 'u1', 'pending']
  );
});

test('署名只落在每轮第一条正文上，以工具卡开头的轮也能署上名', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z'), run('r2', '2026-01-01T00:10:00.000Z')];
  const messages = [
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    message('a1', 'assistant', '2026-01-01T00:00:02.000Z', 'r1'),
    message('a2', 'assistant', '2026-01-01T00:00:04.000Z', 'r1'),
    message('u2', 'user', '2026-01-01T00:10:00.000Z', 'r2'),
    message('a3', 'assistant', '2026-01-01T00:10:03.000Z', 'r2'),
  ];
  const calls = [call('t1', '2026-01-01T00:00:01.000Z', 'r1'), call('t2', '2026-01-01T00:10:01.000Z', 'r2')];
  const items = buildChatTimeline(messages, calls, runs);

  assert.deepEqual(items.map((item) => item.key), ['u1', 't1', 'a1', 'a2', 'u2', 't2', 'a3']);
  assert.deepEqual(
    items.map((item, index) => (showStreamName(items, index) ? item.key : '')),
    // u1 起新轮；a1 是这一轮第一条正文（它前面只有工具卡）；a2 不重复署名；
    // u2 起新轮；a3 同理。工具卡不渲染署名，但判定结果本身为 true。
    ['u1', 't1', 'a1', '', 'u2', 't2', 'a3']
  );
});

test('轮间分隔只在换轮处出现，散项各自成段', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z'), run('r2', '2026-01-01T00:10:00.000Z')];
  const messages = [
    message('legacy', 'user', '2025-12-31T23:00:00.000Z'),
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    message('a1', 'assistant', '2026-01-01T00:00:02.000Z', 'r1'),
    message('u2', 'user', '2026-01-01T00:10:00.000Z', 'r2'),
  ];
  const calls = [call('t1', '2026-01-01T00:00:01.000Z', 'r1')];
  const items = buildChatTimeline(messages, calls, runs);

  assert.deepEqual(items.map((item) => item.key), ['legacy', 'u1', 't1', 'a1', 'u2']);
  assert.deepEqual(items.map((_, index) => startsNewRun(items, index)), [true, true, false, false, true]);
});

test('工具卡摘要取第一个字符串字段，坏 JSON 原样、超长截断', () => {
  assert.equal(toolCallSummary('{"query":"同步 冲突"}'), '同步 冲突');
  assert.equal(toolCallSummary('{"path":"Wiki/a.md","title":"A"}'), 'Wiki/a.md');
  assert.equal(toolCallSummary('{"limit":10}'), 'limit: 10');
  assert.equal(toolCallSummary('{}'), '');
  assert.equal(toolCallSummary(''), '');
  assert.equal(toolCallSummary('not json'), 'not json');
  assert.equal(toolCallSummary('{"query":"a\\nb"}'), 'a b');
  assert.equal(toolCallSummary(`{"query":"${'x'.repeat(120)}"}`), `${'x'.repeat(80)}…`);
});

test('思考段进同一条流：同一步里排在正文之前，同毫秒也不倒挂', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    thinking('k1', '2026-01-01T00:00:01.000Z', 'r1', 4200),
    message('a1', 'assistant', '2026-01-01T00:00:01.000Z', 'r1'),
    thinking('k2', '2026-01-01T00:00:02.000Z', 'r1'),
    message('a2', 'assistant', '2026-01-01T00:00:02.000Z', 'r1'),
  ];
  const items = buildChatTimeline(messages, [], runs);

  assert.deepEqual(items.map((item) => item.key), ['u1', 'k1', 'a1', 'k2', 'a2']);
  assert.deepEqual(items.map((item) => item.kind), ['message', 'reasoning', 'message', 'reasoning', 'message']);
  const thinkingItems = reasoningMessages(items);
  assert.equal(reasoningDurationMs(thinkingItems[0]), 4200);
  assert.equal(reasoningDurationMs(thinkingItems[1]), 0);
});

test('思考段不署名也不吞掉署名：正文仍在本轮第一条正文上署一次', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    thinking('k1', '2026-01-01T00:00:01.000Z', 'r1'),
    message('a1', 'assistant', '2026-01-01T00:00:02.000Z', 'r1'),
    thinking('k2', '2026-01-01T00:00:03.000Z', 'r1'),
    message('a2', 'assistant', '2026-01-01T00:00:04.000Z', 'r1'),
  ];
  const items = buildChatTimeline(messages, [], runs);

  assert.deepEqual(
    items.map((item, index) => (showStreamName(items, index) ? item.key : '')),
    // 模板里思考段走独立分支、不调用署名判定，所以 k1/k2 的返回值无意义；
    // 关键是 a1（本轮第一条正文）仍署上名、a2 不重复署名。
    ['u1', 'k1', 'a1', '', '']
  );
});

test('思考段与工具卡同轮共存时仍按发生顺序排', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    thinking('k1', '2026-01-01T00:00:01.000Z', 'r1'),
    message('a1', 'assistant', '2026-01-01T00:00:02.000Z', 'r1'),
  ];
  const calls = [call('t1', '2026-01-01T00:00:03.000Z', 'r1')];
  const items = buildChatTimeline(messages, calls, runs);

  assert.deepEqual(items.map((item) => item.key), ['u1', 'k1', 'a1', 't1']);
  assert.deepEqual(items.map((_, index) => startsNewRun(items, index)), [true, false, false, false]);
});

test('子代理单独成卡：派它的那次工具调用被并进卡里，不再单独占一行', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const messages = [
    message('u1', 'user', '2026-01-01T00:00:00.000Z', 'r1'),
    message('a1', 'assistant', '2026-01-01T00:00:01.000Z', 'r1'),
    message('a2', 'assistant', '2026-01-01T00:00:05.000Z', 'r1'),
  ];
  const calls = [
    call('t1', '2026-01-01T00:00:02.000Z', 'r1'),
    call('t2', '2026-01-01T00:00:03.000Z', 'r1'),
  ];
  const subs = [
    subagent('sub1', '2026-01-01T00:00:02.500Z', 'r1', { parentCallId: 't1', label: '检索同步' }),
  ];

  const items = buildChatTimeline(messages, calls, runs, subs);
  // t1 被 sub1 接管 → 只留 sub1；t2 是普通工具卡，照旧
  assert.deepEqual(items.map((item) => item.key), ['u1', 'a1', 'sub1', 't2', 'a2']);
  assert.deepEqual(items.map((item) => item.kind), ['message', 'message', 'subagent', 'tool', 'message']);
});

test('子代理没挂上的那次工具调用照旧显示（不吞卡片）', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const calls = [call('t1', '2026-01-01T00:00:02.000Z', 'r1')];
  const subs = [subagent('sub1', '2026-01-01T00:00:02.500Z', 'r1')];

  assert.deepEqual(
    buildChatTimeline([], calls, runs, subs).map((item) => item.key),
    ['t1', 'sub1']
  );
});

test('子代理再派子代理：嵌套的挂进父卡，不再单独成行', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z')];
  const subs = [
    subagent('sub1', '2026-01-01T00:00:01.000Z', 'r1'),
    subagent('sub2', '2026-01-01T00:00:02.000Z', 'r1', { parentSessionId: 'child-sub1' }),
    subagent('sub3', '2026-01-01T00:00:03.000Z', 'r1'),
  ];

  const items = buildChatTimeline([], [], runs, subs);
  assert.deepEqual(items.map((item) => item.key), ['sub1', 'sub3']);
  const first = items[0];
  assert.equal(first.kind, 'subagent');
  if (first.kind === 'subagent') {
    assert.deepEqual(first.children.map((child) => child.id), ['sub2']);
  }
});

test('子代理卡参与轮次归属：同轮内不乱序、跨轮画分隔', () => {
  const runs = [run('r1', '2026-01-01T00:00:00.000Z'), run('r2', '2026-01-01T00:01:00.000Z')];
  const items = buildChatTimeline(
    [message('u2', 'user', '2026-01-01T00:01:00.000Z', 'r2')],
    [],
    runs,
    [subagent('sub1', '2026-01-01T00:00:30.000Z', 'r1')]
  );

  assert.deepEqual(items.map((item) => item.key), ['sub1', 'u2']);
  assert.deepEqual(items.map((_, index) => startsNewRun(items, index)), [true, true]);
});
