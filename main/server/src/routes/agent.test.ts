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
