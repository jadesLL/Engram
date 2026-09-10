import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 真实 SQLite FTS5 端到端行为验证：bigram 索引/查询、错字兜底、
 * 单字检索、同义词展开、旧索引迁移。全部走 hybridSearch 全链路。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-search-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let getSetting: (key: string) => string | undefined;
let writePage: (relPath: string, content: string, extra?: Record<string, any>) => any;
let indexPage: (pageId: string) => Promise<any>;
let hybridSearch: (query: string, limit?: number) => Promise<any[]>;

before(async () => {
  ({ db, migrate, setSetting, getSetting } = await import('../lib/db.js'));
  ({ writePage } = await import('../lib/vault.js'));
  ({ indexPage } = await import('../pipeline/indexer.js'));
  ({ hybridSearch } = await import('./hybrid.js'));
  migrate();
});

after(() => {
  // Windows 下 WAL 句柄未释放时 rmSync 报 EBUSY，先关库再清理
  try { db.close(); } catch { /* 已关闭 */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 临时目录留给 OS 清理 */ }
});

function titlesOf(hits: any[]): string[] {
  return hits.map((h) => h.title);
}

test('正常关键词：bigram 索引与查询口径一致，命中目标页', async () => {
  await writePage('Wiki/概念/部署指南.md', '# 部署指南\n\n服务器部署流程与回滚方案。');
  const hits = await hybridSearch('部署');
  assert.ok(titlesOf(hits).includes('部署指南'));
});

test('错字兜底：搜「部属」经词表编辑距离邻居命中「部署」', async () => {
  const hits = await hybridSearch('部属');
  assert.ok(titlesOf(hits).includes('部署指南'), `实际: ${titlesOf(hits).join(',')}`);
});

test('边缘错字：搜「部署指难」靠存活 bigram 命中', async () => {
  const hits = await hybridSearch('部署指难');
  assert.ok(titlesOf(hits).includes('部署指南'), `实际: ${titlesOf(hits).join(',')}`);
});

test('单字检索：搜「器」命中含「服务器」的页面（单字入索引）', async () => {
  const hits = await hybridSearch('器');
  assert.ok(titlesOf(hits).includes('部署指南'), `实际: ${titlesOf(hits).join(',')}`);
});

test('同义词展开：配置 部署,上线 后搜「上线」命中「部署指南」', async () => {
  setSetting('search_synonyms', '部署,上线');
  const hits = await hybridSearch('怎么上线');
  assert.ok(titlesOf(hits).includes('部署指南'), `实际: ${titlesOf(hits).join(',')}`);
});

test('英文词：unicode61 原生分词命中', async () => {
  await writePage('Wiki/概念/docker笔记.md', '# docker笔记\n\ndocker compose up 的用法。');
  const hits = await hybridSearch('docker');
  assert.ok(titlesOf(hits).includes('docker笔记'));
});

test('迁移：存量旧格式 FTS 行清空后由 indexPage 兜底重插（新口径）', async () => {
  // 模拟存量库：把 FTS 行替换为旧的单字切分格式，并把版本标记拨回旧值
  const pageId = (
    db.prepare(`SELECT id FROM pages WHERE path = ?`).get('Wiki/概念/部署指南.md') as any
  ).id;
  db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(pageId);
  db.prepare(`INSERT INTO pages_fts(title, content, tags, page_id) VALUES(?, ?, ?, ?)`).run(
    '部 署 指 南', '服 务 器 部 署 流 程', '', pageId,
  );
  db.prepare(`DELETE FROM settings WHERE key = 'fts_segment_version'`).run();

  migrate(); // 应清空 pages_fts 并写入版本标记

  const ftsRows = db.prepare(`SELECT COUNT(*) AS n FROM pages_fts`).get() as any;
  assert.equal(ftsRows.n, 0, '旧格式行应被清空');
  assert.equal(getSetting('fts_segment_version'), 'bigram-v1');
  // 启动扫描对每页做的事 = indexPage 兜底补写
  await indexPage(pageId);
  const hits = await hybridSearch('部署');
  assert.ok(titlesOf(hits).includes('部署指南'), '重插后应按新口径命中');
});
