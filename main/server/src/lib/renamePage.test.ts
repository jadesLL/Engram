import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-rename-page-'));
process.env.DATA_DIR = temp;

let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
});

after(async () => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('重命名撞名：加 -N 后缀避让，不覆盖既有页面文件', async () => {
  const { createPage, writePage, readPage } = await import('../lib/vault.js');
  const { renamePageSafely } = await import('./renamePage.js');

  const a = createPage('Wiki/概念', '同题甲');
  writePage(a.path, '# 同题甲\n\n甲的正文，不能丢。', {});
  const b = createPage('Wiki/概念', '同题乙');
  writePage(b.path, '# 同题乙\n\n乙的正文，也不能丢。', {});

  renamePageSafely(a.id, '同题乙');

  const fresh = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(a.id) as { path: string };
  assert.match(fresh.path, /同题乙-2\.md$/);
  assert.match(readPage(fresh.path)?.content || '', /甲的正文，不能丢。/);
  // 被撞页原样保留（回归前：movePage 的 renameSync 会直接覆盖它的文件）
  const bFresh = db.prepare(`SELECT path FROM pages WHERE id = ?`).get(b.id) as { path: string };
  assert.equal(bFresh.path.endsWith('同题乙.md'), true);
  assert.match(readPage(bFresh.path)?.content || '', /乙的正文，也不能丢。/);
});

test('编辑器改标题（syncH1=false）：文件名跟随标题、正文 H1 不动、双链重定向', async () => {
  const { createPage, writePage, readPage } = await import('../lib/vault.js');
  const { renamePageSafely } = await import('./renamePage.js');

  const target = createPage('Wiki/概念', '改名目标');
  writePage(target.path, '# 正文里的旧 H1\n\n正文内容，不能丢。', { title: '改名目标' });
  const referrer = createPage('Wiki/概念', '引用方');
  writePage(referrer.path, '# 引用方\n\n见 [[改名目标]] 与 [[改名目标|别名]]。', { title: '引用方' });
  // 双链边由管线异步重建：这里手工插一条，单独验证重定向本身
  db.prepare(`INSERT INTO edges(src_page, dst_page, rel, created_at) VALUES(?, ?, 'link', '2026-01-01')`)
    .run(referrer.id, target.id);

  const result = renamePageSafely(target.id, '改名之后', { syncH1: false, allowSamePath: true });

  assert.equal(result.moved, true);
  assert.match(result.path, /改名之后\.md$/);
  const onDisk = readPage(result.path);
  assert.match(
    onDisk?.content || '',
    /^# 正文里的旧 H1/m,
    '正文 H1 属于用户正文：编辑器里改标题不该被服务端改写（会和未保存内容打架）'
  );
  assert.match(onDisk?.content || '', /正文内容，不能丢。/);
  assert.equal((db.prepare(`SELECT title FROM pages WHERE id = ?`).get(target.id) as any).title, '改名之后');
  const refBody = readPage(referrer.path)?.content || '';
  assert.match(refBody, /\[\[改名之后\]\]/, '双链要跟着重定向，不能留死链');
  assert.match(refBody, /\[\[改名之后\|别名\]\]/);
});

test('编辑器改标题只差非法字符（allowSamePath）：只改标题不报错', async () => {
  const { createPage, writePage, readPage } = await import('../lib/vault.js');
  const { renamePageSafely } = await import('./renamePage.js');

  // 存量现场：标题含文件名不允许的字符（历史导入留下的），文件名是它的规范化形式
  const page = createPage('Wiki/概念', '斜杠标题');
  writePage(page.path, '# 斜杠标题\n\n正文\n', { title: '斜杠/标题' });

  const result = renamePageSafely(page.id, '斜杠标题', { syncH1: false, allowSamePath: true });

  assert.equal(result.moved, false, '文件名本来就等于新标题的规范化形式：没有可挪的路径');
  assert.equal(result.path, page.path);
  assert.equal((db.prepare(`SELECT title FROM pages WHERE id = ?`).get(page.id) as any).title, '斜杠标题');
  assert.match(readPage(page.path)?.content || '', /正文/);
});
