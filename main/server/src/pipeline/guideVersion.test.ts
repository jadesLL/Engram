import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-guide-version-'));
process.env.DATA_DIR = temp;

let db: any;
let writePage: (rel: string, content: string, extra?: any) => any;
let agentWritePage: (input: any) => any;
let listTree: () => any[];
let GUIDE_VERSION: number;
let app: ReturnType<typeof Fastify>;
let token = '';

const SOURCE = '原始资料/版本实验源.md';
const PAGE = 'Wiki/实体/信捷科技.md';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage, listTree } = await import('../lib/vault.js'));
  ({ agentWritePage } = await import('./agentWrite.js'));
  ({ GUIDE_VERSION } = await import('../content/agentGuide.js'));

  const { pageRoutes } = await import('../routes/pages.js');
  app = Fastify();
  await app.register(jwt, { secret: 'guide-version-test-secret' });
  await app.register(pageRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });

  writePage(SOURCE, '# 版本实验源\n\n信捷科技2026年签约。信捷科技主营自动化设备。', { title: '版本实验源' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function writeAgentPage(target = PAGE) {
  return agentWritePage({
    path: target,
    title: target.replace(/\.md$/, '').split('/').pop()!,
    type: 'org',
    content: `# 信捷科技\n\n## 当前理解\n\n自动化设备厂商。\n`,
    evidence: [
      { path: SOURCE, quote: '信捷科技2026年签约' },
      { path: SOURCE, quote: '信捷科技主营自动化设备' },
    ],
  });
}

test('Agent 写页把指南版本记入索引库；正文/frontmatter 不携带版本', () => {
  const result = writeAgentPage();
  assert.equal(result.guideVersion, GUIDE_VERSION);
  const row = db.prepare(`SELECT guide_version FROM pages WHERE path = ?`).get(PAGE);
  assert.equal(row.guide_version, GUIDE_VERSION);

  // 用户约束：版本只进索引库，页面文件（frontmatter + 正文）不得出现版本痕迹
  const onDisk = fs.readFileSync(path.join(temp, 'brain', PAGE), 'utf8');
  assert.ok(!onDisk.includes('guide_version'));
  assert.ok(!onDisk.includes('指南版本'));
});

test('目录树页面节点带 guide_version', () => {
  const flat = (nodes: any[]): any[] =>
    nodes.flatMap((n) => (n.kind === 'page' ? [n] : n.children ? flat(n.children) : []));
  const pages = flat(listTree());
  const hit = pages.find((p) => p.path === PAGE);
  assert.equal(hit.guide_version, GUIDE_VERSION);
});

test('outdated 过滤：存量旧行（版本 0）列出，新写页不列；Agent 重写后升级退出清单', async () => {
  // 模拟存量库升级：补列后旧页面 guide_version=0
  writePage('Wiki/概念/旧规则页.md', '# 旧规则页\n\n旧规则写成的一段话。', { title: '旧规则页' });

  const getOutdated = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/pages/list?outdated=true',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().guideVersion, GUIDE_VERSION);
    return res.json().pages.map((p: any) => p.path);
  };

  let outdated = await getOutdated();
  assert.ok(outdated.includes('Wiki/概念/旧规则页.md'));
  assert.ok(!outdated.includes(PAGE));
  // 原始资料只读不改：md 源文件虽也是 pages 行，但不得进入重提炼清单
  assert.ok(!outdated.includes(SOURCE));

  // 按新规则重提炼 = Agent 重新覆盖写 → 版本刷新，退出落后清单
  writeAgentPage('Wiki/概念/旧规则页.md');
  outdated = await getOutdated();
  assert.ok(!outdated.includes('Wiki/概念/旧规则页.md'));
});
