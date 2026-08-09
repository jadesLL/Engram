import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-mentions-semantic-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let createPage: any;
let writePage: any;
let readPage: any;
let runUpgrades: any;

before(async () => {
  server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            action: 'enrich',
            rationale: '引用页带来了当前页面没有的新职责信息。',
            content: '新增职责：负责跨部门验收。',
          }),
        },
      }],
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
  ({ createPage, writePage, readPage } = await import('../lib/vault.js'));
  ({ runUpgrades } = await import('./mentions.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('entity maturity action is selected by the model rather than mention-count thresholds', async () => {
  const entity = createPage('Wiki/实体', '模型成熟度实体');
  writePage(entity.path, '# 模型成熟度实体\n\n## 当前理解\n\n现有介绍。\n\n## 相关页面\n\n## 时间线\n', { type: 'person' });
  const reference = createPage('Wiki/概念', '唯一引用页');
  writePage(reference.path, '# 唯一引用页\n\n[[模型成熟度实体]] 负责跨部门验收。', { type: 'concept' });

  const logs = await runUpgrades();
  assert.equal(logs.length, 1);
  assert.match(readPage(entity.path).content, /新增职责：负责跨部门验收/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM semantic_events WHERE scope='entity-upgrade'`).get().n, 1);
});
