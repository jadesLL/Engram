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
  agentSettingsStateFingerprint,
  cleanupLegacyRoute,
  cleanupLegacySettings,
  customRoute,
  dropTopLevelEntries,
  profilePatchPath,
  topLevelEntryIds,
} from './agentSettings.js';

/**
 * 控制台方案下 Engram 不再写 settings.yaml / 模型 patch；这里钉住升级清理与工具类模型路由。
 */

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-settings-'));
}

test('customRoute：工具类调用沿用旧配置（地址 + 模型），缺一退回官方地址', () => {
  assert.equal(customRoute({}), null);
  assert.equal(customRoute({ baseUrl: 'https://api.example.com/v1' }), null);
  assert.equal(customRoute({ model: 'deepseek-v4.1-flash' }), null);
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
  assert.equal(next.includes('# 文件头注释'), true);
  assert.equal(next.includes('这条给 llm-pi-ai'), true);
  assert.equal(next.includes('- id: other'), true);
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

  fs.rmSync(home, { recursive: true, force: true });
});

test('agentSettingsStateFingerprint：控制台改配置后指纹变化', () => {
  const home = tempHome();
  const first = agentSettingsStateFingerprint(home);
  const patch = profilePatchPath(home);
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, '- id: agent-default-model\n  config:\n    model: deepseek-flash\n', 'utf8');
  const second = agentSettingsStateFingerprint(home);
  assert.notEqual(first, second);
  fs.writeFileSync(patch, '- id: agent-default-model\n  config:\n    model: deepseek-flash\n', 'utf8');
  assert.equal(agentSettingsStateFingerprint(home), second); // 同内容重写不触发重开
  fs.rmSync(home, { recursive: true, force: true });
});
