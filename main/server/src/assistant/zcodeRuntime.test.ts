import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// mapZcodeEvent 是纯函数，但模块顶层 import db（better-sqlite3），
// 用临时 DATA_DIR 兜底再动态 import，避免污染开发库。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-zcode-'));
process.env.DATA_DIR = temp;

test('mapZcodeEvent: stream-json 事件映射（探针 fixture 形态）', async () => {
  const { mapZcodeEvent } = await import('./zcodeRuntime.js');

  // hook 生命周期事件 → ignore
  const hook = mapZcodeEvent(JSON.stringify({
    eventId: 'x', sessionId: 'sess_1',
    payload: { hookEventName: 'SessionStart', descriptor: { commandDisplay: 'node x.js' }, matcher: 'startup' },
  }));
  assert.equal(hook?.kind, 'ignore');

  // 会话标题
  const title = mapZcodeEvent(JSON.stringify({
    eventId: 'x', sessionId: 'sess_1',
    payload: { previousTitle: '', source: 'first_input', title: '回答一个字：好' },
  }));
  assert.equal(title?.kind, 'title');
  assert.equal(title?.title, '回答一个字：好');
  assert.equal(title?.sessionId, 'sess_1');

  // 模型遥测 → ignore
  const req = mapZcodeEvent(JSON.stringify({
    payload: { type: 'model_request_started', baseURL: 'https://x', requestId: 'r' },
  }));
  assert.equal(req?.kind, 'ignore');

  // 文本增量（私有形态兼容：message_delta / content_block_delta）
  const delta = mapZcodeEvent(JSON.stringify({
    payload: { type: 'message_delta', text: '你好' },
  }));
  assert.equal(delta?.kind, 'delta');
  assert.equal(delta?.text, '你好');
  const delta2 = mapZcodeEvent(JSON.stringify({
    payload: { type: 'content_block_delta', delta: '！' },
  }));
  assert.equal(delta2?.kind, 'delta');
  assert.equal(delta2?.text, '！');

  // 工具调用开始/结束
  const toolStart = mapZcodeEvent(JSON.stringify({
    payload: { type: 'tool_use', id: 'tu_1', name: 'Bash' },
  }));
  assert.equal(toolStart?.kind, 'tool_start');
  assert.equal(toolStart?.toolId, 'tu_1');
  assert.equal(toolStart?.toolName, 'Bash');
  const toolDone = mapZcodeEvent(JSON.stringify({
    payload: { type: 'tool_result', id: 'tu_1', status: 'ok', summary: 'exit 0' },
  }));
  assert.equal(toolDone?.kind, 'tool_result');
  assert.equal(toolDone?.toolStatus, 'completed');
  const toolFail = mapZcodeEvent(JSON.stringify({
    payload: { type: 'tool_result', id: 'tu_1', status: 'failed' },
  }));
  assert.equal(toolFail?.toolStatus, 'failed');

  // 回合结束
  const done = mapZcodeEvent(JSON.stringify({ payload: { type: 'turn_complete' } }));
  assert.equal(done?.kind, 'done');

  // 非 JSON 行与空 payload → null / ignore
  assert.equal(mapZcodeEvent('not json'), null);
  assert.equal(mapZcodeEvent(JSON.stringify({ payload: { type: 'unknown_thing' } }))?.kind, 'ignore');
});
