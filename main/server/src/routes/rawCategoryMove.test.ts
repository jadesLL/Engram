/**
 * 编辑页「分类」字段：原始资料页在三个二级分类之间移动，账本跟着走。
 *
 * 覆盖：
 *  1. 移动后文件落新目录、页面 ID 不变、接口回报新分类；
 *  2. 按路径存的账本（source_versions / ingest_runs / page_revisions）一起改挂新路径
 *     —— 否则「已提炼」标记与证据来源会指向旧路径；
 *  3. 跨区移动被拒：原始资料 ↔ Wiki 不能互移；
 *  4. 原始资料页改名同样挪账本（renamePageSafely 的路径）。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-raw-category-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let BRAIN_DIR = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ BRAIN_DIR } = await import('../config.js'));
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  const { pageRoutes } = await import('./pages.js');
  app = Fastify();
  await app.register(jwt, { secret: 'raw-category-test-secret' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(pageRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** 造一份原始资料页 + 它的账本（版本/提炼记录/修订），模拟「已提炼过的资料」 */
async function seedDistilledRaw(rel: string): Promise<string> {
  const { writePage } = await import('../lib/vault.js');
  const meta = writePage(rel, `# ${path.posix.basename(rel, '.md')}\n\n正文内容\n`, {
    title: path.posix.basename(rel, '.md'),
  });
  assert.ok(meta?.id, `页面未建出：${rel}`);
  db.prepare(
    `INSERT INTO source_versions(id,path,content_hash,status,created_at,activated_at)
     VALUES(?,?,?,'active',?,?)`
  ).run(`sv-${meta.id}`, rel, `hash-${meta.id}`, '2026-01-01', '2026-01-01');
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,status,started_at)
     VALUES(?,?,?,'completed',?)`
  ).run(`run-${meta.id}`, rel, `hash-${meta.id}`, '2026-01-01');
  db.prepare(
    `INSERT INTO page_revisions(path,revision,content,node_id,ts) VALUES(?,1,'正文','node','2026-01-01')`
  ).run(rel);
  return meta.id;
}

function rawPathOf(id: string): string {
  return (db.prepare(`SELECT path FROM pages WHERE id = ?`).get(id) as any).path;
}

test('原始资料页换分类：文件移动、页面 ID 不变、账本跟着挪', async () => {
  const oldRel = '原始资料/文档/甲资料.md';
  const id = await seedDistilledRaw(oldRel);
  const { isDistilledPath } = await import('../pipeline/sourceLedger.js');
  assert.equal(isDistilledPath(oldRel), true, '前置：这份资料在旧路径上算「已提炼」');

  const res = await app.inject({
    method: 'POST',
    url: `/api/pages/${id}/move`,
    headers: auth(),
    payload: { dir: '原始资料/灵感碎片' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.section, 'idea', '接口回报新分类');
  assert.equal(body.meta.id, id, '页面 ID 不变');

  const newRel = '原始资料/灵感碎片/甲资料.md';
  assert.equal(rawPathOf(id), newRel);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, newRel)), true);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, oldRel)), false);

  // 账本随路径改挂：新路径仍算「已提炼」，旧路径不再有记录
  assert.equal(isDistilledPath(newRel), true, '换分类后仍算已提炼（不会被当成未提炼重列）');
  assert.equal(isDistilledPath(oldRel), false);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM source_versions WHERE path = ?`).get(newRel) as any).n,
    1
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM ingest_runs WHERE path = ?`).get(newRel) as any).n,
    1
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM page_revisions WHERE path = ?`).get(newRel) as any).n,
    1
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM source_versions WHERE path = ?`).get(oldRel) as any).n,
    0
  );
});

test('根目录历史资料也能归入某个二级分类', async () => {
  const oldRel = '原始资料/乙资料.md';
  const id = await seedDistilledRaw(oldRel);
  const res = await app.inject({
    method: 'POST',
    url: `/api/pages/${id}/move`,
    headers: auth(),
    payload: { dir: '原始资料/文档' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().section, 'doc');
  assert.equal(rawPathOf(id), '原始资料/文档/乙资料.md');
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, '原始资料/文档/乙资料.md')), true);
});

test('跨区移动被拒：原始资料不能进 Wiki，Wiki 页不能进原始资料', async () => {
  const id = await seedDistilledRaw('原始资料/文档/丙资料.md');
  const toWiki = await app.inject({
    method: 'POST',
    url: `/api/pages/${id}/move`,
    headers: auth(),
    payload: { dir: 'Wiki/实体' },
  });
  assert.equal(toWiki.statusCode, 400);
  assert.match(toWiki.json().error, /文档 \/ 对话 \/ 灵感碎片/);

  const { writePage } = await import('../lib/vault.js');
  const wiki = writePage('Wiki/概念/普通页.md', '# 普通页\n\n正文\n', { title: '普通页' });
  const toRaw = await app.inject({
    method: 'POST',
    url: `/api/pages/${wiki!.id}/move`,
    headers: auth(),
    payload: { dir: '原始资料/文档' },
  });
  assert.equal(toRaw.statusCode, 400);
  assert.match(toRaw.json().error, /Wiki/);
});

test('原始资料页改名：账本同样跟着挪', async () => {
  const oldRel = '原始资料/灵感碎片/丁资料.md';
  const id = await seedDistilledRaw(oldRel);
  const { renamePageSafely } = await import('../lib/renamePage.js');
  const result = renamePageSafely(id, '丁资料-改名', { syncH1: false, allowSamePath: true });
  const newRel = '原始资料/灵感碎片/丁资料-改名.md';
  assert.equal(result.path, newRel);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM source_versions WHERE path = ?`).get(newRel) as any).n,
    1,
    '改名后来源版本记录跟着新路径'
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) n FROM source_versions WHERE path = ?`).get(oldRel) as any).n,
    0
  );
});
