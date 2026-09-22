import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-vault-watch-'));
process.env.DATA_DIR = temp;

let db: any;
let brainDir = '';
const events: { event: string; data: any }[] = [];

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const config = await import('../config.js');
  config.ensureDirs();
  brainDir = config.BRAIN_DIR;
  const { subscribe } = await import('./events.js');
  subscribe({
    send: (event: string, data: unknown) => { events.push({ event, data }); },
    raw: {} as any,
  });
});

after(async () => {
  const { stopVaultWatch } = await import('./vaultWatch.js');
  stopVaultWatch();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function abs(rel: string): string {
  return path.join(brainDir, rel);
}

function eventNames(): string[] {
  return events.map((e) => e.event);
}

test('带外新写的 md：立刻建索引并推 page-changed（不用等重启）', async () => {
  const { reconcileVaultPaths } = await import('./vaultWatch.js');
  const rel = '原始资料/2026.09.23_带外新写.md';
  fs.mkdirSync(abs('原始资料'), { recursive: true });
  fs.writeFileSync(abs(rel), '# 2026.09.23_带外新写\n\n外置 Agent 直接落盘的内容。\n');

  events.length = 0;
  const result = await reconcileVaultPaths([rel], { deferDeletionMs: 0 });

  assert.equal(result.pages, 1);
  const row = db.prepare(`SELECT id, title, deleted FROM pages WHERE path = ?`).get(rel) as any;
  assert.ok(row, '带外新写的 md 要立刻有 pages 行，否则侧栏点不进编辑器');
  assert.equal(row.title, '2026.09.23_带外新写');
  assert.equal(row.deleted, 0);
  assert.deepEqual(eventNames(), ['page-changed']);
});

test('应用自己写的页面不回声：writePage 之后再对账不推事件', async () => {
  const { writePage } = await import('./vault.js');
  const { reconcileVaultPaths } = await import('./vaultWatch.js');
  const rel = 'Wiki/概念/回声抑制.md';
  writePage(rel, '# 回声抑制\n\n正文\n', { title: '回声抑制' });

  events.length = 0;
  const result = await reconcileVaultPaths([rel], { deferDeletionMs: 0 });

  assert.equal(result.skipped, 1);
  assert.equal(result.pages, 0);
  assert.deepEqual(eventNames(), [], '自己刚写完再对账一次是纯回声，编辑器不该被重载');
});

test('带外改名：行跟着走、页面 ID 不变、标题跟随新文件名、同批不误判删除', async () => {
  const { writePage } = await import('./vault.js');
  const { reconcileVaultPaths } = await import('./vaultWatch.js');
  const meta = writePage(
    '原始资料/2026.08.16_京津区人员架构.md',
    '# 2026.08.16京津区人员架构\n\n- 京津区经理：刘子谕\n',
    { title: '2026.08.16_京津区人员架构' }
  );
  // 外置 Agent 用 shell 挪文件（去掉下划线），不经过服务端
  const oldRel = meta.path;
  const newRel = '原始资料/2026.08.16京津区人员架构.md';
  fs.renameSync(abs(oldRel), abs(newRel));

  events.length = 0;
  const result = await reconcileVaultPaths([oldRel, newRel], { deferDeletionMs: 0 });

  assert.equal(result.moved, 1);
  assert.equal(result.deleted, 0, '同一批里的改名不能被误判成删除');
  const row = db.prepare(`SELECT id, path, title, deleted FROM pages WHERE id = ?`).get(meta.id) as any;
  assert.ok(row, '页面 ID 必须保住：图谱边、证据账本、双链都挂在它上面');
  assert.equal(row.path, newRel);
  assert.equal(row.title, '2026.08.16京津区人员架构', '标题原本与文件名同步 → 跟随新文件名');
  assert.equal(row.deleted, 0);
  assert.ok(eventNames().includes('page-moved'), `改名要推 page-moved：${eventNames().join(',')}`);
  assert.ok(!eventNames().includes('page-deleted'), '改名不该推删除事件（编辑器会闪一下跳走）');
});

test('带外删除：行标删除并推 page-deleted', async () => {
  const { writePage } = await import('./vault.js');
  const { reconcileVaultPaths } = await import('./vaultWatch.js');
  const meta = writePage('Wiki/概念/带外删除.md', '# 带外删除\n\n正文\n', { title: '带外删除' });
  fs.unlinkSync(abs(meta.path));

  events.length = 0;
  const result = await reconcileVaultPaths([meta.path], { deferDeletionMs: 0 });

  assert.equal(result.deleted, 1);
  const row = db.prepare(`SELECT deleted FROM pages WHERE id = ?`).get(meta.id) as any;
  assert.equal(row.deleted, 1);
  assert.deepEqual(eventNames(), ['page-deleted']);
});

test('带外落进原始资料的文件：推 file-changed 并登记提取（侧栏不再等重启）', async () => {
  const { reconcileVaultPaths } = await import('./vaultWatch.js');
  const rel = '原始资料/带外扫描件.pdf';
  fs.writeFileSync(abs(rel), Buffer.from('%PDF-1.4 假文件（只为对账路径）'));

  events.length = 0;
  const result = await reconcileVaultPaths([rel], { deferDeletionMs: 0 });

  assert.equal(result.files, 1);
  assert.ok(
    db.prepare(`SELECT 1 FROM files WHERE path = ?`).get(rel),
    '原始资料里带外出现的可提取文件要立刻登记，提取任务才会排上'
  );
  assert.deepEqual(eventNames(), ['file-changed']);
});

test('回收站与图片资产目录不进对账（各有自己的收口）', async () => {
  const { reconcileVaultPaths } = await import('./vaultWatch.js');
  events.length = 0;
  const result = await reconcileVaultPaths([
    '.trash/123-页面.md',
    '原始资料/assets/abc/图片.png',
    '原始资料/中间产物.md.1234.tmp',
  ], { deferDeletionMs: 0 });

  assert.equal(result.handled, 0);
  assert.equal(result.files, 0);
  assert.deepEqual(eventNames(), []);
});
