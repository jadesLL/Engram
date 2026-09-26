/**
 * 「记一条灵感」接口：正文进、标题出，落到 原始资料/灵感碎片/。
 *
 * 勘误链路本身在 lib/ideaNote.test.ts 与 lib/textFix.test.ts 里钉（要调模型）；
 * 这里注入假的 draftNote，只钉接口行为：校验、正文按**勘误后**的文本落盘且不带一级标题、
 * 返回体带页面 id / 标题来源 / 勘误明细与存疑项。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ideas-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let BRAIN_DIR = '';
/** 记录注入的拟标题实现收到的正文 */
const seen: string[] = [];

/** 默认假实现：正文里「北子所」按知识库既有写法勘误成「北自所」，标题照旧由模型（假）拟 */
let impl: (content: string) => Promise<import('../lib/ideaNote.js').IdeaNoteDraft> = async (content) => ({
  title: '北自所样车尺寸待确认',
  titleSource: 'model',
  text: content.replace(/北子所/g, '北自所'),
  fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录', basis: '知识库既有写法' }],
  pending: [],
});

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const configModule = await import('../config.js');
  configModule.ensureDirs();
  BRAIN_DIR = configModule.BRAIN_DIR;
  const { ideaRoutes } = await import('./ideas.js');
  app = Fastify();
  await app.register(jwt, { secret: 'ideas-test-secret' });
  await app.register(async (instance: FastifyInstance) => {
    await ideaRoutes(instance, {
      draftNote: async (content: string) => {
        seen.push(content);
        return impl(content);
      },
    });
  });
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

test('正文进、标题出：落到 原始资料/灵感碎片/日期_标题.md，正文不带一级标题', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: { content: '  北自所想确认样车尺寸，下周二之前要给回复。  ' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, '北自所样车尺寸待确认');
  assert.equal(body.titleSource, 'model');
  assert.match(body.path, /^原始资料\/灵感碎片\/\d{4}\.\d{2}\.\d{2}_北自所样车尺寸待确认\.md$/);
  assert.deepEqual(seen, ['北自所想确认样车尺寸，下周二之前要给回复。'], '送模型的正文应已 trim');

  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.equal(text.startsWith('#'), false);
  assert.match(text, /北自所想确认样车尺寸/);

  const row = db.prepare(`SELECT id, title, deleted FROM pages WHERE path = ?`).get(body.path) as any;
  assert.equal(row?.deleted, 0);
  assert.equal(row?.id, body.id);
});

test('落盘的是勘误后的正文：错名不进库，改了哪几处一并回给前端', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: { content: '北子所想确认样车尺寸，另外北子所那边催得急' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);
  assert.deepEqual(body.pending, []);

  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.match(text, /北自所想确认样车尺寸/);
  assert.match(text, /北自所那边催得急/);
  assert.equal(text.includes('北子所'), false, '错写法不能落进原始资料');
  // 同名灵感（第一条也是这个标题）依次加序号，不覆盖
  assert.match(body.path, /^原始资料\/灵感碎片\/\d{4}\.\d{2}\.\d{2}_北自所样车尺寸待确认( \(\d+\))?\.md$/);
});

test('检出但没动的疑似写法照样回给前端（前端据此提示）', async () => {
  const previous = impl;
  impl = async (content) => ({
    title: '样车尺寸待确认',
    titleSource: 'heuristic',
    text: content,
    fixes: [],
    pending: ['候成程'],
  });
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/ideas', headers: auth(), payload: { content: '候成程那边要的样车尺寸' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.fixes, []);
    assert.deepEqual(body.pending, ['候成程']);
    assert.equal(body.titleSource, 'heuristic');

    const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
    assert.match(text, /候成程那边要的样车尺寸/, '没确认的写法一个字不改');
  } finally {
    impl = previous;
  }
});

test('空正文被拒，不建空文件', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/ideas', headers: auth(), payload: { content: '   \n  ' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /还没有写内容/);
});

test('正文过长被拒（该走「新建资料」）', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/ideas', headers: auth(), payload: { content: '字'.repeat(20_001) },
  });
  assert.equal(res.statusCode, 413);
  assert.match(res.json().error, /太长/);
});

test('未登录被拒', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/ideas', payload: { content: '随手一事' },
  });
  assert.equal(res.statusCode, 401);
});
