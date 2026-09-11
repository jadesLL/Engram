import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-conflict-mig-'));
process.env.DATA_DIR = temp;

let db: any;
let writePage: (rel: string, content: string, extra?: Record<string, any>) => any;
let safeJoin: (rel: string) => string;
let migrateConflictBackupDir: () => void;
let ensureSystemFiles: () => void;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  ({ writePage, safeJoin } = await import('../lib/vault.js'));
  ({ migrateConflictBackupDir } = await import('./hub.js'));
  ({ ensureSystemFiles } = await import('../pipeline/indexFile.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('旧 AIWorks/同步冲突/ 备份页迁移到顶级 同步冲突/，说明页入回收站后于新目录重建', () => {
  // 升级前的旧结构：备份页 + 过时说明页
  writePage('AIWorks/同步冲突/笔记-20260101120000.md', '> 冲突备份内容\n', { title: '同步冲突: 笔记', type: 'doc' });
  writePage('AIWorks/同步冲突/说明.md', '# 同步冲突备份\n', { title: '同步冲突备份', type: 'doc' });

  migrateConflictBackupDir();

  assert.ok(
    fs.existsSync(safeJoin('同步冲突/笔记-20260101120000.md')),
    '备份页应迁移到顶级 同步冲突/ 目录'
  );
  const rows = db
    .prepare(`SELECT path FROM pages WHERE deleted = 0 AND path = '同步冲突/笔记-20260101120000.md'`)
    .all();
  assert.equal(rows.length, 1, 'DB 行 path 应随迁移更新');
  assert.ok(!fs.existsSync(safeJoin('AIWorks/同步冲突/说明.md')), '旧说明页应入回收站');
  assert.ok(!fs.existsSync(safeJoin('AIWorks/同步冲突')), '旧目录迁移后应消失');

  ensureSystemFiles();
  assert.ok(fs.existsSync(safeJoin('同步冲突/说明.md')), '新说明页应重建于新目录（缺失即建）');
});

test('无旧目录时迁移为空操作', () => {
  assert.doesNotThrow(() => migrateConflictBackupDir());
});
