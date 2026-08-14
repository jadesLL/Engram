import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseBody } from './client.js';

test('parseSseBody 提取匹配 id 的 JSON-RPC 响应', () => {
  // 模拟 ExampleProject MCP 服务端的 SSE 响应：先引导事件，再结果事件
  const sse = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"答案是 42"}],"isError":false}}',
    '',
    '',
  ].join('\n');

  const messages = parseSseBody(sse);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, 7);
  assert.equal(messages[0]?.result?.content?.[0]?.text, '答案是 42');
  assert.equal(messages[0]?.result?.isError, false);
});

test('parseSseBody 跳过注释与空 data 的引导事件', () => {
  const sse = ': keepalive\n\nid: 1\ndata: \n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n';
  const messages = parseSseBody(sse);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, 1);
  assert.equal(messages[0]?.result?.content?.[0]?.text, 'hi');
});

test('parseSseBody 处理 error 响应', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}\n\n';
  const messages = parseSseBody(sse);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.error?.code, -32601);
  assert.equal(messages[0]?.error?.message, 'Method not found');
});
