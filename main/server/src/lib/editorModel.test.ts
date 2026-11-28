import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-editor-model-'));
process.env.DATA_DIR = temp;

let mod: typeof import('./editorModel.js');

before(async () => {
  mod = await import('./editorModel.js');
});

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

function homeWith(patch: string, credentials = ''): string {
  const home = fs.mkdtempSync(path.join(temp, 'home-'));
  const profile = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch, 'utf8');
  if (credentials) fs.writeFileSync(path.join(home, '.credentials.yaml'), credentials, 'utf8');
  return home;
}

test('resolveEditorConfig：控制台默认模型是官方 deepseek 时沿用旧 Key', () => {
  const home = homeWith([
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-v4-pro',
  ].join('\n'));
  const config = mod.resolveEditorConfig(home, { apiKey: 'sk-legacy' });
  assert.deepEqual(config, { model: 'deepseek-v4-pro', apiKey: 'sk-legacy', api: 'openai-completions' });
});

test('resolveEditorConfig：没有 agent-default-model 时用 bundle 默认 Flash', () => {
  const home = homeWith('', '');
  const config = mod.resolveEditorConfig(home, { apiKey: 'sk-legacy' });
  assert.equal(config?.model, 'deepseek-flash');
  assert.equal(config?.baseUrl, undefined);
});

test('resolveEditorConfig：控制台默认模型是自定义提供商时解析 baseURL/api/Key', () => {
  const home = homeWith(
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      dashscope:',
      '        displayName: 阿里云百炼（DashScope）',
      '        api: openai-completions',
      '        baseURL: https://dashscope.example/v1',
      '        apiKeyEnv: DASHSCOPE_API_KEY',
      '        models:',
      '        - id: qwen3.8-omni-flash',
      '          name: qwen3.8-omni-flash',
      '- id: agent-default-model',
      '  config:',
      '    provider: dashscope',
      '    model: qwen3.8-omni-flash',
    ].join('\n'),
    'refs:\n  DASHSCOPE_API_KEY: sk-dashscope\n'
  );
  const config = mod.resolveEditorConfig(home, { apiKey: 'sk-legacy' });
  assert.equal(config?.model, 'qwen3.8-omni-flash');
  assert.equal(config?.baseUrl, 'https://dashscope.example/v1');
  assert.equal(config?.api, 'openai-completions');
  assert.equal(config?.apiKey, 'sk-dashscope');
});

test('resolveEditorConfig：官方路由没有 Key 时返回 null，交给调用方回退', () => {
  const home = homeWith('');
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(mod.resolveEditorConfig(home, {}), null);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test('editorCandidates：顺序为显式 → 控制台 → 旧配置，并去重', () => {
  const home = homeWith([
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-v4-pro',
  ].join('\n'));
  const candidates = mod.editorCandidates({
    explicit: { model: 'explicit-model', apiKey: 'sk-explicit' },
    home,
    fallback: { model: 'deepseek-flash', apiKey: 'sk-legacy' },
  });
  assert.deepEqual(candidates.map((item) => item.config.model), [
    'explicit-model',
    'deepseek-v4-pro',
    'deepseek-flash',
  ]);
});
