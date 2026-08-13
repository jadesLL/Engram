import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-index-state-'));
process.env.DATA_DIR = temp;

const originalFetch = globalThis.fetch;
let db: any;
let setSetting: (key: string, value: string) => void;
let ensureDirs: () => void;
let createPage: (dir: string, title: string) => any;
let writePage: (relPath: string, content: string, extra?: Record<string, any>) => any;
let indexPage: (pageId: string) => Promise<{ chunks: number; embedded: boolean }>;
let requests = 0;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  dbModule.migrate();
  ({ ensureDirs } = await import('../config.js'));
  ({ createPage, writePage } = await import('../lib/vault.js'));
  ({ indexPage } = await import('./indexer.js'));
});

beforeEach(() => {
  db.exec(`
    DELETE FROM vec_chunks;
    DELETE FROM chunks;
    DELETE FROM index_states;
    DELETE FROM edges;
    DELETE FROM entities;
    DELETE FROM pages_fts;
    DELETE FROM pages;
    DELETE FROM settings;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
  const chat = {
    id: 'chat',
    name: 'chat',
    provider: 'custom',
    baseUrl: 'https://mock.example/v1',
    model: 'mock-chat',
    apiKey: 'secret',
  };
  const embedding = {
    id: 'embedding',
    name: 'embedding',
    provider: 'custom',
    baseUrl: 'https://mock.example/v1',
    model: 'mock-embedding',
    apiKey: 'secret',
    dim: 3,
  };
  setSetting('chat_models', JSON.stringify([chat]));
  setSetting('active_chat_model', chat.id);
  setSetting('embedding_models', JSON.stringify([embedding]));
  setSetting('active_embedding_model', embedding.id);
  setSetting('embedding_dim', '3');
  requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({
      data: (body.input || []).map((_item: string, index: number) => ({
        index,
        embedding: [1, 0, 0],
      })),
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('unchanged page content reuses the completed vector index', async () => {
  const page = createPage('Wiki/概念', '索引复用');
  writePage(page.path, '# 索引复用\n\n稳定正文。', { type: 'concept' });

  const first = await indexPage(page.id);
  const second = await indexPage(page.id);

  assert.equal(first.embedded, true);
  assert.deepEqual(second, first);
  assert.equal(requests, 1);

  writePage(page.path, '# 索引复用\n\n正文已经变化。', { type: 'concept' });
  await indexPage(page.id);
  assert.equal(requests, 2);
});
