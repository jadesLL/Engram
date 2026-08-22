import test, { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-rewrite-'));
process.env.DATA_DIR = temp;

const originalFetch = globalThis.fetch;
let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let rewriteQuery: typeof import('./queryRewrite.js').rewriteQuery;

type ModelEntry = import('../lib/llm.js').ModelEntry;

// 测试专用占位 Key：不指向任何真实服务，仅供 mock 场景通过配置校验
const TEST_API_KEY = process.env.TEST_API_KEY || ['test', 'key'].join('-');

function chatEntry(): ModelEntry {
  return {
    id: 'chat-1',
    name: '测试 Chat',
    provider: 'custom',
    baseUrl: 'https://chat.example/v1',
    model: 'chat-model',
    apiKey: TEST_API_KEY,
  };
}

function activateChat(): void {
  setSetting('chat_models', JSON.stringify([chatEntry()]));
  setSetting('active_chat_model', 'chat-1');
}

/** mock 一个返回固定 content 的 chat/completions 响应 */
function mockChatContent(content: string): void {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

before(async () => {
  ({ db, migrate, setSetting } = await import('../lib/db.js'));
  ({ rewriteQuery } = await import('./queryRewrite.js'));
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

test('rewrites the question into complementary queries including the original', async () => {
  activateChat();
  mockChatContent(JSON.stringify(['向量检索原理', 'embedding 检索', 'RAG 检索']));

  const queries = await rewriteQuery('知识库是怎么检索的');
  assert.deepEqual(queries, ['知识库是怎么检索的', '向量检索原理', 'embedding 检索', 'RAG 检索']);
});

test('falls back to the original query when the LLM is not configured', async () => {
  const queries = await rewriteQuery('未配置模型时的问题');
  assert.deepEqual(queries, ['未配置模型时的问题']);
});

test('falls back to the original query when the LLM output is not a string array', async () => {
  activateChat();
  mockChatContent(JSON.stringify({ queries: 'wrong-shape' }));

  const queries = await rewriteQuery('格式错误时的问题');
  assert.deepEqual(queries, ['格式错误时的问题']);
});

test('falls back when the request fails', async () => {
  activateChat();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });

  const queries = await rewriteQuery('请求失败时的问题');
  assert.deepEqual(queries, ['请求失败时的问题']);
});

test('deduplicates rewrites and caps the total at REWRITE_MAX_QUERIES', async () => {
  activateChat();
  mockChatContent(JSON.stringify([
    '重复查询', '重复查询', '第二条', '第三条', '第四条', '第五条',
  ]));

  const queries = await rewriteQuery('原始问题');
  assert.equal(queries.length, 4);
  assert.equal(queries[0], '原始问题');
  assert.equal(new Set(queries).size, 4);
});

test('strips fenced JSON output from the model', async () => {
  activateChat();
  mockChatContent('```json\n["改写一", "改写二"]\n```');

  const queries = await rewriteQuery('围栏输出问题');
  assert.deepEqual(queries, ['围栏输出问题', '改写一', '改写二']);
});
