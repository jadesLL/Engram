import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-questions-'));
process.env.DATA_DIR = temp;

let db: any;
let client: any;
let app: ReturnType<typeof Fastify>;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();

  const { makeServer } = await import('./server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'ask-user-test', version: '1.0.0' });
  await makeServer().connect(serverTransport);
  await client.connect(clientTransport);

  const { questionRoutes } = await import('../routes/questions.js');
  app = Fastify();
  await app.register(jwt, { secret: 'ask-user-test-secret' });
  await app.register(questionRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  try { await app?.close(); } catch { /* already closed */ }
  try { await client?.close(); } catch { /* already closed */ }
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result: any = await client.callTool({ name, arguments: args });
  return {
    text: (result.content || []).map((c: any) => c.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

function questionRow(id: string): any {
  return db.prepare(`SELECT * FROM agent_questions WHERE id = ?`).get(id);
}

test('工具表包含 ask_user / list_questions，原有工具不消失', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes('ask_user'), 'ask_user 应已注册');
  assert.ok(names.includes('list_questions'), 'list_questions 应已注册');
  assert.ok(names.includes('write_page') && names.includes('kb_guide'), '原有工具不应消失');
});

test('空问题被拒', async () => {
  const result = await callTool('ask_user', { question: '   ' });
  assert.equal(result.isError, true, result.text);
});

test('ask_user 登记后 list_questions 可见（含背景与候选），DB 状态为 open', async () => {
  const asked = await callTool('ask_user', {
    question: '天津津亚电子的工商全名是哪个？',
    context: '调研报告写「津亚电子」，出货表写「天津津亚电子有限公司」',
    options: ['天津津亚电子有限公司', '天津津亚电子科技股份有限公司'],
  });
  assert.equal(asked.isError, false, asked.text);
  assert.match(asked.text, /已登记待确认问题 #([0-9a-f]{8})/);
  const id = asked.text.match(/#([0-9a-f]{8})/)![1];
  assert.equal(questionRow(id).status, 'open');

  const listed = await callTool('list_questions');
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /待答复/);
  assert.match(listed.text, /天津津亚电子的工商全名是哪个？/);
  assert.match(listed.text, /背景：调研报告写/);
  assert.match(listed.text, /候选：天津津亚电子有限公司 \/ 天津津亚电子科技股份有限公司/);
  assert.match(listed.text, /待答复 1 条/);
});

test('用户经界面接口答复后，list_questions 读到答复、待答复计数归零', async () => {
  const id = (db.prepare(`SELECT id FROM agent_questions WHERE status = 'open'`).get() as any).id;

  // 用户界面走 JWT；空答复被拒
  const empty = await app.inject({
    method: 'POST',
    url: `/api/questions/${id}/answer`,
    headers: { authorization: `Bearer ${token}` },
    payload: { answer: '  ' },
  });
  assert.equal(empty.statusCode, 400);

  const answered = await app.inject({
    method: 'POST',
    url: `/api/questions/${id}/answer`,
    headers: { authorization: `Bearer ${token}` },
    payload: { answer: '天津津亚电子有限公司' },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().open, 0);

  const listed = await callTool('list_questions');
  assert.match(listed.text, /已答复/);
  assert.match(listed.text, /用户答复：天津津亚电子有限公司/);
  assert.match(listed.text, /待答复 0 条/);

  const openOnly = await callTool('list_questions', { status: 'open' });
  assert.match(openOnly.text, /（没有待答复的问题）/);

  // 已答复后再读 open 清单为空，但 answered 清单仍有历史（Agent 换会话后不丢）
  const answeredOnly = await callTool('list_questions', { status: 'answered' });
  assert.match(answeredOnly.text, /用户答复：天津津亚电子有限公司/);
});

test('未授权访问待确认清单被拒', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/questions' });
  assert.equal(res.statusCode, 401);
});

test('指南 v3 契约：客户页含概览/核心机型，公司用工商全名，且点名新工具', async () => {
  const { AGENT_GUIDE, GUIDE_VERSION } = await import('../content/agentGuide.js');
  assert.equal(GUIDE_VERSION, 3);
  assert.match(AGENT_GUIDE, /概览\/核心机型/);
  assert.match(AGENT_GUIDE, /名称口径/);
  assert.match(AGENT_GUIDE, /工商全名/);
  assert.match(AGENT_GUIDE, /ask_user/);
  assert.match(AGENT_GUIDE, /list_questions/);
});
