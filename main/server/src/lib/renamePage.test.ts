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
