import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-tools-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let writePage: (rel: string, content: string, extra?: any) => any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));
  ({ writePage } = await import('../lib/vault.js'));

  const { agentToolRoutes } = await import('./agentTools.js');
  const { guideRoutes } = await import('./guide.js');
  app = Fastify();
  await app.register(jwt, { secret: 'agent-tools-test-secret' });
  await app.register(agentToolRoutes);
  await app.register(guideRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function request(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { authorization: 'Bearer ' + token },
    ...(payload ? { payload } : {}),
  });
}

function brainPath(rel: string): string {
  return path.join(temp, 'brain', rel);
}

/* ---------------------------------------------------------------- ask */

test('POST /api/agent/ask 没有活跃对话时返回 200 + no_active_run（不阻塞等待）', async () => {
  const res = await request('POST', '/api/agent/ask', {
    questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'no_active_run');
  assert.equal(body.questions.length, 0);
  assert.match(body.text, /没有正在运行的/);
});

test('POST /api/agent/ask 空 questions 被拒（400）', async () => {
  const res = await request('POST', '/api/agent/ask', { questions: [] });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /至少要有一个问题/);
});

/* ---------------------------------------------------------------- skills */

test('GET /api/agent/skills 返回作业手法 + 两份安装型 skill 的元数据', async () => {
  const res = await request('GET', '/api/agent/skills');
  assert.equal(res.statusCode, 200);
  const skills = res.json().skills as any[];
  const names = skills.map((skill) => skill.name);
  for (const expected of [
    'docx-meeting-to-md',
    'kb-ingest-discipline',
    'inbox-semantic-to-md',
    'research-raw-material',
    'customer-research',
    // 装在客户端 skills 目录的两份，也能经 engram skill list/show 读到（指南与 prompts 会引用）
    'engram',
    'engram-customer-research',
  ]) {
    assert.ok(names.includes(expected), '缺少 skill: ' + expected);
  }
  for (const skill of skills) {
    assert.ok(skill.title && skill.description && skill.whenToUse);
    assert.equal(typeof skill.version, 'number');
    assert.equal(skill.body, undefined, '清单不应带正文');
  }
});

test('GET /api/agent/skills/:name 返回全文；未知名称 404 且附可用清单', async () => {
  const ok = await request('GET', '/api/agent/skills/research-raw-material');
  assert.equal(ok.statusCode, 200);
  const skill = ok.json();
  assert.equal(skill.name, 'research-raw-material');
  assert.ok(String(skill.body).length > 100);

  // 安装型 skill：正文里的 {{ENGRAM}} 回显为通用 engram 命令（客户端安装时替换成自己的完整命令）
  const installed = await request('GET', '/api/agent/skills/engram');
  assert.equal(installed.statusCode, 200);
  const installedSkill = installed.json();
  assert.equal(installedSkill.name, 'engram');
  assert.ok(String(installedSkill.body).includes('engram status'));
  assert.equal(String(installedSkill.body).includes('{{ENGRAM}}'), false);

  const missing = await request('GET', '/api/agent/skills/not-a-skill');
  assert.equal(missing.statusCode, 404);
  const body = missing.json();
  assert.match(body.error, /未找到 skill/);
  assert.ok(Array.isArray(body.available) && body.available.includes('research-raw-material'));
  assert.ok(body.available.includes('engram'));
});

/* ---------------------------------------------------------------- pages */

test('GET /api/agent/pages/tree 沿用旧 list_pages 口径（规则版本 + path 过滤）', async () => {
  writePage('Wiki/概念/工具页.md', '# 工具页\n\n正文\n', { title: '工具页' });
  const res = await request('GET', '/api/agent/pages/tree?path=' + encodeURIComponent('Wiki/概念'));
  assert.equal(res.statusCode, 200);
  const text = String(res.json().text);
  assert.match(text, /工具页/);
  assert.match(text, /规则v/);
  assert.ok(!text.includes('Wiki/实体'), 'path 过滤应排除其它目录');

  const none = await request('GET', '/api/agent/pages/tree?tag=' + encodeURIComponent('不存在的标签'));
  assert.match(String(none.json().text), /无匹配页面/);
});

