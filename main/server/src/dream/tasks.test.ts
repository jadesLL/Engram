import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-dream-semantic-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let createPage: any;
let writePage: any;
let taskPairAudit: any;
let taskPageHealth: any;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const system = body.messages.find((message: any) => message.role === 'system')?.content || '';
    const output = system.includes('两个页面')
      ? {
          duplicate: true,
          preserveBoth: false,
          duplicateReason: '模型判断两页描述同一知识对象。',
          recommendedAction: 'keep_a',
          contradiction: true,
          contradictionDetail: '模型发现同一状态描述冲突。',
        }
      : {
          needsEnrichment: true,
          enrichmentReason: '模型判断缺少关键状态和后续动作。',
          stale: true,
          staleReason: '模型判断页面中的状态性事实需要复核。',
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
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
  ({ createPage, writePage } = await import('../lib/vault.js'));
  ({ taskPairAudit, taskPageHealth } = await import('./tasks.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('Dream Cycle uses model decisions instead of vector, length or age thresholds', async () => {
  const a = createPage('Wiki/概念', '语义页面 A');
  const b = createPage('Wiki/概念', '语义页面 B');
  writePage(a.path, '# 语义页面 A\n\n状态是启用，包含足够正文。', { type: 'concept' });
  writePage(b.path, '# 语义页面 B\n\n状态是停用，表达不同。', { type: 'concept' });

  const pair = await taskPairAudit();
  assert.deepEqual(pair, { duplicate: 1, contradiction: 1 });
  const duplicate = db.prepare(`SELECT payload FROM reports WHERE kind='duplicate'`).get();
  assert.match(duplicate.payload, /模型判断两页描述同一知识对象/);

  const health = await taskPageHealth();
  assert.deepEqual(health, { enrich: 2, stale: 2 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM semantic_events WHERE scope='dream'`).get().n, 3);
});
