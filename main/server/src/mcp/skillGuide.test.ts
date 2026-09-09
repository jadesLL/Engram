import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-skill-'));
process.env.DATA_DIR = temp;

let db: any;
let client: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { makeServer } = await import('./server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'skill-guide-test', version: '1.0.0' });
  await makeServer().connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
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

test('工具表包含 skill_list / skill_guide，且都是读工具', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes('skill_list'), 'skill_list 应已注册');
  assert.ok(names.includes('skill_guide'), 'skill_guide 应已注册');
  assert.ok(names.includes('kb_guide'), '原有 kb_guide 不应消失');
});

test('skill_list 只回元数据：含名称/用途/何时用/版本，不含正文', async () => {
  const result = await callTool('skill_list');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /docx-meeting-to-md/);
  assert.match(result.text, /kb-ingest-discipline/);
  assert.match(result.text, /用途：/);
  assert.match(result.text, /何时用：/);
  assert.match(result.text, /v1/);
  // 正文不应随清单下发（否则 skill 变多会灌满上下文）
  assert.doesNotMatch(result.text, /## 一、结构转换/);
  assert.match(result.text, /skill_guide/);
});

test('skill_guide 按名取全文；大小写容错', async () => {
  const result = await callTool('skill_guide', { name: 'docx-meeting-to-md' });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /# Word 纪要转 Markdown/);
  assert.match(result.text, /错别字四类判据/);
  assert.match(result.text, /代词不是人名/);

  const upper = await callTool('skill_guide', { name: 'DOCX-MEETING-TO-MD' });
  assert.equal(upper.isError, false, upper.text);
  assert.match(upper.text, /错别字四类判据/);
});

test('skill_guide 未知名称：报错并给出可用清单', async () => {
  const result = await callTool('skill_guide', { name: 'nope' });
  assert.equal(result.isError, true);
  assert.match(result.text, /未找到 skill: nope/);
  assert.match(result.text, /docx-meeting-to-md/);
});

test('MCP instructions 指向 skill 工具并声明对话沉积触发条件', async () => {
  const instructions = client.getInstructions?.() || '';
  assert.match(instructions, /skill_list/);
  assert.match(instructions, /skill_guide/);
  assert.match(instructions, /先问用户/);
  assert.match(instructions, /save_chat/);
});

test('指南正文：原始资料口径为「Agent 无写权限 + 须用户授权」，且沉淀须指示', async () => {
  const result = await callTool('kb_guide');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /没有写权限/);
  assert.match(result.text, /先问用户/);
  assert.match(result.text, /不得走 HTTP\/CLI 旁路/);
  assert.match(result.text, /save_chat）须用户指示/);
  assert.match(result.text, /可被后续作业当资料提炼/);
  // 旧的错误口径不应残留
  assert.doesNotMatch(result.text, /原始资料只读不改/);
});
