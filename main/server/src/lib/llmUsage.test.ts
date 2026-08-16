import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-usage-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let normalizeLlmUsage: typeof import('./llmUsage.js').normalizeLlmUsage;
let recordLlmUsage: typeof import('./llmUsage.js').recordLlmUsage;
let summarizeLlmUsage: typeof import('./llmUsage.js').summarizeLlmUsage;
let clearLlmUsage: typeof import('./llmUsage.js').clearLlmUsage;

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  migrate = dbModule.migrate;
  migrate();
  ({ normalizeLlmUsage, recordLlmUsage, summarizeLlmUsage, clearLlmUsage } = await import('./llmUsage.js'));
});

beforeEach(() => {
  db.exec('DELETE FROM llm_usage');
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('normalizes DeepSeek, OpenAI and Anthropic cache usage fields', () => {
  assert.deepEqual(normalizeLlmUsage({
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 100,
  }), {
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    cacheMissTokens: 100,
    cacheReported: true,
  });

  assert.deepEqual(normalizeLlmUsage({
    prompt_tokens: 400,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 320 },
  }), {
    promptTokens: 400,
    completionTokens: 20,
    totalTokens: 420,
    cacheReadTokens: 320,
    cacheWriteTokens: 0,
    cacheMissTokens: 80,
    cacheReported: true,
  });

  assert.deepEqual(normalizeLlmUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
  }), {
    promptTokens: 1050,
    completionTokens: 20,
    totalTokens: 1070,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
    cacheMissTokens: 150,
    cacheReported: true,
  });
});

test('summarizes only provider-reported cache accounting', () => {
  recordLlmUsage(
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      operation: 'chat',
      tag: 'ingest-map',
      scope: 'ingest',
      refId: 'run-1',
      stage: 'ingest-map:c0001',
      prefixHash: 'abc123',
      historyMessages: 3,
    },
    {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
    },
    1000,
  );
  recordLlmUsage(
    { provider: 'custom', model: 'unknown-cache-model', operation: 'chat', tag: 'writer-improve' },
    { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
    500,
  );

  const summary = summarizeLlmUsage(7);
  assert.equal(summary.requests, 2);
  assert.equal(summary.cacheRequests, 1);
  assert.equal(summary.promptTokens, 1200);
  assert.equal(summary.cacheReadTokens, 900);
  assert.equal(summary.cacheMissTokens, 100);
  assert.equal(summary.cacheHitRate, 0.9);
  assert.equal(summary.breakdown[0].tag, 'ingest-map');
  assert.equal(summary.breakdown[0].runs, 1);
  assert.equal(summary.breakdown[0].continuedRequests, 1);
  assert.equal(summary.breakdown[0].maxHistoryMessages, 3);
  assert.equal(summary.breakdown[1].cacheHitRate, null);
  assert.equal(summary.byOperation.length, 1);
  assert.equal(summary.byOperation[0].operation, 'chat');
  assert.equal(summary.byOperation[0].requests, 2);
  assert.equal(summary.byOperation[0].promptTokens, 1200);
  assert.equal(summary.byOperation[0].completionTokens, 140);
});

test('splits usage by model operation type (chat vs embedding)', () => {
  recordLlmUsage(
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      operation: 'chat',
      tag: 'search-answer',
    },
    {
      prompt_tokens: 500,
      completion_tokens: 200,
      total_tokens: 700,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 100,
    },
    800,
  );
  recordLlmUsage(
    {
      provider: 'zhipu',
      model: 'embedding-3',
      operation: 'embedding',
      tag: 'embedding',
    },
    { prompt_tokens: 300, completion_tokens: 0, total_tokens: 300 },
    50,
  );

  const summary = summarizeLlmUsage(7);
  assert.equal(summary.byOperation.length, 2);
  const chat = summary.byOperation.find((op) => op.operation === 'chat')!;
  assert.equal(chat.requests, 1);
  assert.equal(chat.promptTokens, 500);
  assert.equal(chat.completionTokens, 200);
  assert.equal(chat.cacheReadTokens, 400);
  assert.equal(chat.cacheHitRate, 0.8);
  const embedding = summary.byOperation.find((op) => op.operation === 'embedding')!;
  assert.equal(embedding.requests, 1);
  assert.equal(embedding.promptTokens, 300);
  assert.equal(embedding.completionTokens, 0);
  assert.equal(embedding.cacheHitRate, null);
});

test('clears only model usage rows', () => {
  recordLlmUsage(
    { provider: 'deepseek', model: 'test', operation: 'chat', tag: 'clear-test' },
    {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
    },
    100,
  );
  db.prepare(`INSERT INTO settings(key,value) VALUES('usage-clear-sentinel','keep')`).run();

  assert.equal(clearLlmUsage(), 1);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM llm_usage`).get().count, 0);
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key='usage-clear-sentinel'`).get().value, 'keep');
});

test('migration upgrades legacy llm usage tables with cache diagnostics columns', () => {
  db.exec(`
    DROP TABLE llm_usage;
    CREATE TABLE llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      operation TEXT NOT NULL DEFAULT 'chat',
      tag TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
      cache_reported INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      raw_usage TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  migrate();

  const columns = new Set(
    db.prepare(`PRAGMA table_info(llm_usage)`).all().map((column: any) => column.name),
  );
  for (const name of ['scope', 'ref_id', 'stage', 'prefix_hash', 'history_messages']) {
    assert.ok(columns.has(name), name);
  }
  assert.ok(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_llm_usage_ref'`).get(),
  );
});
