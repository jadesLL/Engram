import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveModelsUrl,
  filterDiscoveredModels,
  parseDiscoveredModelIds,
} from './modelDiscovery.js';

test('deriveModelsUrl appends the OpenAI-compatible models path', () => {
  assert.equal(deriveModelsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
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
});

test('filterDiscoveredModels separates chat and embedding candidates with fallback', () => {
  const ids = ['chat-model', 'text-embedding-3-small', 'BAAI/bge-m3', 'rerank-model'];
  assert.deepEqual(filterDiscoveredModels(ids, 'embedding'), ['text-embedding-3-small', 'BAAI/bge-m3']);
  assert.deepEqual(filterDiscoveredModels(ids, 'chat'), ['chat-model']);
  assert.deepEqual(filterDiscoveredModels(['unclassified'], 'embedding'), ['unclassified']);
});
