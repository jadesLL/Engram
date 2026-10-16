import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-research-access-'));
process.env.DATA_DIR = temp;
let app: ReturnType<typeof Fastify>;
let db: typeof import('../lib/db.js').db;
const memberToken = 'research-member-fixture';

before(async () => {
  const storage = await import('../lib/db.js'); db = storage.db; storage.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android fixture', memberToken);
  const { customerResearchRoutes } = await import('./customerResearch.js');
  app = Fastify();
  await app.register(jwt, { secret: 'customer-research-route-fixture' });
  await app.register(customerResearchRoutes);
  await app.ready();
});

after(async () => {
  await app.close(); db.close(); fs.rmSync(temp, {recursive:true, force:true});
});

test('Android 成员令牌可读取调研与修改模板，启动/停止按业务校验返回', async () => {
  const headers = {authorization:`Bearer ${memberToken}`};
  const list = await app.inject({method:'GET',url:'/api/customer-research',headers});
  assert.equal(list.statusCode,200);
  const rules = list.json().rules;
  const updated = await app.inject({method:'PUT',url:'/api/customer-research/rules',headers,
    payload:{workflow:rules.workflow,titles:rules.sections.map((s:{title:string})=>s.title)}});
  assert.equal(updated.statusCode,200);
  assert.equal(updated.json().version,rules.version+1);
  const start = await app.inject({method:'POST',url:'/api/customer-research',headers,payload:{customer:''}});
  assert.equal(start.statusCode,400);
  assert.match(start.json().error,/客户名称/);
  const stop = await app.inject({method:'POST',url:'/api/customer-research/stop',headers,payload:{taskId:'missing'}});
  assert.equal(stop.statusCode,400);
  assert.match(stop.json().error,/没有可停止/);
});

test('调研全部入口拒绝未知令牌，owner 登录态仍可访问', async () => {
  for (const [method,url] of [['GET','/api/customer-research'],['POST','/api/customer-research'],
    ['PUT','/api/customer-research/rules'],['POST','/api/customer-research/stop']] as const) {
    const denied = await app.inject({method,url,headers:{authorization:'Bearer unknown'}});
    assert.equal(denied.statusCode,401,`${method} ${url}`);
  }
  const token = app.jwt.sign({sub:'owner'});
  assert.equal((await app.inject({method:'GET',url:'/api/customer-research',headers:{authorization:`Bearer ${token}`}})).statusCode,200);
});
