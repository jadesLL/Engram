import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ZcodeConfig } from './zcodeRuntime.js';

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

test('zcodeSpawnEnv: 显式带 ELECTRON_RUN_AS_NODE=1（打包 exe 须以纯 Node 模式执行 CLI）', async () => {
  const { zcodeSpawnEnv } = await import('./zcodeRuntime.js');

  // 桌面版场景：server 进程环境里已有该变量（fork 而来），子进程必须保持为 1
  const fromForked = zcodeSpawnEnv({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1' } as NodeJS.ProcessEnv);
  assert.equal(fromForked.ELECTRON_RUN_AS_NODE, '1');

  // Docker/开发态场景：源环境没有该变量，也要补上（node 会忽略它，无副作用）
  const fromPlainNode = zcodeSpawnEnv({ PATH: 'x' } as NodeJS.ProcessEnv);
  assert.equal(fromPlainNode.ELECTRON_RUN_AS_NODE, '1');

  // 不改动源对象
  const source: Record<string, string> = {};
  zcodeSpawnEnv(source as NodeJS.ProcessEnv);
  assert.equal(source.ELECTRON_RUN_AS_NODE, undefined);
});

test('resolveZcodeEnginePath/zcodeInstalled: override 优先、候选回退、全缺失回退首候选', async () => {
  const { resolveZcodeEnginePath, zcodeInstalled } = await import('./zcodeRuntime.js');
  const yes = () => true;
  const no = () => false;
  const empty: ZcodeConfig = { enabled: false, mode: 'plan', path: '' };

  // 用户显式填写的路径原样优先：填错时也原样返回并判未安装，由面板暴露错误路径
  const override: ZcodeConfig = { enabled: false, mode: 'plan', path: 'D:\\custom\\zcode.cjs' };
  assert.equal(resolveZcodeEnginePath(override, no), 'D:\\custom\\zcode.cjs');
  assert.equal(zcodeInstalled(override, no), false);
  assert.equal(zcodeInstalled(override, yes), true);

  // 未填写：按候选顺序取第一个存在的（per-machine 优先，其次 per-user Programs 目录）
  assert.ok(resolveZcodeEnginePath(empty, (p) => p.includes('Program Files')).includes('Program Files'));
  const second = resolveZcodeEnginePath(empty, (p) => /Programs[/\\]ZCode/.test(p));
  assert.ok(!second.includes('Program Files'), '应跳过第一个候选取 per-user 候选');

  // 全缺失：回退首个候选供提示展示，且判未安装
  assert.ok(resolveZcodeEnginePath(empty, no).includes('Program Files'));
  assert.equal(zcodeInstalled(empty, no), false);
  assert.equal(zcodeInstalled(empty, yes), true);
});
