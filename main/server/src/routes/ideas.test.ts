/**
 * 「记一条灵感」接口：正文进、标题出，落到 原始资料/灵感碎片/。
 *
 * 勘误与精炼链路本身在 lib/ideaNote.test.ts、lib/ideaPolish.test.ts 与 lib/textFix.test.ts 里钉
 * （要调模型）；这里注入假的 draftNote，只钉接口行为：
 *  - `/api/ideas/preview`：勘误 + 精炼 + 拟标题，**不落盘**（用户还没确认）；
 *  - `/api/ideas` 带 title：预览确认路径，用户确认过的正文原样落盘，不再改写；
 *  - `/api/ideas` 不带 title：一次到底路径（脚本 / 老客户端 / 手机端窄代理）；
 *  - 两条路径的校验一致（空正文 400、超长 413、未登录 401）。
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

/** 操作日志落点（见 pipeline/indexFile.ts 的 LOG_PAGE） */
const LOG_REL = 'AIWorks/log/log.md';

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let BRAIN_DIR = '';
/** 记录注入的拟标题实现收到的正文 */
const seen: string[] = [];

/** 默认假实现：「北子所」按知识库既有写法勘误成「北自所」，再把啰嗦的正文精炼一遍 */
let impl: (content: string) => Promise<import('../lib/ideaNote.js').IdeaNoteDraft> = async (content) => {
  const text = content.replace(/北子所/g, '北自所');
  return {
    title: '北自所样车尺寸待确认',
    titleSource: 'model',
    text,
    fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录', basis: '知识库既有写法' }],
    pending: [],
    refined: { applied: true, before: text.length, after: text.length },
  };
};

/** 灵感碎片目录里的文件数（预览不该让它变） */
function ideaFileCount(): number {
  return (db.prepare(`SELECT COUNT(*) n FROM pages WHERE path LIKE '原始资料/灵感碎片/%'`).get() as any).n;
}

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

test('预览：勘误 + 精炼 + 拟标题都回给前端，但一个字都不落盘', async () => {
  const before_ = ideaFileCount();
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas/preview',
    headers: auth(),
    payload: { content: '  北子所想确认样车尺寸，下周二之前要给回复。  ' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, '北自所样车尺寸待确认');
  assert.equal(body.titleSource, 'model');
  assert.equal(body.text, '北自所想确认样车尺寸，下周二之前要给回复。', '预览返回勘误后的正文');
  assert.deepEqual(body.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);
  assert.deepEqual(body.pending, []);
  assert.equal(body.refined.applied, true);
  assert.deepEqual(seen, ['北子所想确认样车尺寸，下周二之前要给回复。'], '送模型的正文应已 trim');
  assert.equal(ideaFileCount(), before_, '预览不落盘：确认前不进 原始资料/');
});

test('预览：空正文 400、超长 413（与落盘同一套校验）', async () => {
  const empty = await app.inject({
    method: 'POST', url: '/api/ideas/preview', headers: auth(), payload: { content: '   \n  ' },
  });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /还没有写内容/);

  const long = await app.inject({
    method: 'POST', url: '/api/ideas/preview', headers: auth(), payload: { content: '字'.repeat(20_001) },
  });
  assert.equal(long.statusCode, 413);
  assert.match(long.json().error, /太长/);
});

test('预览：未登录被拒', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/ideas/preview', payload: { content: '随手一事' },
  });
  assert.equal(res.statusCode, 401);
});

test('落盘（预览确认路径）：带 title 时不再改写，用户确认过的正文原样落盘', async () => {
  const seenBefore = seen.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: {
      title: '北自所样车尺寸待确认',
      content: '北自所想确认样车尺寸，下周二之前要回复他们。',
      note: '勘误 1 处：北子所→北自所；精炼 41→22 字',
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, '北自所样车尺寸待确认');
  assert.match(body.path, /^原始资料\/灵感碎片\/\d{4}\.\d{2}\.\d{2}_北自所样车尺寸待确认\.md$/);
  assert.equal(seen.length, seenBefore, '确认路径不该再调模型');

  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.equal(text.startsWith('#'), false);
  assert.match(text, /北自所想确认样车尺寸，下周二之前要回复他们。/);

  // 摘要（预览那一步的勘误/精炼明细）进操作日志，事后能复核
  const log = fs.readFileSync(path.join(BRAIN_DIR, LOG_REL), 'utf8');
  assert.match(log, /（勘误 1 处：北子所→北自所；精炼 41→22 字）/);
});

test('落盘（预览确认路径）：标题被清空时仍按确认落盘，不再跑一次模型', async () => {
  const seenBefore = seen.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: { title: '', content: '北自所那边要四向车参数表', note: '（精炼 20→12 字）' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(seen.length, seenBefore, '空标题不等于「没确认」：不该再跑一次模型');
  assert.equal(body.title, '随手记', '空标题退化成「随手记」，而不是让模型另拟一个');
  assert.match(body.path, /_随手记\.md$/);

  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.match(text, /北自所那边要四向车参数表/);

  const log = fs.readFileSync(path.join(BRAIN_DIR, LOG_REL), 'utf8');
  assert.match(log, /（精炼 20→12 字）/, '调用方自带的括号不会重复套一层');
  assert.equal(log.includes('（（'), false);
});

test('落盘（一次到底路径）：不带 title 时服务端跑完整链路，正文按勘误与精炼后的文本落盘', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: { content: '  北子所想确认样车尺寸，下周二之前要给回复。  ' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.title, '北自所样车尺寸待确认');
  assert.equal(body.titleSource, 'model');
  assert.deepEqual(body.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);
  assert.deepEqual(body.pending, []);
  assert.equal(body.refined.applied, true);
  assert.match(body.path, /^原始资料\/灵感碎片\/\d{4}\.\d{2}\.\d{2}_北自所样车尺寸待确认( \(\d+\))?\.md$/);

  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.match(text, /北自所想确认样车尺寸/);
  assert.equal(text.includes('北子所'), false, '错写法不能落进原始资料');
});

test('落盘：检出但没动的疑似写法照样回给前端（前端据此提示）', async () => {
  const previous = impl;
  impl = async (content) => ({
    title: '样车尺寸待确认',
    titleSource: 'heuristic',
    text: content,
    fixes: [],
    pending: ['候成程'],
    refined: { applied: false, before: content.length, after: content.length, reason: 'no-model' },
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
    assert.equal(body.refined.reason, 'no-model');

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

test('同步成员令牌也能记一条灵感（手机端唯一凭据）', async () => {
  // 手机端只持 lsync_ 成员令牌，它把「记一条灵感」窄代理到中枢；挂 requireAuth 会让手机必失败
  const { createPeer } = await import('../sync/store.js');
  const peer = createPeer('手机', `lsync_${'i'.repeat(24)}`);
  const preview = await app.inject({
    method: 'POST',
    url: '/api/ideas/preview',
    headers: { authorization: `Bearer ${peer.token}` },
    payload: { content: '北子所的样车尺寸待确认' },
  });
  assert.equal(preview.statusCode, 200, '成员令牌应能预览');
  assert.equal(preview.json().ok, true);

  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: { authorization: `Bearer ${peer.token}` },
    payload: { content: '北子所的样车尺寸待确认' },
  });
  assert.equal(res.statusCode, 200, '成员令牌应能落盘');
  assert.equal(res.json().ok, true);
});
