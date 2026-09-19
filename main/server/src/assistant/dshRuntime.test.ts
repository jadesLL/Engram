import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapSessionEvent, mapNotification, planReasoningReplay } from './mapping.js';
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

test('assistant/message：思考块与正文块按块序切成两段（思考在前）', () => {
  const events = mapSessionEvent('assistant/message', {
    message: {
      content: [
        { type: 'reasoning', text: '先看索引' },
        { type: 'reasoning', text: '，再看同步' },
        { type: 'text', text: '总结如下' },
      ],
    },
  });
  assert.deepEqual(events, [
    { kind: 'reasoning', text: '先看索引，再看同步', parts: [] },
    { kind: 'text', text: '总结如下' },
  ]);
});

test('assistant/message：正文块在前时思考段排在它后面（按真实块序）', () => {
  const events = mapSessionEvent('assistant/message', {
    message: { content: [{ type: 'text', text: '先答' }, { type: 'reasoning', text: '再想' }] },
  });
  assert.deepEqual(events, [
    { kind: 'text', text: '先答' },
    { kind: 'reasoning', text: '再想', parts: [] },
  ]);
});

test('assistant/message：只有推理块时只产出思考段（不再整块丢弃）', () => {
  const events = mapSessionEvent('assistant/message', {
    message: { content: [{ type: 'reasoning', text: '想一下' }] },
  });
  assert.deepEqual(events, [{ kind: 'reasoning', text: '想一下', parts: [] }]);
});

test('assistant/message：带原始增量流时思考段带回放时间线', () => {
  const events = mapSessionEvent('assistant/message', {
    message: { content: [{ type: 'reasoning', text: '甲乙丙' }] },
    stream: [
      // 真实形状：reasoning-chunks 记录 time0 + 逐块 dt（第 i 块时间 = time0 + Σ dt[0..i]）
      { type: 'reasoning-chunks', time0: 1000, index: 0, dt: [10, 20, 30], texts: ['甲', '乙', '丙'] },
      { type: 'text-chunks', time0: 2000, index: 1, dt: [5], texts: ['答案'] },
    ],
  });
  assert.deepEqual(events, [{
    kind: 'reasoning',
    text: '甲乙丙',
    parts: [
      { text: '甲', at: 1010 },
      { text: '乙', at: 1030 },
      { text: '丙', at: 1060 },
    ],
  }]);
});

test('assistant/message：增量流拼不回块文本时放弃回放（宁可整段显示）', () => {
  const events = mapSessionEvent('assistant/message', {
    message: { content: [{ type: 'reasoning', text: '甲乙丙' }] },
    stream: [{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [1], texts: ['甲'] }],
  });
  assert.deepEqual(events, [{ kind: 'reasoning', text: '甲乙丙', parts: [] }]);
});

test('回放计划：没有增量记录就整段一次发出（不编造节奏）', () => {
  assert.deepEqual(planReasoningReplay([], '整段思考'), [{ text: '整段思考', delayMs: 0 }]);
  assert.deepEqual(
    planReasoningReplay([{ text: '别', at: 0 }, { text: '的', at: 10 }], '整段思考'),
    [{ text: '整段思考', delayMs: 0 }]
  );
  assert.deepEqual(planReasoningReplay([], ''), []);
});

test('回放计划：真实间隔超过上限时整体等比压缩', () => {
  // 10 秒的思考、10 块：压到 2s 上限 → 每块 200ms
  const parts = Array.from({ length: 10 }, (_, i) => ({ text: `第${i}段。`, at: i * 1000 }));
  const steps = planReasoningReplay(parts, parts.map((part) => part.text).join(''), { capMs: 2000 });
  const total = steps.reduce((sum, step) => sum + step.delayMs, 0);
  assert.ok(total <= 2100, `总时长应被压到上限内，实际 ${total}`);
  // 首块延迟 0 且不足合并阈值，会与第二块并成一帧 → 10 块变 9 帧，帧间隔约 222ms（1000 × 2000/9000）
  assert.equal(steps.length, 9);
  assert.ok(Math.abs(steps[0].delayMs - 222) <= 2, `压缩后间隔应约 222ms，实际 ${steps[0].delayMs}`);
});

test('回放计划：相邻小增量合并成少量帧，长思考有帧数上限', () => {
  const parts = Array.from({ length: 400 }, (_, i) => ({ text: '字', at: i * 5 }));
  const steps = planReasoningReplay(parts, parts.map((part) => part.text).join(''));
  assert.ok(steps.length <= 60, `帧数应被合并到 60 以内，实际 ${steps.length}`);
  assert.equal(steps.map((step) => step.text).join(''), '字'.repeat(400));
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

test('tool/result：文本取自 tool-result 块的第二层内容（真实载荷形状）', () => {
  // 形状照抄真实会话日志（DSH_HOME/sessions/*/session.v3.jsonl.zstd 的 tool/result 行）：
  // message.content[0] 是 tool-result 块，正文在它的 content[0].text
  const ok = mapSessionEvent('tool/result', {
    turn: 4,
    step: 1,
    message: {
      source: { kind: 'tool', callId: 'call_00_G8VZgpXj6DUHFJ0mPfVV9978' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call_00_G8VZgpXj6DUHFJ0mPfVV9978',
        content: [{ type: 'text', text: '原始资料/甲.md · md · 2KB · 提取:md页面 · 已提炼' }],
        isError: false,
      }],
      role: 'user',
      id: 'e7cdf03b-0110-4134-8dd0-e6db4dc9b9cb',
    },
  });
  assert.deepEqual(ok, [{
    kind: 'tool-result',
    callId: 'call_00_G8VZgpXj6DUHFJ0mPfVV9978',
    ok: true,
    text: '原始资料/甲.md · md · 2KB · 提取:md页面 · 已提炼',
  }]);

  // 失败：isError 在 tool-result 块上（不是 message 上），事件级 error 也要算失败
  const bad = mapSessionEvent('tool/result', {
    message: {
      source: { kind: 'tool', callId: 'call-2' },
      content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: '权限不足' }], isError: true }],
    },
  });
  assert.deepEqual(bad, [{ kind: 'tool-result', callId: 'call-2', ok: false, text: '权限不足' }]);

  const errored = mapSessionEvent('tool/result', {
    message: {
      content: [{ type: 'tool-result', toolCallId: 'call-3', content: [{ type: 'text', text: '挂了' }] }],
    },
    error: { name: 'ToolError', code: 'denied' },
  });
  assert.deepEqual(errored, [{ kind: 'tool-result', callId: 'call-3', ok: false, text: '挂了' }]);
});

test('tool/result：只有 source.callId 时也能对上工具卡', () => {
  const events = mapSessionEvent('tool/result', {
    message: {
      source: { kind: 'tool', callId: 'call-9' },
      content: [{ type: 'tool-result', content: [{ type: 'text', text: '空参数调用' }] }],
    },
  });
  assert.deepEqual(events, [{ kind: 'tool-result', callId: 'call-9', ok: true, text: '空参数调用' }]);
});

test('tool/result：文本直接铺在 content 上（旧/简化形状）仍认', () => {
  const events = mapSessionEvent('tool/result', {
    message: { toolCallId: 'call-1', content: [{ type: 'text', text: '3 条结果' }] },
  });
  assert.deepEqual(events, [{ kind: 'tool-result', callId: 'call-1', ok: true, text: '3 条结果' }]);

  const flatError = mapSessionEvent('tool/result', {
    message: { toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: '权限不足' }] },
  });
  assert.deepEqual(flatError, [{ kind: 'tool-result', callId: 'call-2', ok: false, text: '权限不足' }]);
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
