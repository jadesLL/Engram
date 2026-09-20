import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  agentActivityText,
  bareToolName,
  subagentDisplayLabel,
  toolLabel,
} from './agentActivity.ts';
import type { ChatSubagent, ChatToolCall } from '../stores/chat';

/** 用最少字段造一张工具卡 / 一个子代理 */
function call(id: string, name: string, extra: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    id,
    runId: 'run-1',
    name,
    args: '{}',
    status: 'completed',
    ok: true,
    text: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function subagent(id: string, extra: Partial<ChatSubagent> = {}): ChatSubagent {
  return {
    id,
    runId: 'run-1',
    parentSessionId: 'session-root',
    childSessionId: '0123456789abcdef',
    label: '',
    mode: 'one-shot',
    provider: 'spawn',
    prompt: '',
    status: 'running',
    stopReason: '',
    result: '',
    activity: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

test('工具名剥掉 MCP 前缀并翻成中文，没登记的退回原名', () => {
  assert.equal(bareToolName('mcp__engram__search'), 'search');
  assert.equal(bareToolName('search'), 'search');
  assert.equal(toolLabel('mcp__engram__write_page'), '写入页面');
  assert.equal(toolLabel('some_unknown_tool'), 'some_unknown_tool');
});

test('子代理标签：模型给的标签优先', () => {
  assert.equal(subagentDisplayLabel(subagent('a', { label: '核对来源' }), []), '核对来源');
});

test('子代理标签：没标签时退回派发工具卡的描述，再退回子会话号', () => {
  const parent = call('call-1', 'subagent', { args: '{"prompt":"核对三条来源的引用"}' });
  const withParent = subagent('a', { parentCallId: 'call-1' });
  assert.equal(subagentDisplayLabel(withParent, [parent]), '核对三条来源的引用');
  // 派发卡不在时退回子会话号，不能显示空标题
  assert.equal(subagentDisplayLabel(withParent, []), '子会话 01234567');
  assert.equal(subagentDisplayLabel(subagent('b'), []), '子会话 01234567');
});

test('状态文案：单个子代理在跑时报它的标签', () => {
  const text = agentActivityText({
    subagents: [subagent('a', { label: '核对来源' })],
    toolCalls: [],
    statusText: '',
    thinking: false,
  });
  assert.equal(text, '子代理「核对来源」运行中');
});

test('状态文案：多个子代理时报个数', () => {
  const text = agentActivityText({
    subagents: [subagent('a'), subagent('b')],
    toolCalls: [],
    statusText: '',
    thinking: false,
  });
  assert.equal(text, '2 个子代理运行中');
});

test('状态文案：没有子代理时报最后一条执行中的工具（带参数摘要）', () => {
  const text = agentActivityText({
    subagents: [],
    toolCalls: [
      call('c1', 'mcp__engram__search', { status: 'completed' }),
      call('c2', 'mcp__engram__read_page', { status: 'running', args: '{"id":"zhangwei"}' }),
    ],
    statusText: '',
    thinking: false,
  });
  assert.equal(text, '执行 读取页面 · zhangwei');
});

test('状态文案：逐级退回服务端状态文本 / 正在思考 / 正在生成回复', () => {
  const base = { subagents: [] as ChatSubagent[], toolCalls: [] as ChatToolCall[] };
  assert.equal(agentActivityText({ ...base, statusText: '正在调用模型', thinking: false }), '正在调用模型');
  assert.equal(agentActivityText({ ...base, statusText: '', thinking: true }), '正在思考');
  assert.equal(agentActivityText({ ...base, statusText: '', thinking: false }), '正在生成回复');
});
