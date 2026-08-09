import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-semantic-merge-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let createPage: any;
let readPage: any;
let writePage: any;
let mergePages: any;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(body.messages.at(-1).content);
    const empty = input.otherPage.title.includes('完全重复');
    const output = {
      addition: empty ? '' : '独有事实：被合并页记录了新的客户验收结论。',
      rationale: empty ? '两页事实完全重复，无需追加正文。' : '保留被合并页中的独有验收结论。',
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('./db.js');
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
  ({ createPage, readPage, writePage } = await import('./vault.js'));
  ({ mergePages } = await import('./mergePages.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('page merge uses the model to create a deduplicated increment', async () => {
  const keep = createPage('Wiki/概念', '保留页');
  const other = createPage('Wiki/概念', '被合并页');
  writePage(keep.path, '# 保留页\n\n已有事实。', { type: 'concept', sources: ['资料 A'] });
  writePage(other.path, '# 被合并页\n\n已有事实。\n\n新的客户验收结论。', {
    type: 'concept',
    sources: ['资料 B'],
  });

  await mergePages(keep.id, other.id);

  assert.match(readPage(keep.path).content, /独有事实：被合并页记录了新的客户验收结论/);
  const archived = db.prepare(`SELECT path FROM pages WHERE id=?`).get(other.id);
  assert.match(archived.path, /^Wiki\/归档\//);
  const event = db.prepare(
    `SELECT status,output FROM semantic_events
     WHERE scope='page-merge' AND ref_id=? ORDER BY id DESC LIMIT 1`
  ).get(`${keep.id}:${other.id}`);
  assert.equal(event.status, 'succeeded');
  assert.match(event.output, /独有验收结论/);
});

test('fully duplicate pages may merge without fabricating an increment', async () => {
  const keep = createPage('Wiki/概念', '完整保留页');
  const other = createPage('Wiki/概念', '完全重复页');
  writePage(keep.path, '# 完整保留页\n\n完全相同的事实。', { type: 'concept' });
  writePage(other.path, '# 完全重复页\n\n完全相同的事实。', { type: 'concept' });

  await mergePages(keep.id, other.id);

  const content = readPage(keep.path).content;
  assert.doesNotMatch(content, /## 合并自/);
  assert.doesNotMatch(content, /undefined|null/);
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(other.id) as any).path,
    /^Wiki\/归档\//,
  );
});
