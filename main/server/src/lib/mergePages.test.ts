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
let readPageMeta: any;
let writePage: any;
let mergePages: any;
let upsertFormerNameLine: any;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(body.messages.at(-1).content);
    const duplicate = input.otherPage.title.includes('完全重复');
    // 模拟 AI 综合改写：两页内容融为一体，含 H1/曾用名行/标准段落，非拼接
    const output = duplicate
      ? {
        content: `# ${input.keepPage.title}\n\n曾用名/常用名：${input.otherPage.title}\n\n## 当前理解\n\n完全相同的事实。\n\n## 相关页面\n\n\n## 时间线\n\n`,
        aliases: [],
        rationale: '两页事实完全重复，综合后无新增。',
      }
      : {
        content: `# ${input.keepPage.title}\n\n## 当前理解\n\n已有事实的综合叙述：保留页原有事实，并融入被合并页独有的客户验收结论。\n\n## 相关页面\n\n\n## 时间线\n\n`,
        aliases: ['张工'],
        rationale: '去重后融合两页事实，保留独有验收结论。',
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
  ({ createPage, readPage, readPageMeta, writePage } = await import('./vault.js'));
  ({ mergePages, upsertFormerNameLine } = await import('./mergePages.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('page merge synthesizes a rewritten page with unified H1 and former-name line', async () => {
  const keep = createPage('Wiki/概念', '保留页');
  const other = createPage('Wiki/概念', '被合并页');
  writePage(keep.path, '# 保留页\n\n已有事实。', { type: 'concept', sources: ['资料 A'] });
  writePage(other.path, '# 被合并页\n\n已有事实。\n\n新的客户验收结论。', {
    type: 'concept',
    sources: ['资料 B'],
  });

  await mergePages(keep.id, other.id);

  const content = readPage(keep.path).content;
  // AI 综合正文整体替换，不再是「合并自」追加块
  assert.match(content, /^# 保留页$/m, 'H1 应统一为保留页标题');
  assert.match(content, /综合叙述/);
  assert.doesNotMatch(content, /合并自/, '不应再出现机械追加的合并自小节');
  // 曾用名行:被合并页名 + LLM 识别的别名「张工」
  assert.match(content, /曾用名\/常用名：被合并页、张工/);
  // 时间线自动追加合并事件
  assert.match(content, /\[\[被合并页\]\] 的有效知识/);
  // 来源并集
  assert.deepEqual(readPageMeta(keep.path).sources.sort(), ['资料 A', '资料 B']);
  const archived = db.prepare(`SELECT path FROM pages WHERE id=?`).get(other.id);
  assert.match(archived.path, /^Wiki\/归档\//);
  const event = db.prepare(
    `SELECT status,output FROM semantic_events
     WHERE scope='page-merge' AND ref_id=? ORDER BY id DESC LIMIT 1`
  ).get(`${keep.id}:${other.id}`);
  assert.equal(event.status, 'succeeded');
  assert.match(event.output, /独有验收结论/);
});

test('fully duplicate pages merge into a clean synthesized page', async () => {
  const keep = createPage('Wiki/概念', '完整保留页');
  const other = createPage('Wiki/概念', '完全重复页');
  writePage(keep.path, '# 完整保留页\n\n完全相同的事实。', { type: 'concept' });
  writePage(other.path, '# 完全重复页\n\n完全相同的事实。', { type: 'concept' });

  await mergePages(keep.id, other.id);

  const content = readPage(keep.path).content;
  assert.match(content, /^# 完整保留页$/m);
  assert.match(content, /完全相同的事实/);
  assert.doesNotMatch(content, /undefined|null/);
  assert.match(
    (db.prepare(`SELECT path FROM pages WHERE id=?`).get(other.id) as any).path,
    /^Wiki\/归档\//,
  );
});

test('upsertFormerNameLine:插入、并入、H1 缺失三种形态', () => {
  assert.equal(
    upsertFormerNameLine('# 张三\n\n## 当前理解\n\n内容', ['张三(产品)']),
    '# 张三\n\n曾用名/常用名：张三(产品)\n\n## 当前理解\n\n内容',
    '无曾用名行时在 H1 后插入',
  );
  assert.equal(
    upsertFormerNameLine('# 张三\n\n曾用名/常用名：张三(产品)\n\n正文', ['老张']),
    '# 张三\n\n曾用名/常用名：张三(产品)、老张\n\n正文',
    '已有行时并入新名称',
  );
  assert.equal(
    upsertFormerNameLine('## 当前理解\n\n正文', ['张三']),
    '曾用名/常用名：张三\n\n## 当前理解\n\n正文',
    '无 H1 时插到最前',
  );
  assert.equal(
    upsertFormerNameLine('# 张三\n\n正文', []),
    '# 张三\n\n正文',
    '空名单原样返回',
  );
});
