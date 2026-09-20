import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-entity-name-'));
process.env.DATA_DIR = temp;

let db: any;
let client: any;
let kernel: typeof import('../lib/entityNameChecks.js');
let writePage: (rel: string, content: string, extra?: any) => any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage } = await import('../lib/vault.js'));
  kernel = await import('../lib/entityNameChecks.js');
  const { makeServer } = await import('./server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'entity-name-test', version: '1.0.0' });
  await makeServer().connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  try { await client?.close(); } catch { /* already closed */ }
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result: any = await client.callTool({ name, arguments: args });
  return {
    text: (result.content || []).map((c: any) => c.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

function seedPage(rel: string, title: string, extra: Record<string, unknown> = {}): string {
  return writePage(rel, `# ${title}\n\n正文\n`, { title, ...extra }).id as string;
}

test('工具表包含四个名称核验工具，且描述写清「全库唯一允许问用户的事」', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t: any) => t.name);
  for (const name of ['entity_name_check', 'entity_name_propose', 'list_entity_names', 'entity_name_audit']) {
    assert.ok(names.includes(name), `${name} 应已注册`);
  }
  const check = tools.find((t: any) => t.name === 'entity_name_check');
  assert.match(check.description, /企查查/);
  assert.match(check.description, /天眼查/);
  const propose = tools.find((t: any) => t.name === 'entity_name_propose');
  assert.match(propose.description, /服务端执行改名/);
});

test('entity_name_check：资料库有全名直接返回，不登记请示', async () => {
  seedPage('Wiki/实体/天津津亚电子有限公司.md', '天津津亚电子有限公司');
  const result = await callTool('entity_name_check', { entity: '津亚电子' });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /资料库里已有全名/);
  assert.match(result.text, /天津津亚电子有限公司/);
  assert.match(result.text, /rename_page/);
  assert.doesNotMatch(result.text, /已在 Engram 界面「名称核验」请示用户/);
});

test('entity_name_check → 用户允许 → propose → 用户确认 → 改名落地', async () => {
  const id = seedPage('Wiki/实体/宏远精密.md', '宏远精密');
  seedPage('Wiki/概念/供应商评估.md', '供应商评估', { type: 'note' });

  const checked = await callTool('entity_name_check', {
    entity: '宏远精密',
    titleOrId: id,
    note: '材料里只有简称',
  });
  assert.equal(checked.isError, false, checked.text);
  assert.match(checked.text, /已登记名称核验 #/);
  assert.match(checked.text, /不要空等/);
  const checkId = /已登记名称核验 #([0-9a-f]+)/.exec(checked.text)?.[1];
  assert.ok(checkId, `应返回核验 id：${checked.text}`);

  // 用户还没答复就回填 → 拒绝
  const tooEarly = await callTool('entity_name_propose', { id: checkId, fullName: '天津宏远精密机械有限公司' });
  assert.equal(tooEarly.isError, true);
  assert.match(tooEarly.text, /用户尚未答复/);

  // 界面清单里能看到这条待答复
  const pending = await callTool('list_entity_names', { status: 'pending' });
  assert.match(pending.text, /宏远精密/);
  assert.match(pending.text, /待用户答复是否允许联网查企查查\/天眼查/);

  // 用户点「允许联网查询」
  kernel.answerEntityNameCheck(checkId!, 'allow');

  const proposed = await callTool('entity_name_propose', {
    id: checkId,
    fullName: '天津宏远精密机械有限公司',
    source: 'https://www.qcc.com/firm/abc.html',
  });
  assert.equal(proposed.isError, false, proposed.text);
  assert.match(proposed.text, /已登记改名请示/);
  assert.match(proposed.text, /天津宏远精密机械有限公司/);

  // 用户点「改用全名」→ 服务端执行改名
  const done = kernel.answerEntityNameCheck(checkId!, 'allow');
  assert.equal(done.outcome, 'renamed');

  const row = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(id) as any;
  assert.equal(row.title, '天津宏远精密机械有限公司');
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/实体/天津宏远精密机械有限公司.md')), true);

  // 清单里已办结，且不再进 pending
  const list = await callTool('list_entity_names', { status: 'all' });
  assert.match(list.text, /已改用全名/);
  const pendingAfter = await callTool('list_entity_names', { status: 'pending' });
  assert.doesNotMatch(pendingAfter.text, /宏远精密/);
});

test('用户不同意联网查询：办结并进「最终不是全名」清单', async () => {
  const checked = await callTool('entity_name_check', { entity: '拒绝核验客户' });
  const checkId = /已登记名称核验 #([0-9a-f]+)/.exec(checked.text)?.[1];
  assert.ok(checkId);
  kernel.answerEntityNameCheck(checkId!, 'deny');

  const unresolved = await callTool('list_entity_names', { status: 'unresolved' });
  assert.match(unresolved.text, /拒绝核验客户/);
  assert.match(unresolved.text, /用户不同意联网查询/);

  // 再次登记同一名称：不重复请示，直接告知已办结
  const again = await callTool('entity_name_check', { entity: '拒绝核验客户' });
  assert.equal(again.isError, false, again.text);
  assert.match(again.text, /不再重复请示用户/);
});

test('查不到全名：propose 不传 fullName 即按未找到办结', async () => {
  const checked = await callTool('entity_name_check', { entity: '查无结果客户' });
  const checkId = /已登记名称核验 #([0-9a-f]+)/.exec(checked.text)?.[1];
  assert.ok(checkId);
  kernel.answerEntityNameCheck(checkId!, 'allow');
  const closed = await callTool('entity_name_propose', { id: checkId, note: '企查查只有同名近似主体' });
  assert.equal(closed.isError, false, closed.text);
  assert.match(closed.text, /未找到全名/);
  const unresolved = await callTool('list_entity_names', { status: 'unresolved' });
  assert.match(unresolved.text, /查无结果客户/);
});

test('回填不像全名的写法被拒绝，并提示以企查查能否查到为准', async () => {
  const checked = await callTool('entity_name_check', { entity: '简称客户' });
  const checkId = /已登记名称核验 #([0-9a-f]+)/.exec(checked.text)?.[1];
  assert.ok(checkId);
  kernel.answerEntityNameCheck(checkId!, 'allow');
  const bad = await callTool('entity_name_propose', { id: checkId, fullName: '简称客户' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /不像工商登记全名/);
  assert.match(bad.text, /企查查/);
});

test('entity_name_audit：列出标题不是全名形态的公司页', async () => {
  seedPage('Wiki/实体/待核客户.md', '待核客户', { type: 'customer' });
  seedPage('Wiki/实体/上海待核科技有限公司.md', '上海待核科技有限公司', { type: 'customer' });
  const audit = await callTool('entity_name_audit');
  assert.equal(audit.isError, false, audit.text);
  assert.match(audit.text, /待核客户/);
  assert.doesNotMatch(audit.text, /上海待核科技有限公司/);
});

test('list_entity_names 空清单给明确提示', async () => {
  const empty = await callTool('list_entity_names', { status: 'pending' });
  assert.equal(empty.isError, false, empty.text);
  assert.match(empty.text, /没有等用户答复的名称核验|待答复 0 条/);
});