test('GET /api/agent/pages/related 返回图谱关联；未知页面 404', async () => {
  writePage('Wiki/实体/关联源.md', '# 关联源\n\n参见 [[关联目标]]\n', { title: '关联源' });
  writePage('Wiki/实体/关联目标.md', '# 关联目标\n\n正文\n', { title: '关联目标' });
  const res = await request('GET', '/api/agent/pages/related?titleOrId=' + encodeURIComponent('关联源'));
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.ok(Array.isArray(data.neighbors));
  assert.ok(Array.isArray(data.entities));

  const missing = await request('GET', '/api/agent/pages/related?titleOrId=' + encodeURIComponent('没有这个页面'));
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /页面不存在/);
});

/* ---------------------------------------------------------------- 原始资料 */

test('GET /api/agent/file mode=text 返回 md 正文（带 # 标题），非 原始资料 路径被拒', async () => {
  writePage('原始资料/文档/调研笔记.md', '# 调研笔记\n\n结论正文\n', { title: '调研笔记' });
  const res = await request('GET', '/api/agent/file?path=' + encodeURIComponent('原始资料/文档/调研笔记.md'));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.kind, 'text');
  assert.match(body.text, /# 调研笔记/);
  assert.match(body.text, /结论正文/);

  const forbidden = await request('GET', '/api/agent/file?path=' + encodeURIComponent('Wiki/概念/工具页.md'));
  assert.equal(forbidden.statusCode, 400);
  assert.match(forbidden.json().error, /原始资料/);
});

test('GET /api/agent/file mode=raw 返回原字节 + Content-Type', async () => {
  const rel = '原始资料/文档/原始字节.bin';
  fs.mkdirSync(path.dirname(brainPath(rel)), { recursive: true });
  fs.writeFileSync(brainPath(rel), Buffer.from([0, 1, 2, 3, 255]));
  const res = await request('GET', '/api/agent/file?path=' + encodeURIComponent(rel) + '&mode=raw');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/octet-stream/);
  assert.deepEqual([...res.rawPayload], [0, 1, 2, 3, 255]);
});

test('POST /api/agent/raw-material 新建原始资料；已存在路径拒绝覆盖', async () => {
  const payload = {
    path: '原始资料/文档/Agent 调研成果.md',
    content: '# 调研成果\n\n正文内容\n',
  };
  const res = await request('POST', '/api/agent/raw-material', payload);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.path, '原始资料/文档/Agent 调研成果.md');
  assert.ok(body.id);
  assert.ok(fs.existsSync(brainPath(body.path)));
  assert.match(body.text, /已新建原始资料/);

  const again = await request('POST', '/api/agent/raw-material', payload);
  assert.equal(again.statusCode, 400);
  assert.match(again.json().error, /拒绝覆盖/);

  const bad = await request('POST', '/api/agent/raw-material', { path: '原始资料/对话/不该写.md', content: 'x' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /save_chat/);
});

/* ---------------------------------------------------------------- 收集箱 */

test('GET /api/agent/inbox/item mode=text 读文本原件；mode=raw 返回原字节', async () => {
  const rel = '收集箱/会议记录.md';
  fs.mkdirSync(path.dirname(brainPath(rel)), { recursive: true });
  fs.writeFileSync(brainPath(rel), '# 会议记录\n\n讨论内容\n', 'utf8');

  const text = await request('GET', '/api/agent/inbox/item?path=' + encodeURIComponent(rel) + '&mode=text');
  assert.equal(text.statusCode, 200);
  const body = text.json();
  assert.equal(body.kind, 'text');
  assert.match(body.text, /讨论内容/);

  const raw = await request('GET', '/api/agent/inbox/item?path=' + encodeURIComponent(rel) + '&mode=raw');
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.rawPayload.toString('utf8'), '# 会议记录\n\n讨论内容\n');

  const outside = await request('GET', '/api/agent/inbox/item?path=' + encodeURIComponent('原始资料/文档/调研笔记.md'));
  assert.equal(outside.statusCode, 400);
  assert.match(outside.json().error, /只能读取 收集箱/);
});

