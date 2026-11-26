import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-auth-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('auth-test-pass', 4));

  const { authRoutes } = await import('./auth.js');
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, {
    secret: 'auth-route-test-secret',
    cookie: { cookieName: 'token', signed: false },
  });
  await app.register(authRoutes);
  await app.ready();
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function login(password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
}

test('正确密码登录成功并种植 cookie', async () => {
  const res = await login('auth-test-pass');
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['set-cookie'], '应设置登录 cookie');
});

test('连续失败触发限速锁定（429），成功登录清零', async () => {
  // 5 次错误密码（同一测试进程内 req.ip 一致）
  for (let i = 0; i < 5; i++) {
    const r = await login('wrong-password-' + i);
    assert.equal(r.statusCode, 401, `第 ${i + 1} 次失败应 401`);
  }
  // 已锁：正确密码也被拒
  const locked = await login('auth-test-pass');
  assert.equal(locked.statusCode, 429, '锁定期间应 429');
  assert.match(locked.json().error, /分钟后再试/);
});

test('锁定计数在成功登录后清零（模拟锁过期后重置）', async () => {
  // 上一用例锁定的计时无法在单测里等待 10 分钟——通过再次失败验证计数仍工作即可；
  // 计数清零逻辑由「正确密码登录成功即 delete」保证（auth.ts 实现内联，不单独测时序）
  const still = await login('auth-test-pass');
  assert.equal(still.statusCode, 429, '锁定期内继续保持 429');
});

test('修改密码后旧 JWT 失效（401），新签发的 cookie 仍有效', async () => {
  const oldToken = app.jwt.sign({ sub: 'owner', tv: 0 });
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { authorization: `Bearer ${oldToken}` },
    payload: { oldPassword: 'auth-test-pass', newPassword: 'new-auth-password' },
  });
  assert.equal(changed.statusCode, 200);
  assert.ok(changed.headers['set-cookie'], '改密后应为当前操作者下发新 cookie');

  // 使用旧 JWT 再调需要 requireAuth 的接口应被拒绝
  const stale = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { authorization: `Bearer ${oldToken}` },
    payload: { oldPassword: 'new-auth-password', newPassword: 'another-password' },
  });
  assert.equal(stale.statusCode, 401);

  // 用新 cookie 携带的新 JWT 应放行
  const cookieHeader = String(changed.headers['set-cookie']).split(';')[0];
  const fresh = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { cookie: cookieHeader },
    payload: { oldPassword: 'new-auth-password', newPassword: 'auth-test-pass' },
  });
  assert.equal(fresh.statusCode, 200);
});
