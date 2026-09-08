import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let writePage: (rel: string, content: string, extra?: any) => any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));
  ({ writePage } = await import('../lib/vault.js'));

  const { agentRoutes } = await import('./agent.js');
  app = Fastify();
  await app.register(jwt, { secret: 'agent-route-test-secret' });
  await app.register(agentRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function deleteRequest(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/agent/page/delete',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function renameRequest(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/agent/page/rename',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function moveRequest(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/agent/page/move',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

test('POST /api/agent/page/delete 把 Wiki 页面移入回收站（CLI pages delete 路径）', async () => {
  writePage('Wiki/实体/待删实体.md', '# 待删实体\n\n正文\n', { title: '待删实体' });
  const res = await deleteRequest({ titleOrId: '待删实体', reason: 'CLI 路径测试' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.path, 'Wiki/实体/待删实体.md');
  assert.ok(body.trashId, '应返回回收站条目 id');
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/实体/待删实体.md')), false);
  assert.equal(
    (db.prepare(`SELECT deleted FROM pages WHERE path = ?`).get('Wiki/实体/待删实体.md') as any).deleted,
    1
  );
});

test('原始资料/ 下的页面经 REST 删除被拒（403，文件保留）', async () => {
  writePage('原始资料/只读资料.md', '# 只读资料\n\n正文\n', { title: '只读资料' });
  const res = await deleteRequest({ titleOrId: '只读资料' });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /只读区/);
  assert.equal(fs.existsSync(path.join(temp, 'brain', '原始资料/只读资料.md')), true);
});

test('缺少 titleOrId 返回 400', async () => {
  const res = await deleteRequest({});
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /页面标题/);
});

test('POST /api/agent/page/rename 改标题+移动文件+保持页面 ID', async () => {
  const created = writePage('Wiki/实体/旧名实体.md', '# 旧名实体\n\n正文\n', { title: '旧名实体' });
  const res = await renameRequest({ titleOrId: '旧名实体', newTitle: '新名实体' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.path, 'Wiki/实体/新名实体.md');
  assert.equal(body.title, '新名实体');
  // 页面 ID 保持不变：rename_page/move_page 与「write 新路径 + delete 旧路径」的本质区别
  assert.equal(body.id, created.id);
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/实体/旧名实体.md')), false);
  const row = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(created.id) as any;
  assert.equal(row.path, 'Wiki/实体/新名实体.md');
});

test('rename 拒绝只读区页面（403）与空标题（400）', async () => {
  writePage('原始资料/对话/只读对话.md', '# 只读对话\n\n正文\n', { title: '只读对话' });
  const forbidden = await renameRequest({ titleOrId: '只读对话', newTitle: '改名' });
  assert.equal(forbidden.statusCode, 403);
  assert.match(forbidden.json().error, /只读区/);

  writePage('Wiki/概念/可改名页.md', '# 可改名页\n\n正文\n', { title: '可改名页' });
  const empty = await renameRequest({ titleOrId: '可改名页', newTitle: '  ' });
  assert.equal(empty.statusCode, 400);
});

test('标题不唯一时 rename 拒绝并提示用 ID/路径', async () => {
  writePage('Wiki/概念/同名页甲.md', '# 同名页\n\n甲\n', { title: '同名页' });
  writePage('Wiki/实体/同名页乙.md', '# 同名页\n\n乙\n', { title: '同名页' });
  const res = await renameRequest({ titleOrId: '同名页', newTitle: '改名' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /2 个页面/);
});

test('rename 撞上回收站软删除页占用的路径：加 -N 后缀而不是 500（回归）', async () => {
  // 建页 → 软删除（pages 行仍占用 path）→ 同路径重建新题页 → 改名到被占路径
  writePage('Wiki/实体/占名页.md', '# 占名页\n\n旧内容\n', { title: '占名页' });
  const del = await deleteRequest({ titleOrId: '占名页', reason: '回归测试' });
  assert.equal(del.statusCode, 200);
  writePage('Wiki/实体/新页.md', '# 新页\n\n新内容\n', { title: '新页' });
  const res = await renameRequest({ titleOrId: '新页', newTitle: '占名页' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().path, 'Wiki/实体/占名页-2.md');
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/实体/占名页-2.md')), true);
});

test('POST /api/agent/page/move 移动目录并保持页面 ID；目标非法被拒', async () => {
  const created = writePage('Wiki/概念/搬迁页.md', '# 搬迁页\n\n正文\n', { title: '搬迁页' });
  const res = await moveRequest({ titleOrId: '搬迁页', dir: 'Wiki/实体' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.moved, true);
  assert.equal(body.path, 'Wiki/实体/搬迁页.md');
  assert.equal(body.id, created.id);

  const noOp = await moveRequest({ titleOrId: '搬迁页', dir: 'Wiki/实体' });
  assert.equal(noOp.statusCode, 200);
  assert.equal(noOp.json().moved, false);

  const badDir = await moveRequest({ titleOrId: '搬迁页', dir: '原始资料' });
  assert.equal(badDir.statusCode, 400);
  assert.match(badDir.json().error, /Wiki 目录内/);

  writePage('原始资料/对话/不可移动.md', '# 不可移动\n\n正文\n', { title: '不可移动' });
  const forbidden = await moveRequest({ titleOrId: '不可移动', dir: 'Wiki/实体' });
  assert.equal(forbidden.statusCode, 403);
  assert.match(forbidden.json().error, /只读区/);
});
