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
