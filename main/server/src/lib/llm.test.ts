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
let buildDocumentRequestBody: typeof import('./llm.js').buildDocumentRequestBody;
let chatStream: typeof import('./llm.js').chatStream;
let embed: typeof import('./llm.js').embed;
let testModel: typeof import('./llm.js').testModel;
let getActiveChat: typeof import('./llm.js').getActiveChat;
let getActiveDocument: typeof import('./llm.js').getActiveDocument;
let getEffectiveDocumentModel: typeof import('./llm.js').getEffectiveDocumentModel;
let probeImageInput: typeof import('./llm.js').probeImageInput;

type ModelEntry = import('./llm.js').ModelEntry;

before(async () => {
  ({ db, migrate, setSetting } = await import('./db.js'));
  ({
    buildEmbeddingRequestBody,
    buildDocumentRequestBody,
    chatStream,
    embed,
    testModel,
    getActiveChat,
    getActiveDocument,
    getEffectiveDocumentModel,
    probeImageInput,
  } = await import('./llm.js'));
  migrate();
});

beforeEach(() => {
  db.exec('DELETE FROM settings; DELETE FROM llm_usage;');
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

test('document model settings are independent from the active chat model', () => {
  const documentEntry = entry({ id: 'document-1', model: 'vision-ocr' });
  setSetting('document_models', JSON.stringify([documentEntry]));
  setSetting('active_document_model', documentEntry.id);
  assert.equal(getActiveDocument()?.model, 'vision-ocr');
  assert.equal(getActiveChat(), null);
});

test('a confirmed multimodal chat model becomes the image fallback', () => {
  const chatEntry = entry({
    id: 'chat-vision',
    model: 'custom-vision-chat',
    imageInput: 'supported',
  });
  setSetting('chat_models', JSON.stringify([chatEntry]));
  setSetting('active_chat_model', chatEntry.id);
  assert.equal(getEffectiveDocumentModel()?.id, chatEntry.id);

  const visualEntry = entry({ id: 'visual-override', model: 'vision-ocr' });
  setSetting('document_models', JSON.stringify([visualEntry]));
  setSetting('active_document_model', visualEntry.id);
  assert.equal(getEffectiveDocumentModel()?.id, visualEntry.id);
});

test('document request uses OpenAI-compatible image content', () => {
  assert.deepEqual(
    buildDocumentRequestBody({ model: 'vision-ocr' }, 'data:image/png;base64,abc', '读取文字', 123),
    {
      model: 'vision-ocr',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          { type: 'text', text: '读取文字' },
        ],
      }],
      temperature: 0,
      max_tokens: 123,
    },
  );
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

test('embedding cache hits skip the API but still record a result-cache usage row', async () => {
  db.exec('DELETE FROM embedding_cache');
  activateEmbedding(entry());
  // 第一次：走 API 并写缓存（mock 响应带 usage，与真实服务商一致）
  mockEmbeddingResponse({
    data: [{ index: 0, embedding: [1, 2, 3, 4] }],
    usage: { prompt_tokens: 12, total_tokens: 12 },
  });
  assert.deepEqual(await embed(['cached-text']), [[1, 2, 3, 4]]);

  // 第二次：命中本地缓存，fetch 不应被调用
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('{}', { status: 200 });
  };
  assert.deepEqual(await embed(['cached-text']), [[1, 2, 3, 4]]);
  assert.equal(fetched, false);

  const rows = db.prepare(
    `SELECT tag,stage,result_cache_hit,prompt_tokens,cache_reported FROM llm_usage ORDER BY id`
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result_cache_hit, 0);
  assert.equal(rows[1].tag, 'embedding');
  assert.equal(rows[1].stage, 'local-embedding-cache');
  assert.equal(rows[1].result_cache_hit, 1);
  assert.ok(rows[1].prompt_tokens > 0);
  assert.equal(rows[1].cache_reported, 0);
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

test('streaming chat requests and records provider cache usage', async () => {
  const chatEntry = entry({
    id: 'chat-1',
    name: '测试 Chat',
    provider: 'deepseek',
    baseUrl: 'https://chat.example/v1',
    model: 'chat-model',
  });
  setSetting('chat_models', JSON.stringify([chatEntry]));
  setSetting('active_chat_model', chatEntry.id);
  let requestBody: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    const stream = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  let output = '';
  await chatStream(
    [{ role: 'user', content: '测试流式用量' }],
    (delta) => { output += delta; },
    { tag: 'stream-usage-test' },
  );

  assert.equal(output, '你好');
  assert.deepEqual(requestBody?.stream_options, { include_usage: true });
  assert.deepEqual(
    db.prepare(
      `SELECT provider,model,tag,prompt_tokens,cache_read_tokens,cache_miss_tokens
       FROM llm_usage`
    ).get(),
    {
      provider: 'deepseek',
      model: 'chat-model',
      tag: 'stream-usage-test',
      prompt_tokens: 100,
      cache_read_tokens: 80,
      cache_miss_tokens: 20,
    },
  );
});

test('streaming chat retries once without usage options for legacy providers', async () => {
  const chatEntry = entry({
    id: 'legacy-chat',
    name: '旧兼容接口',
    provider: 'custom',
    baseUrl: 'https://legacy-chat.example/v1',
    model: 'legacy-model',
  });
  setSetting('chat_models', JSON.stringify([chatEntry]));
  setSetting('active_chat_model', chatEntry.id);
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.stream_options) {
      return new Response(JSON.stringify({ error: { message: 'extra fields are not permitted' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"兼容"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  let output = '';
  await chatStream(
    [{ role: 'user', content: '测试旧接口' }],
    (delta) => { output += delta; },
    { tag: 'legacy-stream-test' },
  );

  assert.equal(output, '兼容');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(bodies[1].stream_options, undefined);
});

test('testModel verifies that a document model can read the generated image', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '731942' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const result = await testModel(entry({ model: 'vision-ocr' }), 'document', {
    imageChallenge: {
      code: '731942',
      dataUrl: 'data:image/png;base64,abc',
      prompt: '读取图片中的数字',
    },
  });
  assert.equal(result.ok, true);
});

test('image capability probe distinguishes explicit image rejection from transient errors', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'This model does not support image_url input' },
  }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const unsupported = await probeImageInput(entry({ model: 'custom-model' }), {
    force: true,
    challenge: {
      code: '731942',
      dataUrl: 'data:image/png;base64,abc',
      prompt: '读取图片中的数字',
    },
  });
  assert.equal(unsupported.status, 'unsupported');

  globalThis.fetch = async () => new Response('busy', { status: 503 });
  const unknown = await probeImageInput(entry({ model: 'custom-model' }), {
    force: true,
    challenge: {
      code: '731942',
      dataUrl: 'data:image/png;base64,abc',
      prompt: '读取图片中的数字',
    },
  });
  assert.equal(unknown.status, 'unknown');
});

// --- chatJson 空内容重试（失败一修复） ---

function activateChat(baseUrl = 'https://chat.example/v1'): void {
  const chatEntry = entry({
    id: 'chat-json',
    name: '测试 ChatJson',
    provider: 'custom',
    baseUrl,
    model: 'chat-model',
    apiKey: 'test-key',
  });
  setSetting('chat_models', JSON.stringify([chatEntry]));
  setSetting('active_chat_model', chatEntry.id);
}

test('chatJson treats empty content with reasoning_content as truncation and doubles max_tokens', async () => {
  activateChat('https://chat.example/v1');
  let chatModule: any;
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    // 第一次：content 为空但有 reasoning_content，finish_reason 非 length
    // 应被识别为推理占用预算导致的截断，chatJson 翻倍 max_tokens 重试
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: '', reasoning_content: '模型推理过程占满了预算……' },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // 第二次（翻倍 max_tokens 后）：正常返回 JSON
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  chatModule = await import('./llm.js');

  const result = await chatModule.chatJson(
    [{ role: 'user', content: '生成 JSON' }],
    { maxTokens: 2000, retries: 1, tag: 'empty-reasoning' },
  );
  assert.deepEqual(result, { ok: true });
  // 两次请求，第二次 max_tokens 翻倍（2000 → 4000）
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 2000);
  assert.equal(bodies[1].max_tokens, 4000);
});

test('chatJson retries with a targeted prompt when content is truly empty (no reasoning)', async () => {
  activateChat('https://chat.example/v1');
  let chatModule: any;
  const requestBodies: Record<string, any>[] = [];
  const messageBundles: any[][] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requestBodies.push(body);
    messageBundles.push(body.messages);
    // 始终返回真·空内容（无 reasoning，疑似内容过滤）
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  chatModule = await import('./llm.js');

  await assert.rejects(
    chatModule.chatJson(
      [{ role: 'user', content: '生成 JSON' }],
      { maxTokens: 1000, retries: 1, tag: 'empty-no-reasoning' },
    ),
    (err: any) => {
      assert.match(err.message, /\[empty-no-reasoning\] 请求失败: LLM 返回格式异常/);
      return true;
    },
  );
  // 两次请求：初稿 + 重试一次
  assert.equal(requestBodies.length, 2);
  // 重试时应追加了针对空内容的提示，而非默认的“重新输出合法 JSON”
  const retryMessages = messageBundles[1];
  assert.ok(retryMessages.some((m: any) => m.role === 'user' && /空内容/.test(m.content)),
    '重试消息应包含针对空内容的提示');
});