test('GET /api/agent/inbox/items 返回清单与计数；POST /api/agent/inbox/add 新建文本原件', async () => {
  const list = await request('GET', '/api/agent/inbox/items?status=pending&limit=50');
  assert.equal(list.statusCode, 200);
  const listing = list.json();
  assert.ok(listing.items.length >= 1);
  assert.equal(listing.status, 'pending');
  assert.ok(listing.counts.all >= listing.items.length);

  const rel = '收集箱/随手记.md';
  const added = await request('POST', '/api/agent/inbox/add', {
    path: rel,
    content: '# 随手记\n\n想法一条\n',
  });
  assert.equal(added.statusCode, 200);
  assert.equal(added.json().path, rel);
  assert.ok(fs.existsSync(brainPath(rel)));
  assert.match(added.json().text, /还不属于知识库/);

  const duplicate = await request('POST', '/api/agent/inbox/add', { path: rel, content: '再来一份' });
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.json().error, /拒绝覆盖/);
});

test('POST /api/agent/inbox/write 写转换产物；非 收集箱 路径被拒', async () => {
  const source = '收集箱/待提炼.md';
  fs.mkdirSync(path.dirname(brainPath(source)), { recursive: true });
  fs.writeFileSync(brainPath(source), '# 原件\n\n正文\n', 'utf8');
  const res = await request('POST', '/api/agent/inbox/write', {
    path: source,
    markdown: '# 提炼结果\n\n要点\n',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.derivedPath, /^收集箱\/转换结果\//);
  assert.match(body.text, /未入库/);

  const outside = await request('POST', '/api/agent/inbox/write', {
    path: '原始资料/文档/调研笔记.md',
    markdown: '# x\n',
  });
  assert.equal(outside.statusCode, 400);
});

/* ---------------------------------------------------------------- 资产与信息 */

test('GET /api/agent/asset 非法引用 / SVG 回 JSON 错误', async () => {
  const bad = await request('GET', '/api/agent/asset?path=' + encodeURIComponent('not-a-media-ref'));
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /不是本库的图片引用/);
});

test('GET /api/agent/cli 返回 cli.js 源码；未构建时给出明确 500', async () => {
  // verify 的 Docker 链路先 build 再 test（dist 存在）；本地离线兜底可能先 test 后 build。
  const built = fs.existsSync(path.join(process.cwd(), 'dist', 'cli', 'cli.js'))
    || fs.existsSync(path.join(process.cwd(), 'server', 'dist', 'cli', 'cli.js'));
  const res = await request('GET', '/api/agent/cli');
  if (built) {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.match(res.body, /Engram CLI/);
  } else {
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /CLI 源文件不存在/);
  }
});

/* ---------------------------------------------------------------- 调研 */

test('POST /api/agent/research/begin 建立任务；submit 缺 taskId 返回 400', async () => {
  const begin = await request('POST', '/api/agent/research/begin', { customer: '测试客户' });
  assert.equal(begin.statusCode, 200);
  const task = begin.json();
  assert.ok(task.taskId);
  assert.ok(String(task.workflow).length > 0);
  assert.ok(task.reportContract && Array.isArray(task.reportContract.modeSections.full));

  const bad = await request('POST', '/api/agent/research/submit', { sections: {}, sources: [] });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /taskId/);
});

test('POST /api/agent/inbox/convert 非收集箱路径被拒（不触发转换）', async () => {
  const res = await request('POST', '/api/agent/inbox/convert', { path: '原始资料/文档/调研笔记.md' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /只能转换 收集箱/);
});
