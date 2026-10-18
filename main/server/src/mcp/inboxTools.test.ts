import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 收集箱的 MCP 面：外置 Agent（以及经同一条 MCP 的内置 Agent）能读收集箱、
 * 写转换产物，但**拿不到任何把它当知识库的通道**。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-inbox-'));
process.env.DATA_DIR = temp;

let db: any;
let client: any;
let BRAIN_DIR = '';

before(async () => {
  const config = await import('../config.js');
  BRAIN_DIR = config.BRAIN_DIR;
  config.ensureDirs();
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();

  const { makeServer } = await import('./server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'inbox-tools-test', version: '1.0.0' });
  await makeServer().connect(serverTransport);
  await client.connect(clientTransport);

  fs.writeFileSync(path.join(BRAIN_DIR, '收集箱', '合同.txt'), '合同金额 12 万，付款周期 30 天。\n');
  fs.writeFileSync(path.join(BRAIN_DIR, '收集箱', '随手记.md'), `# 随手记\n\n只存在于收集箱的句子。\n`);
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

test('四个收集箱工具都已注册，MCP instructions 指向一键转换', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool: any) => tool.name);
  for (const name of ['list_inbox', 'read_inbox_item', 'write_inbox_markdown', 'convert_inbox_item']) {
    assert.ok(names.includes(name), `${name} 应已注册`);
  }
  const instructions = client.getInstructions?.() || '';
  assert.match(instructions, /convert_inbox_item/);
});

test('list_inbox：列原件与转换状态，并明确声明不属于知识库', async () => {
  const result = await callTool('list_inbox');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /收集箱\/合同\.txt/);
  assert.match(result.text, /收集箱\/随手记\.md/);
  assert.match(result.text, /待整理/);
  assert.match(result.text, /不属于知识库|不在知识库/);
});

test('list_inbox：status 过滤生效', async () => {
  const pending = await callTool('list_inbox', { status: 'pending' });
  assert.match(pending.text, /合同\.txt/);
  const converted = await callTool('list_inbox', { status: 'converted' });
  assert.equal(converted.text.includes('合同.txt'), false);
});

