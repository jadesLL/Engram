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
let writePage: (rel: string, content: string, extra?: Record<string, any>) => any;
let indexPage: (pageId: string) => Promise<unknown>;
let appendWikiLog: (action: string, detail: string) => void;
let migrateLegacySystemFiles: () => void;
let ensureSystemFiles: () => void;
let regenerateIndex: () => void;
let regenerateRelationships: () => void;
let LOG_PAGE: string;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ ensureDirs } = await import('../config.js'));
  ensureDirs();
  ({ readPage, safeJoin, writePage } = await import('../lib/vault.js'));
  ({ indexPage } = await import('./indexer.js'));
  ({
    appendWikiLog, migrateLegacySystemFiles, ensureSystemFiles,
    regenerateIndex, regenerateRelationships, LOG_PAGE,
  } = await import('./indexFile.js'));
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

/** 回归：索引页曾把客户/组织页一律塞进「其他」桶，等于没按分类建。 */
test('索引页按分类建组：概念独立、实体按 frontmatter 类型细分', () => {
  writePage('Wiki/概念/索引测试概念.md', '# 索引测试概念\n', { title: '索引测试概念', type: 'concept' });
  writePage('Wiki/实体/索引测试人员.md', '# 索引测试人员\n', { title: '索引测试人员', type: 'person' });
  writePage('Wiki/实体/索引测试客户.md', '# 索引测试客户\n', { title: '索引测试客户', type: 'customer' });
  writePage('Wiki/实体/索引测试组织.md', '# 索引测试组织\n', { title: '索引测试组织', type: 'org' });
  writePage('Wiki/实体/索引测试项目.md', '# 索引测试项目\n', { title: '索引测试项目', type: 'project' });

  regenerateIndex();
  const body = readPage('AIWorks/index/index.md').content;

  assert.match(body, /^# Engram 索引/);
  assert.match(body, /^## 概念（\d+）$/m);
  assert.match(body, /^## 实体（\d+）$/m);
  assert.match(body, /^### 人员（\d+）$/m);
  assert.match(body, /^### 客户（\d+）$/m);
  assert.match(body, /^### 组织（\d+）$/m);
  assert.match(body, /^### 项目（\d+）$/m);

  const section = (start: string, end: string) => body.split(start)[1].split(end)[0];
  assert.match(section('## 概念', '## 实体'), /\[\[索引测试概念\]\]/, '概念页落在概念分组');
  assert.match(section('### 人员', '### 客户'), /\[\[索引测试人员\]\]/, '人员页落在人员分组');
  assert.match(section('### 客户', '### 组织'), /\[\[索引测试客户\]\]/, '客户页落在客户分组（不是其他桶）');
  assert.match(section('### 组织', '### 项目'), /\[\[索引测试组织\]\]/, '组织页落在组织分组');
  assert.match(section('### 项目', '\n## '), /\[\[索引测试项目\]\]/, '项目页落在项目分组');
  assert.doesNotMatch(section('### 客户', '### 组织'), /\[\[索引测试人员\]\]/, '分组之间不串页');
  assert.doesNotMatch(body, /^## 其他$/m, '不再有笼统的「其他」分组');
});

/** 回归：关系库只列 4 条词表关系，双链结构完全没进页面，看着像「内容非常少」。 */
test('关系库收录词表关系、双链关联与待建页面', async () => {
  const src = writePage(
    'Wiki/概念/关系测试甲.md',
    [
      '# 关系测试甲',
      '',
      '- [[关系测试甲]]::参与::[[关系测试乙]]',
      '- 另见 [[关系测试乙]] 与 [[关系测试未建页]]',
      '',
    ].join('\n'),
    { title: '关系测试甲', type: 'concept' }
  );
  const dst = writePage(
    'Wiki/实体/关系测试乙.md',
    '# 关系测试乙\n\n- 关联 [[关系测试丙]]\n',
    { title: '关系测试乙', type: 'person' }
  );
  const third = writePage('Wiki/概念/关系测试丙.md', '# 关系测试丙\n', { title: '关系测试丙', type: 'concept' });
  await indexPage(src.id);
  await indexPage(dst.id);
  await indexPage(third.id);

  regenerateRelationships();
  const body = readPage('AIWorks/scheme/relationships.md').content;

  assert.match(body, /^## 概览$/m, '有关系库概览');
  assert.match(body, /^## 词表关系（\d+）$/m);
  assert.match(body, /^- \[\[关系测试甲\]\]::参与::\[\[关系测试乙\]\]$/m, '词表关系逐条列出');
  assert.match(body, /^## 双链关联（\d+）$/m);
  assert.match(body, /^### 概念（\d+）$/m, '双链关联按分类分组');
  assert.match(body, /^### 实体（\d+）$/m);
  assert.match(
    body,
    /^- \[\[关系测试甲\]\] → \[\[关系测试乙\]\]、\[\[关系测试未建页\]\]（待建）$/m,
    '双链关联按源页面聚合，死链标注待建'
  );
  assert.match(body, /^- \[\[关系测试乙\]\] → \[\[关系测试丙\]\]$/m, '实体页的出链同样列出');
  assert.doesNotMatch(body, /\[\[关系测试甲\]\] → \[\[关系测试甲\]\]/, '自环不进关系库');
  assert.match(body, /^## 待建页面（\d+）$/m);
  assert.match(body, /^- \[\[关系测试未建页\]\] ← \[\[关系测试甲\]\]$/m, '待建页面反向索引到来源页');
});

