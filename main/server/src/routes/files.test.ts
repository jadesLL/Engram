import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-files-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let safeJoin: (rel: string) => string;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();

  ({ safeJoin } = await import('../lib/vault.js'));
  const { ensureDirs } = await import('../config.js');
  ensureDirs();

  const routes = await import('./files.js');
  app = Fastify();
  await app.register(jwt, { secret: 'files-route-test-secret' });
  await app.register(routes.fileRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/**
 * 回归：「已提炼」标记改为一次查库批量打标（distilledSourcePaths）后，逐文件的标记
 * 语义必须与原来的 isDistilledPath 完全一致——web 的「等待提炼」待办只看这个字段。
 */
test('/api/files/list：distilled 批量预取后逐文件标记仍准确，响应字段不变', async () => {
  fs.mkdirSync(safeJoin('原始资料/文档'), { recursive: true });
  fs.writeFileSync(safeJoin('原始资料/文档/已提炼资料.md'), '# 已提炼资料\n');
  fs.writeFileSync(safeJoin('原始资料/文档/未提炼资料.md'), '# 未提炼资料\n');
  // 已提炼 = 存在 active 的来源版本（或 active 页面贡献），与 isDistilledPath 同口径
  db.prepare(
    `INSERT INTO source_versions(id, path, content_hash, status, created_at)
     VALUES('sv-test', '原始资料/文档/已提炼资料.md', 'hash-test', 'active', '2026-01-01T00:00:00.000Z')`
  ).run();
  // md 的 pageId 来自 pages 行（侧栏据此直接进编辑器）
  db.prepare(
    `INSERT INTO pages(id, path, title, created_at, updated_at, deleted)
     VALUES('pg-1', '原始资料/文档/已提炼资料.md', '已提炼资料', '2026-01-01', '2026-01-01', 0)`
  ).run();

  const res = await app.inject({
    method: 'GET',
    url: '/api/files/list?section=doc',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const files = res.json().files as any[];
  const distilled = files.find((f) => f.path === '原始资料/文档/已提炼资料.md');
  const fresh = files.find((f) => f.path === '原始资料/文档/未提炼资料.md');
  assert.equal(distilled?.distilled, true, '有 active 来源版本的资料要标成已提炼');
  assert.equal(distilled?.pageId, 'pg-1', 'md 仍要带 pages 行的 id');
  assert.equal(fresh?.distilled, false, '没有账本记录的资料不得标成已提炼');

  // 响应形状是 web 契约（Sidebar / homeBoard 按这些字段渲染）：批量改造不得增删字段
  assert.deepEqual(
    Object.keys(distilled).sort(),
    [
      'assetCount', 'distilled', 'ext', 'extractionError', 'extractionMethod',
      'extractionOcrPages', 'extractionPageCount', 'extractionSkippedPages',
      'extractionStatus', 'legacy', 'name', 'pageId', 'path', 'readable', 'size', 'updated_at',
    ].sort(),
  );
});
