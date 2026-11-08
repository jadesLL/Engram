import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-search-route-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));
  const { writePage } = await import('../lib/vault.js');
  // writePage 同步写 pages_fts，检索用例无需等索引任务
  for (let i = 0; i < 3; i += 1) {
    writePage(
      'Wiki/概念/检索样本' + i + '.md',
      '# 检索样本' + i + '\n\n银河窗口 独特检索词 样本 ' + i + '\n',
      { title: '检索样本' + i },
    );
  }
  const { searchRoutes } = await import('./search.js');
  app = Fastify();
  await app.register(jwt, { secret: 'search-route-test-secret' });
  await app.register(searchRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const TERM = encodeURIComponent('银河窗口');

function search(query: string) {
  return app.inject({
    method: 'GET',
    url: '/api/search' + query,
    headers: { authorization: 'Bearer ' + token },
  });
}

test('GET /api/search 不带 limit 时行为不变（默认 12 条上限）', async () => {
  const res = await search('?q=' + TERM);
  assert.equal(res.statusCode, 200);
  const hits = res.json().hits as any[];
  assert.ok(hits.length >= 2, '应至少命中 2 条');
  assert.ok(hits.length <= 12);
});

test('GET /api/search?limit= 生效并夹紧到 1-30', async () => {
  const all = (await search('?q=' + TERM)).json().hits as any[];
  const one = await search('?q=' + TERM + '&limit=1');
  assert.equal(one.json().hits.length, 1);
  const two = await search('?q=' + TERM + '&limit=2');
  assert.equal(two.json().hits.length, 2);

  // 0 与负数按 1 处理；超上限按 30 处理（本测试数据量小于 30，故等于全量）
  const zero = await search('?q=' + TERM + '&limit=0');
  assert.equal(zero.json().hits.length, 1);
  const huge = await search('?q=' + TERM + '&limit=999');
  assert.equal(huge.json().hits.length, all.length);
  assert.ok(huge.json().hits.length <= 30);

  // 非数字回退默认值，不报错
  const junk = await search('?q=' + TERM + '&limit=abc');
  assert.equal(junk.statusCode, 200);
  assert.equal(junk.json().hits.length, all.length);
});

test('GET /api/search 空查询返回空数组', async () => {
  const res = await search('?q=');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().hits, []);
});

test('GET /api/search 未授权返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/search?q=' + TERM });
  assert.equal(res.statusCode, 401);
});
