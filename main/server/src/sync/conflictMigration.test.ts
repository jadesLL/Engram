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

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  ({ writePage, safeJoin } = await import('../lib/vault.js'));
  ({ migrateConflictBackupDir } = await import('./hub.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('迁移清理 AIWorks 内不可删的冲突遗留与过时说明页，用户可删的历史备份页保留', () => {
  // 旧机制遗留：AIWorks 下的冲突备份与记录页（用户在 UI 里删不掉），顶级说明页（过时）
  writePage('AIWorks/同步冲突/index-20260910T164425.md', '> 旧备份\n', { title: '同步冲突: index', type: 'doc' });
  writePage('AIWorks/log/conflict.md', '# 同步冲突记录\n', { title: '同步冲突记录', type: 'doc' });
  writePage('同步冲突/说明.md', '# 同步冲突备份\n', { title: '同步冲突备份', type: 'doc' });
  // 用户可删的历史备份页：保留
  writePage('同步冲突/笔记-20260910090000.md', '> 历史备份内容\n', { title: '同步冲突: 笔记', type: 'doc' });

  migrateConflictBackupDir();

  const gone = (p: string) =>
    db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE deleted = 0 AND path = ?`).get(p).n === 0;
  assert.ok(gone('AIWorks/同步冲突/index-20260910T164425.md'), 'AIWorks 下的冲突备份应入回收站');
  assert.ok(gone('AIWorks/log/conflict.md'), '冲突记录页应入回收站');
  assert.ok(gone('同步冲突/说明.md'), '过时说明页应入回收站');
  assert.ok(
    !gone('同步冲突/笔记-20260910090000.md'),
    '用户可删的历史备份页应保留，由用户自行处理'
  );
  assert.ok(!fs.existsSync(safeJoin('AIWorks/同步冲突')), 'AIWorks 下冲突目录应消失');
});

test('无遗留时迁移为空操作', () => {
  assert.doesNotThrow(() => migrateConflictBackupDir());
});
