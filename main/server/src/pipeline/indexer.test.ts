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
let indexFileText: (fileId: string) => Promise<{ chunks: number; embedded: boolean }>;
let upsertFileRecord: (relPath: string, text: string, size: number) => string;
let requests = 0;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  dbModule.migrate();
  ({ ensureDirs } = await import('../config.js'));
  ({ createPage, writePage } = await import('../lib/vault.js'));
  ({ indexPage, indexFileText, upsertFileRecord } = await import('./indexer.js'));
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
    DELETE FROM files;
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

test('提取文本清空后：indexFileText 清掉旧索引，检索不再命中旧内容', async () => {
  const fileId = upsertFileRecord('资料/报告.txt', '第一版全文内容，应当被索引一次。', 100);
  const first = await indexFileText(fileId);
  assert.ok(first.chunks > 0);
  assert.equal(first.embedded, true);
  const ftsRows = () =>
    (db.prepare(`SELECT COUNT(*) c FROM files_fts WHERE file_id = ?`).get(fileId) as any).c;
  const chunkRows = () =>
    (db.prepare(`SELECT COUNT(*) c FROM chunks WHERE ref_type='file' AND ref_id=?`).get(fileId) as any).c;
  const stateRows = () =>
    (db.prepare(`SELECT COUNT(*) c FROM index_states WHERE ref_type='file' AND ref_id=?`).get(fileId) as any).c;
  assert.equal(ftsRows(), 1);
  assert.ok(chunkRows() > 0);
  assert.equal(stateRows(), 1);

  // 新版提取为空（如 PDF 全页失败）：同路径覆写后重新索引，旧 FTS/分块/向量必须被清理
  const again = upsertFileRecord('资料/报告.txt', '', 0);
  assert.equal(again, fileId);
  const second = await indexFileText(fileId);
  assert.deepEqual(second, { chunks: 0, embedded: false });
  assert.equal(ftsRows(), 0);
  assert.equal(chunkRows(), 0);
  assert.equal(stateRows(), 0);
});
