import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_PATCH_FILE,
  CHAT_PATCH_FILE,
  agentPatchEntryIds,
  agentPatchPath,
  agentPatchText,
  chatPatchPath,
  chatPatchText,
  writeAgentPatch,
  writeChatPatch,
} from './agentPatch.js';
import {
  LEGACY_SETTINGS_HEADER,
  agentSettingsPath,
  profilePatchPath,
} from './agentSettings.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-patch-'));
}

test('agentPatchText：只含知识库 MCP 条目，不再写模型路由', () => {
  const text = agentPatchText({ token: 'tok', mcpUrl: 'http://127.0.0.1:18080/mcp' });
  assert.match(text, /mcp-engram/);
  assert.match(text, /serverName: engram/);
  assert.match(text, /Bearer tok/);
  assert.equal(text.includes('llm-pi-ai'), false);
  assert.equal(text.includes('agent-default-model'), false);
  assert.deepEqual(agentPatchEntryIds(text), ['mcp-engram']);
});

test('chatPatchText：在 web profile 上叠 sdk stdio 应用并关掉 Web UI', () => {
  const text = chatPatchText();
  const ids = agentPatchEntryIds(text);
  assert.deepEqual(ids, ['sdk-app-startup', 'sdk-jsonrpc-server', 'webserver', 'web-runtime', 'hmr', 'session-title-llm']);
  assert.match(text, /profile: web/);
  assert.match(text, /- id: webserver\n {2}disabled: true/);
  assert.match(text, /- id: web-runtime\n {2}disabled: true/);
  assert.match(text, /- id: session-title-llm\n {2}disabled: true/);
  // 聊天覆盖层不写 MCP 条目（MCP 在另一个 --patch 文件里）
  assert.equal(text.includes('mcp-engram'), false);
  assert.equal(text.endsWith('\n'), true);
});

test('writeAgentPatch：写文件并清理遗留 settings.yaml 与 profile patch 旧路由', () => {
  const home = tempHome();
  fs.writeFileSync(agentSettingsPath(home), LEGACY_SETTINGS_HEADER + '\nagent-default-model:\n  provider: old\n', 'utf8');
  const profilePatch = profilePatchPath(home);
  fs.mkdirSync(path.dirname(profilePatch), { recursive: true });
  fs.writeFileSync(profilePatch, '- id: agent-default-model\n  config:\n    provider: old\n- id: keep\n', 'utf8');

  const file = writeAgentPatch(home, { token: 'tok', mcpUrl: 'http://127.0.0.1:18080/mcp' });
  assert.equal(path.basename(file), AGENT_PATCH_FILE);
  assert.equal(file, agentPatchPath(home));
  assert.equal(fs.existsSync(agentSettingsPath(home)), false);
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /mcp-engram/);
  const after = fs.readFileSync(profilePatch, 'utf8');
  assert.equal(after.includes('agent-default-model'), false);
  assert.equal(after.includes('- id: keep'), true);

  fs.rmSync(home, { recursive: true, force: true });
});

test('writeChatPatch：写到 DSH_HOME 根目录，内容幂等', () => {
  const home = tempHome();
  const file = writeChatPatch(home);
  assert.equal(file, chatPatchPath(home));
  assert.equal(path.basename(file), CHAT_PATCH_FILE);
  const first = fs.readFileSync(file, 'utf8');
  writeChatPatch(home);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  fs.rmSync(home, { recursive: true, force: true });
});
