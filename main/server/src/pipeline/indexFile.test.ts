import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-index-file-'));
process.env.DATA_DIR = temp;

let db: any;
let ensureDirs: () => void;
let readPage: (rel: string) => any;
let safeJoin: (rel: string) => string;
let appendWikiLog: (action: string, detail: string) => void;
let migrateLegacySystemFiles: () => void;
let ensureSystemFiles: () => void;
let LOG_PAGE: string;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ ensureDirs } = await import('../config.js'));
  ensureDirs();
  ({ readPage, safeJoin } = await import('../lib/vault.js'));
  ({ appendWikiLog, migrateLegacySystemFiles, ensureSystemFiles, LOG_PAGE } = await import('./indexFile.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/**
 * 回归：操作日志页自 AIWorks/log/ 落位后，启动迁移曾把它当历史遗留文件 unlink，
 * 导致每次重启日志归零（先重写再删除，内容不可恢复）。
 */
test('启动迁移与预置都不得清空操作日志页', () => {
  appendWikiLog('新建页面', '[[示例页]]（Wiki/概念/示例页.md）');
  assert.match(readPage(LOG_PAGE).content, /新建页面/);

  migrateLegacySystemFiles();
  const migrated = readPage(LOG_PAGE);
  assert.ok(migrated, '迁移后操作日志页仍然存在');
  assert.match(migrated.content, /新建页面/, '迁移不得删除/清空操作日志');

  ensureSystemFiles();
  assert.match(readPage(LOG_PAGE).content, /新建页面/, '启动预置不得用空模板覆盖已有操作日志');
});

test('历史遗留日志仍会并入操作日志，旧文件按预期清理', () => {
  fs.mkdirSync(safeJoin('AIWorks/log'), { recursive: true });
  fs.writeFileSync(safeJoin('AIWorks/log/2026-01-02-03-04-05.md'), '# 运行\n\n- 死链：2\n- 疑似重复：1\n');
  fs.writeFileSync(
    safeJoin('Wiki/log.md'),
    ['---', 'title: 操作日志', '---', '# 操作日志', '', '- 2026-01-01 09:00:00 新建页面：[[旧页]]（Wiki/概念/旧页.md）', ''].join('\n'),
  );

  migrateLegacySystemFiles();

  const log = readPage(LOG_PAGE).content;
  assert.match(log, /智能整理：死链 2｜疑似重复 1｜共 3 项/, 'Dream Cycle 运行文件应转成一条智能整理条目');
  assert.match(log, /\[\[旧页\]\]/, '旧 Wiki/log.md 条目应并入新日志');
  assert.match(log, /新建页面/, '已有新日志条目不应被迁移覆盖');
  assert.ok(!fs.existsSync(safeJoin('Wiki/log.md')), '旧 Wiki/log.md 应被删除');
  assert.ok(!fs.existsSync(safeJoin('AIWorks/log/2026-01-02-03-04-05.md')), '历史独立日志文件应被删除');
  assert.ok(fs.existsSync(safeJoin(LOG_PAGE)), '操作日志页本身必须保留');
});

test('系统页缺失时仍会补建', () => {
  fs.rmSync(safeJoin(LOG_PAGE), { force: true });
  db.prepare(`DELETE FROM pages WHERE path = ?`).run(LOG_PAGE);
  ensureSystemFiles();
  assert.match(readPage(LOG_PAGE).content, /^# 操作日志/, '缺失的操作日志页应被补建');
  assert.ok(fs.existsSync(safeJoin('AIWorks/同步冲突/说明.md')), '静态系统页清单缺失即建');
});

test('appendWikiLog 倒序追加，新的在上', () => {
  appendWikiLog('编辑页面', '[[甲]]（Wiki/概念/甲.md）');
  appendWikiLog('删除', '[[乙]]（Wiki/概念/乙.md）');
  const body = readPage(LOG_PAGE).content;
  const first = body.indexOf('[[乙]]');
  const second = body.indexOf('[[甲]]');
  assert.ok(first > 0 && second > 0, '两条条目都应写入');
  assert.ok(first < second, '新条目应插在标题正下方（倒序）');
});
