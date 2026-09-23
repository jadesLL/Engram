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
  assert.match(instructions, /不要卡住整批作业/);
  assert.match(instructions, /save_chat/);
});

test('指南正文：原始资料仅允许用户授权的新建调研入口，且对话沉淀须指示', async () => {
  const result = await callTool('kb_guide');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /create_raw_material/);
  assert.match(result.text, /拒绝覆盖已有路径/);
  assert.match(result.text, /原始资料\/对话\/ 专供 save_chat/);
  assert.match(result.text, /不要停下来等用户/);
  assert.match(result.text, /待核实/);
  assert.match(result.text, /不得走 HTTP\/CLI 旁路/);
  assert.match(result.text, /save_chat）须用户指示/);
  assert.match(result.text, /可被后续作业当资料提炼/);
  // 「问用户」只出现在公司全名那条例外里，且没有旧的待确认问题通道
  assert.doesNotMatch(result.text, /list_questions|待确认问题/);
  assert.doesNotMatch(result.text, /原始资料只读不改/);
});

test('指南正文：公司全名问在对话里，且写明是全库唯一允许问用户的事', async () => {
  const result = await callTool('kb_guide');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /名称核验/);
  assert.match(result.text, /全库唯一允许问用户的事/);
  assert.match(result.text, /企查查/);
  assert.match(result.text, /entity_name_check/);
  assert.match(result.text, /entity_name_answer/);
  assert.match(result.text, /entity_name_propose/);
  assert.match(result.text, /list_entity_names/);
  // 问法：内置 Agent 用 ask_user 弹底部选项，外部 Agent 用自带提问能力
  assert.match(result.text, /ask_user/);
  assert.match(result.text, /对话最下侧/);
  // 全名的界定与「不编造、不自行改名」的红线
  assert.match(result.text, /全名的界定/);
  assert.match(result.text, /不得编造或推测全名/);
  assert.match(result.text, /由服务端执行改名/);
  assert.match(result.text, /不追问、不反复请示/);
  assert.match(result.text, /最终不是全名/);
});

test('MCP instructions 交代名称核验通道、对话提问与联网检索分工', () => {
  const instructions = client.getInstructions?.() || '';
  assert.match(instructions, /entity_name_check/);
  assert.match(instructions, /entity_name_answer/);
  assert.match(instructions, /entity_name_propose/);
  assert.match(instructions, /list_entity_names/);
  assert.match(instructions, /ask_user/);
  assert.match(instructions, /企查查/);
});
