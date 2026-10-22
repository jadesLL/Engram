import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_APIS,
  CUSTOM_KEY_ENV,
  CUSTOM_PROVIDER_ID,
  DEFAULT_AGENT_API,
  LEGACY_SETTINGS_HEADER,
  agentApi,
  agentSettingsPath,
  cleanupLegacyRoute,
  cleanupLegacySettings,
  customRoute,
  dropTopLevelEntries,
  profilePatchPath,
  topLevelEntryIds,
} from './agentSettings.js';

/**
 * 0.2.x 起内置 Agent 的模型路由不再写 settings.yaml（只做一次性遗留导入），
 * 这里钉住路由判定的边界与遗留文件清理行为；patch 文本生成在 agentPatch.test.ts。
 */

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-settings-'));
}

test('customRoute：地址与模型都填了才启用，缺一退回官方路由', () => {
  assert.equal(customRoute({}), null);
  assert.equal(customRoute({ baseUrl: 'https://api.example.com/v1' }), null);
  assert.equal(customRoute({ model: 'deepseek-v4.1-flash' }), null);
  assert.equal(customRoute({ baseUrl: '   ', model: '  ' }), null);

  const route = customRoute({ baseUrl: ' https://api.example.com/v1 ', model: ' deepseek-v4.1-flash ' });
  assert.deepEqual(route, {
    provider: CUSTOM_PROVIDER_ID,
    baseUrl: 'https://api.example.com/v1',
    api: DEFAULT_AGENT_API,
    model: 'deepseek-v4.1-flash',
    keyEnv: CUSTOM_KEY_ENV,
  });
});

test('agentApi：只认三个线协议，其余退回 openai-completions', () => {
  assert.deepEqual([...AGENT_APIS], ['openai-completions', 'openai-responses', 'anthropic-messages']);
  assert.equal(agentApi('anthropic-messages'), 'anthropic-messages');
  assert.equal(agentApi('nope'), DEFAULT_AGENT_API);
  assert.equal(agentApi(undefined), DEFAULT_AGENT_API);
});

test('cleanupLegacySettings：只删带本方文件头的遗留 settings.yaml', () => {
  const home = tempHome();
  const file = agentSettingsPath(home);
  fs.writeFileSync(file, LEGACY_SETTINGS_HEADER + '\nllm-pi-ai:\n  providers: {}\n', 'utf8');
  assert.equal(cleanupLegacySettings(home), true);
  assert.equal(fs.existsSync(file), false);

  // 用户手写（没有本方文件头）的文件不碰
  fs.writeFileSync(file, 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n', 'utf8');
  assert.equal(cleanupLegacySettings(home), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('ui-onboarding'), true);

  fs.rmSync(home, { recursive: true, force: true });
});

test('topLevelEntryIds：只收顶层条目（insert 块内的嵌套 id 不算）', () => {
  const text = [
    '- insert:',
    '    - id: mcp-engram',
    '- id: llm-pi-ai',
    '  config:',
    '    providers: {}',
    '- id: agent-default-model',
  ].join('\n');
  assert.deepEqual(topLevelEntryIds(text), ['llm-pi-ai', 'agent-default-model']);
});

test('dropTopLevelEntries：删指定条目，注释与其它内容逐字保留', () => {
  const text = [
    '# 文件头注释',
    '# 这条给 llm-pi-ai 的说明',
    '- id: llm-pi-ai',
    '  config:',
    '    providers: {}',
    '- id: other',
    '  config:',
    '    a: 1',
    '',
  ].join('\n');
  const next = dropTopLevelEntries(text, ['llm-pi-ai', 'agent-default-model']);
  assert.equal(next.includes('- id: llm-pi-ai'), false);
  assert.equal(next.includes('- id: agent-default-model'), false);
  // 注释保留（文件头与条目说明都不删）
  assert.equal(next.includes('# 文件头注释'), true);
  assert.equal(next.includes('这条给 llm-pi-ai'), true);
  assert.equal(next.includes('- id: other'), true);
  assert.equal(next.includes('    a: 1'), true);
});

test('cleanupLegacyRoute：清遗留 settings.yaml 与导入到 profile patch 的旧路由', () => {
  const home = tempHome();
  fs.writeFileSync(agentSettingsPath(home), LEGACY_SETTINGS_HEADER + '\nagent-default-model:\n  provider: engram-custom\n', 'utf8');
  const patch = profilePatchPath(home);
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, [
    '# Your patch layer for this dsh profile',
    '- id: llm-pi-ai',
    '  config:',
    '    providers: {}',
    '- id: agent-default-model',
    '  config:',
    '    provider: engram-custom',
    '    model: probe',
    '- id: keep-me',
    '  config:',
    '    a: 1',
  ].join('\n'), 'utf8');

  const result = cleanupLegacyRoute(home);
  assert.deepEqual(result, { removedSettings: true, cleanedProfilePatch: true });
  assert.equal(fs.existsSync(agentSettingsPath(home)), false);
  const after = fs.readFileSync(patch, 'utf8');
  assert.equal(after.includes('llm-pi-ai'), false);
  assert.equal(after.includes('agent-default-model'), false);
  assert.equal(after.includes('- id: keep-me'), true);
  assert.equal(after.includes('# Your patch layer'), true);

  fs.rmSync(home, { recursive: true, force: true });
});