test('read_inbox_item：文本原件直接返回正文；越界路径被拒', async () => {
  const ok = await callTool('read_inbox_item', { path: '收集箱/合同.txt' });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /付款周期 30 天/);

  fs.mkdirSync(path.join(BRAIN_DIR, '原始资料'), { recursive: true });
  fs.writeFileSync(path.join(BRAIN_DIR, '原始资料', '别人的.txt'), '不该被收集箱工具读到');
  const denied = await callTool('read_inbox_item', { path: '原始资料/别人的.txt' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /只能读取 收集箱\//);
});

test('write_inbox_markdown：产物落到 收集箱/转换结果/，且不建页面、不进检索', async () => {
  const written = await callTool('write_inbox_markdown', {
    path: '收集箱/合同.txt',
    markdown: '# 合同要点\n\n- 金额 12 万\n- 付款周期 30 天',
    note: 'MCP 通道写入',
  });
  assert.equal(written.isError, false, written.text);
  assert.match(written.text, /收集箱\/转换结果\/\d{4}\.\d{2}\.\d{2}_合同要点\.md/);
  assert.match(written.text, /未入库/);

  const name = /转换结果\/([^（]+\.md)/.exec(written.text)?.[1];
  assert.ok(name);
  const product = fs.readFileSync(path.join(BRAIN_DIR, '收集箱', '转换结果', name), 'utf8');
  assert.match(product, /来源: 收集箱\/合同\.txt/);
  assert.match(product, /MCP 通道写入/);

  const page = db.prepare(`SELECT id FROM pages WHERE path LIKE '收集箱/%'`).get();
  assert.equal(page, undefined, '产物不得被登记为页面');
  const { hybridSearch } = await import('../retrieval/hybrid.js');
  const hits = await hybridSearch('付款周期', 10);
  assert.equal(hits.some((hit: any) => String(hit.path).startsWith('收集箱/')), false);
});

test('write_inbox_markdown：重转按语义标题改名并移除同一原件旧产物', async () => {
  const written = await callTool('write_inbox_markdown', {
    path: '收集箱/合同.txt',
    markdown: '# 合同履约摘要\n\n- 付款周期 30 天',
    title: '合同履约摘要',
  });
  assert.equal(written.isError, false, written.text);
  const names = fs.readdirSync(path.join(BRAIN_DIR, '收集箱', '转换结果'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^\d{4}\.\d{2}\.\d{2}_合同履约摘要\.md$/);
});

test('知识库工具看不到收集箱：search / list_raw_files / list_pages 都不含它', async () => {
  const search = await callTool('search', { query: '只存在于收集箱的句子' });
  assert.equal(search.text.includes('收集箱'), false, 'search 不应命中收集箱内容');

  const raw = await callTool('list_raw_files');
  assert.equal(raw.text.includes('合同.txt'), false, '原始资料清单不应列出收集箱文件');

  const pages = await callTool('list_pages');
  assert.equal(pages.text.includes('收集箱'), false, '目录树不应出现收集箱');
});

test('收集箱内容不能当证据：write_page 带收集箱来源会被门禁拒绝', async () => {
  const result = await callTool('write_page', {
    path: 'Wiki/概念/越界取证.md',
    title: '越界取证',
    content: '# 越界取证\n\n测试用。',
    evidence: [{ path: '收集箱/合同.txt', quote: '付款周期 30 天' }],
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /收集箱|原始资料/);
});

test('kb_guide 与 skill 清单都带上收集箱纪律与转换 skill', async () => {
  const guide = await callTool('kb_guide');
  assert.match(guide.text, /收集箱/);

  const skills = await callTool('skill_list');
  assert.match(skills.text, /inbox-semantic-to-md/);

  const skill = await callTool('skill_guide', { name: 'inbox-semantic-to-md' });
  assert.equal(skill.isError, false, skill.text);
  assert.match(skill.text, /语义转换，不是格式搬运/);
});

test('kb_guide 把服务端一键转换列为收集箱的优先通道', async () => {
  const guide = await callTool('kb_guide');
  assert.match(guide.text, /convert_inbox_item/);
  assert.match(guide.text, /稳定分块/);
  assert.match(guide.text, /write_inbox_markdown/);
  assert.match(guide.text, /仍不属于知识库|不属于知识库/);
});

test('convert_inbox_item：非收集箱路径与转换产物路径都拒绝', async () => {
  const outside = await callTool('convert_inbox_item', { path: '原始资料/别人的.txt' });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /只能转换 收集箱\//);

  const derived = await callTool('convert_inbox_item', { path: '收集箱/转换结果/旧产物.md' });
  assert.equal(derived.isError, true);
  assert.match(derived.text, /不能是转换产物/);
});

test('convert_inbox_item：原件不存在给可读错误', async () => {
  const result = await callTool('convert_inbox_item', { path: '收集箱/没有这个.txt' });
  assert.equal(result.isError, true);
  assert.match(result.text, /原件不存在/);
});

test('convert_inbox_item：Agent-only 格式明确拒绝并给可读原因', async () => {
  fs.writeFileSync(path.join(BRAIN_DIR, '收集箱', '照片.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const result = await callTool('convert_inbox_item', { path: '收集箱/照片.png' });
  assert.equal(result.isError, true);
  assert.match(result.text, /需要 Agent 通道/);
  assert.match(result.text, /图片识别|音视频/);
});

test('convert_inbox_item：未配置模型凭据时给出可操作错误', async () => {
  const result = await callTool('convert_inbox_item', { path: '收集箱/合同.txt' });
  assert.equal(result.isError, true);
  assert.match(result.text, /未配置模型凭据/);
  assert.match(result.text, /设置 → Agent 接入/);
});

test('convert_inbox_item：服务端管道转换成功，产物留在收集箱、不入库不建页', async () => {
  const { setAgentConfig } = await import('../assistant/config.js');
  setAgentConfig({ apiKey: 'test-key', model: 'test-model' });

  const realFetch = (globalThis as any).fetch;
  const requests: any[] = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    const system = String(body.messages?.[0]?.content ?? body.instructions ?? '');
    // 正文请求走 skill body；文件名请求的 system 是归档员提示词
    const content = /资料归档员/.test(system)
      ? '合同履约摘要'
      : '# 合同履约摘要\n\n本文概要：一份采购合同的关键条款。\n\n- 金额 12 万\n- 付款周期 30 天\n\n## 待确认\n\n无\n\n## 原件信息\n\n合同.txt，纯文本';
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { completion_tokens: 120, total_tokens: 220 },
      }),
    };
  };
  try {
    const result = await callTool('convert_inbox_item', { path: '收集箱/合同.txt' });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /收集箱\/转换结果\/\d{4}\.\d{2}\.\d{2}_合同履约摘要\.md/);
    assert.match(result.text, /不属于知识库/);
    assert.match(result.text, /入库/);
    assert.match(result.text, /test-model/);
    assert.ok(requests.length >= 2, `应至少发正文与文件名两次请求，实际 ${requests.length}`);

    const derived = /转换结果\/([^\s（(]+\.md)/.exec(result.text)?.[1];
    assert.ok(derived, result.text);
    const product = fs.readFileSync(path.join(BRAIN_DIR, '收集箱', '转换结果', derived), 'utf8');
    assert.match(product, /来源: 收集箱\/合同\.txt/);
    assert.match(product, /金额 12 万/);
    assert.match(product, /转换版本: /);

    const page = db.prepare(`SELECT id FROM pages WHERE path LIKE '收集箱/%'`).get();
    assert.equal(page, undefined, '产物不得被登记为页面');
    const { hybridSearch } = await import('../retrieval/hybrid.js');
    const hits = await hybridSearch('合同履约摘要', 10);
    assert.equal(hits.some((hit: any) => String(hit.path).startsWith('收集箱/')), false);
  } finally {
    (globalThis as any).fetch = realFetch;
    setAgentConfig({ apiKey: undefined, model: undefined } as any);
  }
});
