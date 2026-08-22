import test, { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-synthesize-'));
process.env.DATA_DIR = temp;

const originalFetch = globalThis.fetch;
let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let thinkSearch: typeof import('./synthesize.js').thinkSearch;
let ftsSegment: typeof import('../lib/fts.js').ftsSegment;

// 测试专用占位 Key：不指向任何真实服务，仅供 mock 场景通过配置校验
const TEST_API_KEY = process.env.TEST_API_KEY || ['test', 'key'].join('-');

type ModelEntry = import('../lib/llm.js').ModelEntry;

function modelEntry(id: string, baseUrl: string, model: string): ModelEntry {
  return {
    id,
    name: `测试 ${id}`,
    provider: 'custom',
    baseUrl,
    model,
    apiKey: TEST_API_KEY,
  };
}

/** 只配 chat（供查询改写），不配 embedding：检索走纯 FTS 路径，避免向量依赖 */
function activateChatOnly(): void {
  setSetting('chat_models', JSON.stringify([modelEntry('chat-1', 'https://chat.example/v1', 'chat-model')]));
  setSetting('active_chat_model', 'chat-1');
}

function activateRerank(): void {
  setSetting('rerank_models', JSON.stringify([modelEntry('rerank-1', 'https://rerank.example/v1', 'bge-reranker')]));
  setSetting('active_rerank_model', 'rerank-1');
}

/** 插入 N 个页面 + FTS 行，构造可被 FTS 命中的候选池（中文需按索引器同款字级分词） */
function seedPages(count: number): void {
  const now = new Date().toISOString();
  const insertPage = db.prepare(
    `INSERT INTO pages(id,path,title,type,created_at,updated_at) VALUES(?,?,?,?,?,?)`
  );
  const insertFts = db.prepare(
    `INSERT INTO pages_fts(title,content,tags,page_id) VALUES(?,?,?,?)`
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insertPage.run(`p${i}`, `Wiki/概念/页面${i}.md`, `页面${i}`, 'concept', now, now);
      insertFts.run(ftsSegment(`页面${i}`), ftsSegment(`阿尔法测试知识内容 ${i}`), '', `p${i}`);
    }
  })();
}

/** 按请求路径分发 mock：chat 返回单查询改写（避免多查询干扰），rerank 返回指定排序 */
function mockLlmEndpoints(options: { rerankResponse?: unknown; rerankStatus?: number } = {}): {
  rerankCalls: { query: string; documents: string[]; topN: number }[];
} {
  const rerankCalls: { query: string; documents: string[]; topN: number }[] = [];
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input);
    if (url.includes('/chat/completions')) {
      // 返回空数组 → rewriteQuery 降级为仅原始查询
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/rerank')) {
      const body = JSON.parse(String(init?.body));
      rerankCalls.push({ query: body.query, documents: body.documents, topN: body.top_n });
      return new Response(JSON.stringify(options.rerankResponse ?? { results: [] }), {
        status: options.rerankStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return { rerankCalls };
}

before(async () => {
  ({ db, migrate, setSetting } = await import('../lib/db.js'));
  ({ thinkSearch } = await import('./synthesize.js'));
  ({ ftsSegment } = await import('../lib/fts.js'));
  migrate();
});

beforeEach(() => {
  db.exec('DELETE FROM settings; DELETE FROM llm_usage;');
  db.exec('DELETE FROM pages; DELETE FROM pages_fts; DELETE FROM chunks;');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('thinkSearch reranks the fused candidates down to the context limit', async () => {
  seedPages(12); // > 8 条命中 → 进入 rerank 分支
  activateChatOnly();
  activateRerank();
  // 精排结果：把 FTS 排第 9 的 p8 提到首位
  const { rerankCalls } = mockLlmEndpoints({
    rerankResponse: { results: [{ index: 8, relevance_score: 0.99 }, { index: 0, relevance_score: 0.5 }] },
  });

  const hits = await thinkSearch('阿尔法测试知识内容');

  assert.equal(rerankCalls.length, 1);
  assert.equal(rerankCalls[0].documents.length, 12);
  assert.equal(rerankCalls[0].topN, 8);
  assert.equal(hits.length, 2); // rerank 只返回了 2 条
  assert.equal(hits[0].refId, 'p8');
  assert.equal(hits[0].score, 0.99);
});

test('thinkSearch falls back to fused top hits when rerank fails', async () => {
  seedPages(12);
  activateChatOnly();
  activateRerank();
  mockLlmEndpoints({ rerankStatus: 500 });

  const hits = await thinkSearch('阿尔法测试知识内容');

  assert.equal(hits.length, 8);
  assert.ok(hits.every((h) => h.score > 0));
});

test('thinkSearch skips rerank entirely when no model is configured', async () => {
  seedPages(12);
  activateChatOnly();
  const { rerankCalls } = mockLlmEndpoints();

  const hits = await thinkSearch('阿尔法测试知识内容');

  assert.equal(rerankCalls.length, 0);
  assert.equal(hits.length, 8);
});

test('thinkSearch returns all merged hits when candidates are under the limit', async () => {
  seedPages(3);
  activateChatOnly();
  activateRerank();
  const { rerankCalls } = mockLlmEndpoints();

  const hits = await thinkSearch('阿尔法测试知识内容');

  assert.equal(rerankCalls.length, 0);
  assert.equal(hits.length, 3);
});

test('thinkSearch drops out-of-range rerank indices defensively', async () => {
  seedPages(10);
  activateChatOnly();
  activateRerank();
  // index 越界 + 合法条目混合：只保留合法条目
  mockLlmEndpoints({
    rerankResponse: {
      results: [
        { index: 99, relevance_score: 0.9 },
        { index: 2, relevance_score: 0.7 },
      ],
    },
  });

  const hits = await thinkSearch('阿尔法测试知识内容');

  assert.equal(hits.length, 1);
  assert.equal(hits[0].refId, 'p2');
});
