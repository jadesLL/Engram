import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_PATCH_FILE,
  agentPatchEntryIds,
  agentPatchPath,
  agentPatchText,
  modelRouteBlocks,
  writeAgentPatch,
} from './agentPatch.js';
import {
  CUSTOM_KEY_ENV,
  CUSTOM_PROVIDER_ID,
  LEGACY_SETTINGS_HEADER,
  agentSettingsPath,
  profilePatchPath,
} from './agentSettings.js';

const route = {
  provider: CUSTOM_PROVIDER_ID,
  baseUrl: 'https://api.example.com/v1',
  api: 'openai-completions' as const,
  model: 'my-model',
  keyEnv: CUSTOM_KEY_ENV,
};

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-patch-'));
}

test('modelRouteBlocks：llm-pi-ai 声明 provider，agent-default-model 指向它', () => {
  const text = modelRouteBlocks(route).join('\n');
  assert.match(text, /^- id: llm-pi-ai$/m);
  assert.match(text, /^ {4}providers:$/m);
  assert.match(text, new RegExp('^ {6}' + CUSTOM_PROVIDER_ID + ':$', 'm'));
  assert.match(text, new RegExp('apiKeyEnv: ' + CUSTOM_KEY_ENV));
  assert.match(text, /api: openai-completions/);
  assert.match(text, /baseURL: "https:\/\/api\.example\.com\/v1"/);
  assert.match(text, /- id: "my-model"/);
  assert.match(text, /^- id: agent-default-model$/m);
  assert.match(text, /provider: engram-custom/);
  assert.match(text, /model: "my-model"/);
});

test('agentPatchText：不配自定义地址时只有 MCP 条目', () => {
  const text = agentPatchText({ token: 'tok', route: null, mcpUrl: 'http://127.0.0.1:18080/mcp' });
  assert.match(text, /mcp-engram/);
  assert.match(text, /serverName: engram/);
  assert.match(text, /Bearer tok/);
  assert.equal(text.includes('llm-pi-ai'), false);
  assert.equal(text.includes('agent-default-model'), false);
  assert.equal(agentPatchEntryIds(text).includes('mcp-engram'), true);
});

test('agentPatchText：配了自定义地址时 MCP 与路由共存且顺序稳定', () => {
  const text = agentPatchText({ token: 'tok', route, mcpUrl: 'http://127.0.0.1:18080/mcp' });
  const ids = agentPatchEntryIds(text);
  assert.deepEqual(ids, ['mcp-engram', 'llm-pi-ai', 'agent-default-model']);
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.endsWith('\n\n'), false);
});

test('writeAgentPatch：写文件、清掉本方遗留 settings.yaml 与 profile patch 旧路由', () => {
  const home = tempHome();
  fs.writeFileSync(agentSettingsPath(home), LEGACY_SETTINGS_HEADER + '\nagent-default-model:\n  provider: old\n', 'utf8');
  const profilePatch = profilePatchPath(home);
  fs.mkdirSync(path.dirname(profilePatch), { recursive: true });
  fs.writeFileSync(profilePatch, '- id: agent-default-model\n  config:\n    provider: old\n- id: keep\n', 'utf8');

  const file = writeAgentPatch(home, { token: 'tok', route, mcpUrl: 'http://127.0.0.1:18080/mcp' });
  assert.equal(path.basename(file), AGENT_PATCH_FILE);
  assert.equal(file, agentPatchPath(home));
  assert.equal(fs.existsSync(agentSettingsPath(home)), false);
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /mcp-engram/);
  assert.match(written, /llm-pi-ai/);
  const after = fs.readFileSync(profilePatch, 'utf8');
  assert.equal(after.includes('agent-default-model'), false);
  assert.equal(after.includes('- id: keep'), true);

  // 幂等：重复写不叠条目
  writeAgentPatch(home, { token: 'tok2', route, mcpUrl: 'http://127.0.0.1:18080/mcp' });
  const twice = fs.readFileSync(file, 'utf8');
  assert.equal((twice.match(/^- id: llm-pi-ai$/gm) || []).length, 1);

  fs.rmSync(home, { recursive: true, force: true });
});
