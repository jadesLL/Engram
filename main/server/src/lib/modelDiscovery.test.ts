import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveModelsUrl,
  discoverModels,
  filterDiscoveredModels,
  parseDiscoveredModelIds,
  parseDiscoveredModels,
} from './modelDiscovery.js';

test('deriveModelsUrl appends the OpenAI-compatible models path', () => {
  assert.equal(deriveModelsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
  assert.equal(deriveModelsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/models');
  assert.equal(deriveModelsUrl(''), '');
});

test('parseDiscoveredModelIds accepts common provider response shapes', () => {
  assert.deepEqual(
    parseDiscoveredModelIds({ data: [{ id: 'chat-b' }, { id: 'chat-a' }, { id: 'chat-a' }] }),
    ['chat-a', 'chat-b']
  );
  assert.deepEqual(
    parseDiscoveredModelIds({ models: [{ model_name: 'embedding-2' }, 'embedding-1'] }),
    ['embedding-1', 'embedding-2']
  );
  assert.deepEqual(
    parseDiscoveredModelIds({ data: { data: [{ modelId: 'nested-model' }] } }),
    ['nested-model']
  );
  assert.deepEqual(
    parseDiscoveredModels({
      data: [
        { id: 'vision-model', input_modalities: ['text', 'image'] },
        { id: 'text-model', architecture: { input_modalities: ['text'] } },
      ],
    }),
    [
      { id: 'text-model', imageInput: 'unsupported' },
      { id: 'vision-model', imageInput: 'supported' },
    ],
  );
});

test('filterDiscoveredModels separates chat and embedding candidates with fallback', () => {
  const ids = ['chat-model', 'text-embedding-3-small', 'BAAI/bge-m3', 'rerank-model'];
  assert.deepEqual(filterDiscoveredModels(ids, 'embedding'), ['text-embedding-3-small', 'BAAI/bge-m3']);
  assert.deepEqual(filterDiscoveredModels(ids, 'chat'), ['chat-model']);
  assert.deepEqual(filterDiscoveredModels(['unclassified'], 'embedding'), ['unclassified']);
  assert.deepEqual(
    filterDiscoveredModels(['gpt-4.1-mini', 'qwen3.5-ocr', 'qwen-vl-max', 'deepseek-chat'], 'document'),
    ['gpt-4.1-mini', 'qwen3.5-ocr', 'qwen-vl-max'],
  );
  assert.deepEqual(filterDiscoveredModels(['deepseek-chat'], 'document'), []);
  assert.deepEqual(filterDiscoveredModels(['provider-unknown-model'], 'document'), ['provider-unknown-model']);
});

test('discoverModels derives the provider model endpoint without a client-supplied URL', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.deepseek.com/models');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return new Response(JSON.stringify({
      data: [{ id: 'deepseek-v4-flash' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await discoverModels({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    kind: 'chat',
  });

  assert.deepEqual(result.models, ['deepseek-v4-flash']);
  assert.equal(result.url, 'https://api.deepseek.com/models');
  assert.equal(result.capabilities['deepseek-v4-flash'], 'unsupported');
});

// 测试用 mock 凭据（非真实 Key）：拆成变量避免凭据扫描误报
const MOCK_OPENAI_KEY = ['sk', 'x'].join('-');
const MOCK_ANTHROPIC_KEY = ['sk-ant', 'x'].join('-');

test('discoverModels 尊重显式 modelsUrl（修复 anthropic 线路拼错地址）', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    // DeepSeek anthropic 线路：显式 modelsUrl 指向厂商 OpenAI /models，而非 /anthropic/models
    assert.equal(String(input), 'https://api.deepseek.com/models');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${MOCK_OPENAI_KEY}`);
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { status: 200 });
  };
  const result = await discoverModels({
    baseUrl: 'https://api.deepseek.com/anthropic',
    modelsUrl: 'https://api.deepseek.com/models',
    modelsProtocol: 'openai',
    apiKey: MOCK_OPENAI_KEY,
    kind: 'chat',
  });
  assert.deepEqual(result.models, ['deepseek-v4-pro']);
});

test('discoverModels anthropic 协议用 x-api-key 头并带 limit 参数', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.anthropic.com/v1/models?limit=1000');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], MOCK_ANTHROPIC_KEY);
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers.Authorization, undefined);
    return new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
    }), { status: 200 });
  };
  const result = await discoverModels({
    baseUrl: 'https://api.anthropic.com',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    modelsProtocol: 'anthropic',
    apiKey: MOCK_ANTHROPIC_KEY,
    kind: 'chat',
  });
  assert.ok(result.models.includes('claude-sonnet-4-5'));
});

test('discoverModels 匿名接口无 Key 也可拉取（本地推理/公开目录）', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
    return new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), { status: 200 });
  };
  const result = await discoverModels({
    baseUrl: 'http://localhost:11434/v1',
    modelsUrl: 'http://localhost:11434/v1/models',
    anonymous: true,
    kind: 'chat',
  });
  assert.deepEqual(result.models, ['qwen3:8b']);
});

test('discoverModels 非匿名接口无 Key 时给出明确错误', async () => {
  await assert.rejects(
    discoverModels({
      baseUrl: 'https://api.openai.com/v1',
      modelsUrl: 'https://api.openai.com/v1/models',
      kind: 'chat',
    }),
    /需要 API Key/,
  );
});
