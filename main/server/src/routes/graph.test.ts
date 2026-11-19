import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-graph-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();

  const routes = await import('./graph.js');
  app = Fastify();
  await app.register(jwt, { secret: 'graph-route-test-secret' });
  await app.register(routes.graphRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
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

async function graph(query: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/graph?${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json();
}

/** 回归：索引/关系库连着全库每页，局部图谱 BFS 曾因此被扩成全库毛线团。 */
test('图谱不把 AIWorks 系统页纳入局部 BFS 与全局节点', async () => {
  insertPage('p1', 'Wiki/概念/图谱测试甲.md', '图谱测试甲');
  insertPage('p2', 'Wiki/概念/图谱测试乙.md', '图谱测试乙');
  insertPage('p3', '原始资料/文档/图谱测试资料.md', '图谱测试资料', 'note');
  insertPage('sys-index', 'AIWorks/index/index.md', 'Engram 索引', 'doc');
  insertPage('sys-rel', 'AIWorks/scheme/relationships.md', '关系库', 'doc');

  insertLink('p3', 'p1');
  insertLink('p1', 'p2');
  insertLink('sys-index', 'p1');
  insertLink('sys-rel', 'p2');
  insertLink('p1', 'sys-index');

  const local = await graph('scope=page&id=p1&depth=2');
  const localIds = local.nodes.map((n: any) => n.id).sort();
  assert.deepEqual(localIds, ['p1', 'p2', 'p3'], '局部图谱只含真实知识节点');
  assert.ok(
    local.edges.every((e: any) => e.from !== 'sys-index' && e.to !== 'sys-index'),
    '系统页相关边不出现'
  );

  const global = await graph('scope=global');
  const globalIds = global.nodes.map((n: any) => n.id);
  assert.ok(!globalIds.some((id: string) => id.startsWith('sys-')), '全局图谱不含系统页节点');
});
