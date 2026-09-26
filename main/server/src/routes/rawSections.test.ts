/**
 * 原始资料二级分类（文档 / 对话 / 灵感碎片）的路径判定与文件列表分组。
 *
 * 覆盖三件事：
 *  1. rawSections 的判定：根目录历史资料算「文档」，对话/灵感碎片按目录归属；
 *  2. /api/files/list?section= 的分组结果（doc 额外带上根目录历史文件并标 legacy）；
 *  3. 新建的默认落点，以及「对话」目录不可被普通新建写入。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-raw-sections-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let BRAIN_DIR = '';
let rawSections: typeof import('../lib/rawSections.js');

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ BRAIN_DIR } = await import('../config.js'));
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  rawSections = await import('../lib/rawSections.js');
  const { fileRoutes } = await import('./files.js');
  app = Fastify();
  await app.register(jwt, { secret: 'raw-sections-test-secret' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(fileRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

test('二级分类定义：固定三个，顺序即展示顺序', () => {
  const { RAW_SECTIONS, DEFAULT_RAW_DIR, RAW_DOC_DIR, RAW_CHAT_DIR, RAW_IDEA_DIR } = rawSections;
  assert.deepEqual(RAW_SECTIONS.map((s) => s.label), ['文档', '对话', '灵感碎片']);
  assert.equal(DEFAULT_RAW_DIR, RAW_DOC_DIR);
  assert.equal(RAW_DOC_DIR, '原始资料/文档');
  assert.equal(RAW_CHAT_DIR, '原始资料/对话');
  assert.equal(RAW_IDEA_DIR, '原始资料/灵感碎片');
});

test('固定目录与上传白名单都包含三个二级目录', async () => {
  const { FIXED_DIRS, UPLOAD_DIRS } = await import('../config.js');
  const { RAW_DOC_DIR, RAW_CHAT_DIR, RAW_IDEA_DIR, isRawSectionDir, rawSectionByKey } = rawSections;
  for (const dir of [RAW_DOC_DIR, RAW_CHAT_DIR, RAW_IDEA_DIR]) {
    assert.equal((FIXED_DIRS as readonly string[]).includes(dir), true, `${dir} 应在 FIXED_DIRS`);
    assert.equal((UPLOAD_DIRS as readonly string[]).includes(dir), true, `${dir} 应可上传`);
    assert.equal(fs.existsSync(path.join(BRAIN_DIR, dir)), true, `${dir} 应已建出`);
  }
  assert.equal(isRawSectionDir('原始资料/文档'), true);
  assert.equal(isRawSectionDir('原始资料/别的目录'), false);
  assert.equal(rawSectionByKey('idea')?.dir, RAW_IDEA_DIR);
});

test('路径判定：根目录历史资料算文档，三个二级目录各归其类', () => {
  const { rawSectionOf, isRawPath, isRawChatPath, RAW_ROOT } = rawSections;
  assert.equal(rawSectionOf('原始资料/2026.09.01_纪要.md'), 'doc', '根目录历史文件视作文档');
  assert.equal(rawSectionOf('原始资料/文档/纪要.md'), 'doc');
  assert.equal(rawSectionOf('原始资料/文档/2026/纪要.md'), 'doc', '文档下的子目录仍是文档');
  assert.equal(rawSectionOf('原始资料/对话/北自科技/记录.md'), 'chat');
  assert.equal(rawSectionOf('原始资料/灵感碎片/想法.md'), 'idea');
  assert.equal(rawSectionOf('原始资料/assets/abc/图.png'), null, '图片资产不属于任何分类');
  assert.equal(rawSectionOf('Wiki/概念/x.md'), null);

  assert.equal(isRawPath('原始资料/文档/x.md'), true);
  assert.equal(isRawPath('原始资料'), true);
  assert.equal(isRawPath('原始资料x/y.md'), false);
  assert.equal(isRawChatPath('原始资料/对话/项目/x.md'), true);
  assert.equal(isRawChatPath('原始资料/文档/对话.md'), false);
  assert.equal(RAW_ROOT, '原始资料');
});

test('文件列表按二级分类分组：文档带上根目录历史文件并标 legacy', async () => {
  const { writePage } = await import('../lib/vault.js');
  writePage('原始资料/2026.05.08_京东发货流程.md', '# 京东发货流程\n\n正文\n', { title: '京东发货流程' });
  writePage('原始资料/文档/2026.09.01_专题会.md', '# 专题会\n\n正文\n', { title: '专题会' });
  writePage('原始资料/对话/北自科技/2026.09.09_通话.md', '# 通话\n\n正文\n', { title: '通话' });
  writePage('原始资料/灵感碎片/2026.08.16_人员架构.md', '# 人员架构\n\n正文\n', { title: '人员架构' });

  const doc = (await app.inject({
    url: '/api/files/list?section=doc', headers: auth(),
  })).json().files;
  assert.deepEqual(doc.map((f: any) => f.path).sort(), [
    '原始资料/2026.05.08_京东发货流程.md',
    '原始资料/文档/2026.09.01_专题会.md',
  ]);
  assert.equal(doc.find((f: any) => f.path.startsWith('原始资料/文档/')).legacy, false);
  assert.equal(doc.find((f: any) => f.path === '原始资料/2026.05.08_京东发货流程.md').legacy, true);

  const chat = (await app.inject({
    url: '/api/files/list?section=chat', headers: auth(),
  })).json().files;
  assert.deepEqual(chat.map((f: any) => f.path), ['原始资料/对话/北自科技/2026.09.09_通话.md']);

  const idea = (await app.inject({
    url: '/api/files/list?section=idea', headers: auth(),
  })).json().files;
  assert.deepEqual(idea.map((f: any) => f.path), ['原始资料/灵感碎片/2026.08.16_人员架构.md']);

  // 分类不串门：对话分组里不应出现文档或根目录文件
  assert.equal(chat.some((f: any) => f.path.includes('/文档/')), false);
  assert.equal(idea.some((f: any) => f.path.startsWith('原始资料/2026')), false);

  const bad = await app.inject({ url: '/api/files/list?section=nope', headers: auth() });
  assert.equal(bad.statusCode, 400);

  const sections = (await app.inject({ url: '/api/files/sections', headers: auth() })).json();
  assert.deepEqual(sections.sections.map((s: any) => s.label), ['文档', '对话', '灵感碎片']);
  assert.equal(sections.defaultDir, '原始资料/文档');
});

test('新建默认落「文档」，可指定「灵感碎片」，但「对话」被拒', async () => {
  const created = (await app.inject({
    method: 'POST',
    url: '/api/files/create',
    headers: auth(),
    payload: { name: '随手记.md' },
  })).json();
  assert.equal(created.path, '原始资料/文档/随手记.md');
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, created.path)), true);
  // 正文不带一级标题：标题由文件名与 frontmatter 承载，正文再写一遍是重复
  assert.equal(
    fs.readFileSync(path.join(BRAIN_DIR, created.path), 'utf8').startsWith('#'),
    false,
    '新建的原始资料不该在正文里写一级标题'
  );

  const idea = (await app.inject({
    method: 'POST',
    url: '/api/files/create',
    headers: auth(),
    payload: { name: '灵感.md', section: 'idea' },
  })).json();
  assert.equal(idea.path, '原始资料/灵感碎片/灵感.md');

  const denied = await app.inject({
    method: 'POST',
    url: '/api/files/create',
    headers: auth(),
    payload: { name: '聊天.md', section: 'chat' },
  });
  assert.equal(denied.statusCode, 403);
  assert.match(denied.json().error, /对话/);

  const outside = await app.inject({
    method: 'POST',
    url: '/api/files/create',
    headers: auth(),
    payload: { name: '越界.md', dir: 'Wiki/概念' },
  });
  assert.equal(outside.statusCode, 403);
});
