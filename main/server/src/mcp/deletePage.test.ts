import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-delete-'));
process.env.DATA_DIR = temp;

let db: any;
let client: any;
let writePage: (rel: string, content: string, extra?: any) => any;
let restoreTrashItem: (id: string) => any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage } = await import('../lib/vault.js'));
  ({ restoreTrashItem } = await import('../lib/trash.js'));
  const { makeServer } = await import('./server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'delete-page-test', version: '1.0.0' });
  await makeServer().connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  try { await client?.close(); } catch { /* already closed */ }
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

async function callDelete(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result: any = await client.callTool({ name: 'delete_page', arguments: args });
  return {
    text: (result.content || []).map((c: any) => c.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

function seedPage(rel: string, title: string, body = '正文'): string {
  const meta = writePage(rel, `# ${title}\n\n${body}\n`, { title });
  return meta.id;
}

test('MCP 工具表包含 delete_page，且描述说明只入回收站', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t: any) => t.name === 'delete_page');
  assert.ok(tool, 'delete_page 工具应已注册');
  assert.match(tool.description, /回收站/);
  assert.match(tool.description, /Wiki\//);
});

test('删除 Wiki 页面：软删除入回收站 + DB 标记 + 操作日志', async () => {
  const id = seedPage('Wiki/概念/待删概念.md', '待删概念');
  const before = db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(id) as { deleted: number };
  assert.equal(before.deleted, 0);

  const result = await callDelete({ titleOrId: '待删概念', reason: '误建页' });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /已移入回收站/);
  const trashId = /回收站条目 id: ([^\s）]+)/.exec(result.text)?.[1];
  assert.ok(trashId, `应返回回收站条目 id：${result.text}`);

  // 文件已移入 .trash，索引标记 deleted=1，原路径不再存在
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/概念/待删概念.md')), false);
  const row = db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(id) as { deleted: number };
  assert.equal(row.deleted, 1);

  // 操作日志自动追加，含原因
  const log = fs.readFileSync(path.join(temp, 'brain', 'AIWorks/log/log.md'), 'utf8');
  assert.match(log, /删除：\[\[待删概念\]\]/);
  assert.match(log, /已入回收站 · 原因：误建页/);

  // 软删除：可经回收站恢复，文件回到原位、索引复活
  const restored = restoreTrashItem(trashId);
  assert.equal(restored.path, 'Wiki/概念/待删概念.md');
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/概念/待删概念.md')), true);
  const revived = db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(id) as { deleted: number };
  assert.equal(revived.deleted, 0);
});

test('原始资料/ 下的页面拒删（只读区）', async () => {
  seedPage('原始资料/不可删资料.md', '不可删资料');
  const result = await callDelete({ titleOrId: '不可删资料' });
  assert.equal(result.isError, true);
  assert.match(result.text, /只读区/);
  assert.equal(fs.existsSync(path.join(temp, 'brain', '原始资料/不可删资料.md')), true);
});

test('AIWorks/ 下的页面拒删（只读区）', async () => {
  seedPage('AIWorks/临时笔记.md', '临时笔记');
  const result = await callDelete({ titleOrId: 'AIWorks/临时笔记.md' });
  assert.equal(result.isError, true);
  assert.match(result.text, /只读区/);
});

test('支持按页面路径删除（Wiki 路径）', async () => {
  seedPage('Wiki/概念/按路径删.md', '按路径删');
  const result = await callDelete({ titleOrId: 'Wiki/概念/按路径删.md' });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /已移入回收站/);
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/概念/按路径删.md')), false);
});

test('标题不唯一时拒绝，提示改用页面 ID 或路径', async () => {
  seedPage('Wiki/概念/同名页.md', '同名页');
  seedPage('Wiki/实体/同名页.md', '同名页');
  const result = await callDelete({ titleOrId: '同名页' });
  assert.equal(result.isError, true);
  assert.match(result.text, /请改用页面 ID 或页面路径/);
});

test('页面不存在时给出明确错误', async () => {
  const result = await callDelete({ titleOrId: '不存在的页面' });
  assert.equal(result.isError, true);
  assert.match(result.text, /页面不存在/);
});
