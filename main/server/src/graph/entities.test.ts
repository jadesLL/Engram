import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-entities-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '[]' } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('chat_models', JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
  }]));
  dbModule.setSetting('active_chat_model', 'mock');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('LLM entity refresh preserves deterministic typed relation edges', async () => {
  const { createPage, writePage } = await import('../lib/vault.js');
  const { extractEntities } = await import('./entities.js');
  const source = createPage('Wiki/实体', '测试项目');
  const target = createPage('Wiki/实体', '张三');
  writePage(
    source.path,
    '# 测试项目\n\n## 当前理解\n\n这是足够长的测试正文，用于触发实体抽取流程。\n\n[[测试项目]]::主责::[[张三]]\n\n## 时间线\n',
    { type: 'project' }
  );
  writePage(target.path, '# 张三\n\n## 当前理解\n\n测试人员。\n\n## 时间线\n', { type: 'person' });
  db.prepare(
    `INSERT INTO edges(src_page,dst_page,dst_title,entity_id,rel,created_at)
     VALUES(?,?,NULL,NULL,'主责',?)`
  ).run(source.id, target.id, new Date().toISOString());

  await extractEntities(source.id);

  const edge = db.prepare(
    `SELECT id FROM edges WHERE src_page=? AND dst_page=? AND rel='主责' AND entity_id IS NULL`
  ).get(source.id, target.id);
  assert.ok(edge);
});

