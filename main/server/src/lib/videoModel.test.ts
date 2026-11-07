import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCredentialRefs,
  parseDshProviders,
  resolveVideoModel,
  hasVideoProvider,
  videoProviderDefaultProfile,
  VIDEO_MODEL_ID,
  VIDEO_PROVIDER_BASE_URL,
  VIDEO_PROVIDER_ID,
} from './videoModel.js';

/**
 * 视频理解模型配置解析（2026-11 起复用 dsh 模型配置）。
 *
 * 锁住三件事：
 *  1) 只读解析能认出 dsh 设置页 / 播种写入的 llm-pi-ai providers 结构（含注释、CRLF、多个提供商）；
 *  2) 凭据从 .credentials.yaml 的 refs 里按 apiKeyEnv 取（flow map 与块状 map 都认）；
 *  3) 缺提供商 / 缺 Key 时给出准确的缺项，界面与任务错误据此提示，不静默降级。
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-video-model-'));

function patchPath(): string {
  return path.join(home, 'profiles', 'web', 'cordis.patch.yml');
}

function credentialsPath(): string {
  return path.join(home, '.credentials.yaml');
}

function writePatch(text: string): void {
  fs.mkdirSync(path.dirname(patchPath()), { recursive: true });
  fs.writeFileSync(patchPath(), text, 'utf8');
}

function writeCredentials(text: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(credentialsPath(), text, 'utf8');
}

function cleanup(): void {
  fs.rmSync(patchPath(), { force: true });
  fs.rmSync(credentialsPath(), { force: true });
}

const DASHSCOPE_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries.',
  '- id: ui-settings-general',
  '  config:',
  '    welcomeNoticeVersion: 3',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      commandcode:',
  '        displayName: CommandCode',
  '        apiKeyEnv: COMMANDCODE_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://cc.example/v1',
  '        models:',
  '        - id: deepseek/chat',
  '          name: Chat',
  '          input:',
  '          - text',
  '      dashscope:',
  '        displayName: 阿里云百炼（DashScope）',
  '        apiKeyEnv: DASHSCOPE_API_KEY',
  '        api: openai-completions',
  "        baseURL: '" + VIDEO_PROVIDER_BASE_URL + "'",
  '        models:',
  '        - id: qwen3.8-omni-flash',
  '          name: qwen3.8-omni-flash',
  '          maxTokens: 8192',
].join('\r\n');

test('parseDshProviders：认出 llm-pi-ai 里的提供商、地址与模型列表（CRLF + 注释 + 多提供商）', () => {
  const providers = parseDshProviders(DASHSCOPE_PATCH);
  assert.equal(providers.length, 2);
  const dashscope = providers.find((provider) => provider.id === 'dashscope');
  assert.ok(dashscope, '没解析出 dashscope');
  assert.equal(dashscope!.displayName, '阿里云百炼（DashScope）');
  assert.equal(dashscope!.api, 'openai-completions');
  assert.equal(dashscope!.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.equal(dashscope!.baseURL, VIDEO_PROVIDER_BASE_URL, '带引号的 YAML 标量要去引号');
  assert.deepEqual(dashscope!.models.map((model) => model.id), [VIDEO_MODEL_ID]);

  const commandcode = providers.find((provider) => provider.id === 'commandcode');
  assert.ok(commandcode);
  assert.equal(commandcode!.models[0].name, 'Chat');
});

test('parseDshProviders：没有 llm-pi-ai 条目时返回空（不误把别的条目当提供商）', () => {
  assert.deepEqual(parseDshProviders('- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 3\n'), []);
});

test('parseCredentialRefs：flow map 与块状 map 都能取到 ref（值去引号，不夹带逗号）', () => {
  const flow = parseCredentialRefs([
    'version: 2',
    'records:',
    '  some/record:',
    '    kind: oauth',
    'refs:',
    '  {',
    "    DASHSCOPE_API_KEY: 'sk-flow-123',",
    '    DEEPSEEK_API_KEY: "sk-deep-456",',
    '  }',
    'after: 1',
  ].join('\n'));
  assert.equal(flow.DASHSCOPE_API_KEY, 'sk-flow-123');
  assert.equal(flow.DEEPSEEK_API_KEY, 'sk-deep-456');

  const block = parseCredentialRefs([
    'version: 2',
    'refs:',
    '  KIMI_API_KEY: sk-block-789',
    'other: 1',
  ].join('\n'));
  assert.equal(block.KIMI_API_KEY, 'sk-block-789');
  assert.equal(block.other, undefined);
});

test('resolveVideoModel：提供商 + Key 齐全时 configured=true，模型取 qwen3.8-omni-flash', () => {
  writePatch(DASHSCOPE_PATCH);
  writeCredentials(['version: 2', 'refs:', '  {', "    DASHSCOPE_API_KEY: 'sk-real-key',", '  }'].join('\n'));
  const resolution = resolveVideoModel(home);
  assert.equal(resolution.providerFound, true);
  assert.equal(resolution.configured, true);
  assert.deepEqual(resolution.missing, []);
  assert.equal(resolution.provider.providerId, VIDEO_PROVIDER_ID);
  assert.equal(resolution.provider.model, VIDEO_MODEL_ID);
  assert.equal(resolution.provider.baseUrl, VIDEO_PROVIDER_BASE_URL);
  assert.equal(resolution.provider.apiKey, 'sk-real-key');
  assert.equal(resolution.provider.keyRef, 'DASHSCOPE_API_KEY');
  cleanup();
});

test('resolveVideoModel：有提供商没 Key 时只缺 API Key（界面提示据此给出去控制台填 Key）', () => {
  writePatch(DASHSCOPE_PATCH);
  const resolution = resolveVideoModel(home);
  assert.equal(resolution.providerFound, true);
  assert.equal(resolution.configured, false);
  assert.deepEqual(resolution.missing, ['API Key']);
  cleanup();
});

test('resolveVideoModel：没有任何提供商时返回预置默认值，缺项是「视频模型提供商」', () => {
  const resolution = resolveVideoModel(home);
  assert.equal(resolution.providerFound, false);
  assert.equal(resolution.configured, false);
  assert.deepEqual(resolution.missing, ['视频模型提供商']);
  assert.equal(resolution.provider.model, VIDEO_MODEL_ID);
  assert.equal(resolution.provider.baseUrl, VIDEO_PROVIDER_BASE_URL);
  assert.equal(resolution.provider.apiKey, '');
});

test('resolveVideoModel：用户把提供商改名但模型还是 qwen3.8-omni-flash 时也能认出来', () => {
  writePatch([
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      my-qwen:',
    '        displayName: 我的千问',
    '        api: openai-completions',
    '        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
    '        models:',
    '        - id: qwen3.8-omni-flash',
  ].join('\n'));
  writeCredentials(['refs:', '  {', "    MY_QWEN_API_KEY: 'sk-mine',", '  }'].join('\n'));
  const resolution = resolveVideoModel(home);
  assert.equal(resolution.providerFound, true);
  assert.equal(resolution.configured, true);
  assert.equal(resolution.provider.providerId, 'my-qwen');
  assert.equal(resolution.provider.keyRef, 'MY_QWEN_API_KEY', '没写 apiKeyEnv 时按 provider id 推凭据名');
  cleanup();
});

test('hasVideoProvider / videoProviderDefaultProfile：播种判定看 dsh 里有没有视频提供商', () => {
  assert.equal(hasVideoProvider(home), false);
  writePatch(DASHSCOPE_PATCH);
  assert.equal(hasVideoProvider(home), true);
  cleanup();
  const profile = videoProviderDefaultProfile();
  assert.equal(profile.api, 'openai-completions');
  assert.equal(profile.baseURL, VIDEO_PROVIDER_BASE_URL);
  assert.equal(profile.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.deepEqual((profile.models as any[]).map((model) => model.id), [VIDEO_MODEL_ID]);
});
