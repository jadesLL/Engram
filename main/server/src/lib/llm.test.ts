import test, { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-llm-'));
process.env.DATA_DIR = temp;

const originalFetch = globalThis.fetch;
let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let buildEmbeddingRequestBody: typeof import('./llm.js').buildEmbeddingRequestBody;
let embed: typeof import('./llm.js').embed;
let testModel: typeof import('./llm.js').testModel;
let getActiveChat: typeof import('./llm.js').getActiveChat;

type ModelEntry = import('./llm.js').ModelEntry;

before(async () => {
  ({ db, migrate, setSetting } = await import('./db.js'));
  ({ buildEmbeddingRequestBody, embed, testModel, getActiveChat } = await import('./llm.js'));
  migrate();
});

beforeEach(() => {
  db.exec('DELETE FROM settings');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'embedding-1',
    name: '测试 Embedding',
    provider: 'openai-compatible',
    baseUrl: 'https://embedding.example/v1/',
    model: 'embedding-model',
    apiKey: 'test-key',
    ...overrides,
  };
}

function activateEmbedding(modelEntry: ModelEntry): void {
  setSetting('embedding_models', JSON.stringify([modelEntry]));
  setSetting('active_embedding_model', modelEntry.id);
}

function mockEmbeddingResponse(
  response: unknown,
  inspect?: (url: string, body: Record<string, unknown>) => void
): void {
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    inspect?.(String(input), body);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('embedding request body only adds dimensions when the entry explicitly supports it', () => {
  assert.deepEqual(
    buildEmbeddingRequestBody({ model: 'model-a', dim: 3, supportsDimensions: true }, ['a']),
    { model: 'model-a', input: ['a'], dimensions: 3 }
  );
  assert.deepEqual(
    buildEmbeddingRequestBody({ model: 'model-a', dim: 3 }, ['a']),
    { model: 'model-a', input: ['a'] }
  );
  assert.deepEqual(
    buildEmbeddingRequestBody({ model: 'model-a', supportsDimensions: true }, ['a']),
    { model: 'model-a', input: ['a'] }
  );
});

test('invalid non-array chat model settings safely fall back to no active model', () => {
  setSetting('chat_models', JSON.stringify({ id: 'not-a-list' }));
  setSetting('active_chat_model', 'not-a-list');
  assert.equal(getActiveChat(), null);
});

test('embed sends configured dimensions and accepts correctly sized vectors', async () => {
  activateEmbedding(entry({ dim: 3, supportsDimensions: true }));
  let requestBody: Record<string, unknown> | undefined;
  mockEmbeddingResponse(
    {
      data: [
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    },
    (url, body) => {
      assert.equal(url, 'https://embedding.example/v1/embeddings');
      requestBody = body;
    }
  );

  assert.deepEqual(await embed(['first', 'second']), [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(requestBody, {
    model: 'embedding-model',
    input: ['first', 'second'],
    dimensions: 3,
  });
});

test('embed keeps the legacy request body and validates every vector when dim is configured', async () => {
  activateEmbedding(entry({ dim: 2 }));
  let requestBody: Record<string, unknown> | undefined;
  mockEmbeddingResponse(
    {
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [3] },
      ],
    },
    (_url, body) => { requestBody = body; }
  );

  await assert.rejects(embed(['first', 'second']), /配置维度 2，实际返回 1/);
  assert.deepEqual(requestBody, {
    model: 'embedding-model',
    input: ['first', 'second'],
  });
});

test('embed does not impose the fallback dimension on legacy entries without dim', async () => {
  activateEmbedding(entry());
  mockEmbeddingResponse({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] });

  assert.deepEqual(await embed(['text']), [[1, 2, 3, 4]]);
});

test('testModel sends dimensions and checks the returned embedding length', async () => {
  const modelEntry = entry({ dim: 3, supportsDimensions: true });
  let requestBody: Record<string, unknown> | undefined;
  mockEmbeddingResponse(
    { data: [{ index: 0, embedding: [1, 2] }] },
    (_url, body) => { requestBody = body; }
  );

  const result = await testModel(modelEntry, 'embedding');
  assert.equal(result.ok, false);
  assert.match(result.error || '', /配置维度 3，实际返回 2/);
  assert.deepEqual(requestBody, {
    model: 'embedding-model',
    input: ['ping'],
    dimensions: 3,
  });
});

test('testModel rejects a non-array embedding', async () => {
  mockEmbeddingResponse({ data: [{ index: 0, embedding: 'not-an-array' }] });

  const result = await testModel(entry(), 'embedding');
  assert.equal(result.ok, false);
  assert.match(result.error || '', /embedding 不是数组/);
});
