import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentApi,
  agentSettingsPath,
  customRoute,
  removeSections,
  syncAgentSettings,
  upsertSections,
  AGENT_APIS,
  CUSTOM_KEY_ENV,
  CUSTOM_PROVIDER_ID,
  DEFAULT_AGENT_API,
} from './agentSettings.js';

/**
 * 自定义地址最终落成内置 DSH_HOME 的 settings.yaml（dsh 的 llm-pi-ai 用户设置层）。
 * 这里钉住三件事：路由判定的边界、文本级段合并不碰用户手写内容、开关自定义地址时文件收放。
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

test('upsertSections：替换本方段、保留用户手写段与注释', () => {
  const existing = [
    '# 用户自己写的注释',
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    'llm-pi-ai:',
    '  providers:',
    '    old:',
    '      apiKeyEnv: OLD_KEY',
    '',
  ].join('\n');

  const once = upsertSections(existing, [
    { key: 'llm-pi-ai', lines: ['llm-pi-ai:', '  providers:', '    engram-custom:', '      baseURL: "https://a.example/v1"'] },
    { key: 'agent-default-model', lines: ['agent-default-model:', '  provider: engram-custom'] },
  ]);

  assert.match(once, /# 用户自己写的注释/);
  assert.match(once, /ui-onboarding:\n {2}welcomeNoticeVersion: 2026-08-13\.1/);
  assert.match(once, /baseURL: "https:\/\/a\.example\/v1"/);
  assert.doesNotMatch(once, /OLD_KEY/);
  assert.match(once, /agent-default-model:\n {2}provider: engram-custom/);

  // 幂等：再写一遍不会把段叠加成两份
  const twice = upsertSections(once, [
    { key: 'llm-pi-ai', lines: ['llm-pi-ai:', '  providers:', '    engram-custom:', '      baseURL: "https://b.example/v1"'] },
    { key: 'agent-default-model', lines: ['agent-default-model:', '  provider: engram-custom'] },
  ]);
  assert.equal((twice.match(/^llm-pi-ai:$/gm) || []).length, 1);
  assert.equal((twice.match(/^agent-default-model:$/gm) || []).length, 1);
  assert.match(twice, /https:\/\/b\.example\/v1/);
});

test('removeSections：只删本方段，其余逐字保留', () => {
  const text = 'ui-onboarding:\n  a: 1\nllm-pi-ai:\n  providers: {}\nagent-default-model:\n  provider: x\n';
  assert.equal(removeSections(text, ['llm-pi-ai', 'agent-default-model']), 'ui-onboarding:\n  a: 1');
  assert.equal(removeSections('llm-pi-ai:\n  providers: {}\n', ['llm-pi-ai']), '');
});

test('syncAgentSettings：写地址与模型清单，不含 Key 明文；关闭后整体回收', () => {
  const home = tempHome();
  const file = agentSettingsPath(home);

  syncAgentSettings(home, { baseUrl: 'https://openglm.example:44443/v1', model: 'deepseek-v4.1-flash' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# Engram 内置 Agent 的模型地址配置/);
  assert.match(text, /llm-pi-ai:/);
  assert.match(text, / {4}engram-custom:/);
  assert.match(text, new RegExp(`apiKeyEnv: ${CUSTOM_KEY_ENV}`));
  assert.match(text, /api: openai-completions/);
  assert.match(text, /baseURL: "https:\/\/openglm\.example:44443\/v1"/);
  assert.match(text, /- id: "deepseek-v4\.1-flash"/);
  assert.match(text, /agent-default-model:\n {2}provider: engram-custom\n {2}model: "deepseek-v4\.1-flash"/);

  // 换地址：整段替换，不叠加
  syncAgentSettings(home, { baseUrl: 'https://other.example/v1', api: 'anthropic-messages', model: 'claude-sonnet-5' });
  const next = fs.readFileSync(file, 'utf8');
  assert.equal((next.match(/^llm-pi-ai:$/gm) || []).length, 1);
  assert.match(next, /api: anthropic-messages/);
  assert.doesNotMatch(next, /openglm\.example/);

  // 关掉自定义地址：本方两段清空后文件整体删除
  syncAgentSettings(home, { model: 'deepseek-v4-flash' });
  assert.equal(fs.existsSync(file), false);

  fs.rmSync(home, { recursive: true, force: true });
});

test('syncAgentSettings：用户手写的 settings.yaml 不被整份覆盖', () => {
  const home = tempHome();
  const file = agentSettingsPath(home);
  fs.writeFileSync(file, 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n', 'utf8');

  syncAgentSettings(home, { baseUrl: 'https://api.example.com/v1', model: 'gpt-5.6-sol' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /ui-onboarding:\n {2}welcomeNoticeVersion: 2026-08-13\.1/);
  assert.match(text, /baseURL: "https:\/\/api\.example\.com\/v1"/);

  syncAgentSettings(home, {});
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n');

  fs.rmSync(home, { recursive: true, force: true });
});
