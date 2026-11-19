import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-graph-cache-'));
process.env.DATA_DIR = temp;

let db: any;
let relatedPageData: (pageId: string) => any;

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ relatedPageData } = await import('./graphCache.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function insertPage(id: string, relPath: string, title: string, type = 'concept'): void {
  db.prepare(
    `INSERT INTO pages(id, path, title, type, tags, summary, created_at, updated_at, deleted, word_count, guide_version)
     VALUES(?, ?, ?, ?, '[]', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 0, 0)`
  ).run(id, relPath, title, type);
}

function insertLink(src: string, dst: string): void {
  db.prepare(
    `INSERT INTO edges(src_page, dst_page, dst_title, entity_id, rel, created_at)
     VALUES(?, ?, NULL, NULL, 'link', '2026-01-01T00:00:00.000Z')`
  ).run(src, dst);
}

/** 回归：索引/关系库为全库每页写一条 [[链接]]，关联面板曾把这两个生成物当真实邻居显示。 */
test('本页关联不把 AIWorks 系统页当邻居', () => {
  insertPage('p1', 'Wiki/概念/关联测试页.md', '关联测试页');
  insertPage('p2', '原始资料/文档/关联测试资料.md', '关联测试资料', 'note');
  insertPage('sys-index', 'AIWorks/index/index.md', 'Engram 索引', 'doc');
  insertPage('sys-rel', 'AIWorks/scheme/relationships.md', '关系库', 'doc');
  insertPage('sys-log', 'AIWorks/log/log.md', '操作日志', 'doc');

  // 系统页 → 当前页（入边）、当前页 → 系统页（出边）都不得回显
  insertLink('sys-index', 'p1');
  insertLink('sys-rel', 'p1');
  insertLink('sys-log', 'p1');
  insertLink('p1', 'sys-index');
  // 原始资料引用当前页是真实关联，必须保留
  insertLink('p2', 'p1');

  const data = relatedPageData('p1');
  assert.deepEqual(
    data.neighbors.map((n: any) => n.title),
    ['关联测试资料'],
    '只保留原始资料等真实关联，系统生成页全部过滤'
  );
});
