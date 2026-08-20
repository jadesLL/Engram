import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-update-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  dbModule.setSetting('password_hash', bcrypt.hashSync('test-password', 4));

  const { updateRoutes } = await import('./update.js');
  app = Fastify();
  await app.register(jwt, { secret: 'update-route-test-secret' });
  await app.register(updateRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});

test('GET /api/update/state 无 sock 时 unsupported 且不泄漏明文', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/update/state',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json();
  // 测试环境既非 /app/VERSION 也无 sock → unsupported（dev 下 desktop 判定可能为 true）
  assert.equal(data.supported, false);
  assert.ok(['no-sock', 'desktop'].includes(data.reason));
  assert.equal(data.busy, false);
});

test('PUT /api/update/config 写入 .env 且 GET 明文回显（所见即所得）', async () => {
  const put = await app.inject({
    method: 'PUT',
    url: '/api/update/config',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      giteaUrl: 'https://gitea.example.com/',
      giteaRepo: 'example/ExampleProject',
      giteaAuthType: 'password',
      giteaUsername: 'example',
      giteaPassword: 'repo-pass-1',
      imageRef: 'registry.example.com/example-wiki',
      registryUsername: 'example',
      registryToken: 'secret-token-2',
    },
  });
  assert.equal(put.statusCode, 200);

  const envText = fs.readFileSync(path.join(temp, '.env'), 'utf8');
  assert.ok(envText.includes('UPDATE_GITEA_URL=https://gitea.example.com'));
  assert.ok(envText.includes('UPDATE_GITEA_AUTH_TYPE=password'));
  assert.ok(envText.includes('UPDATE_GITEA_PASSWORD=repo-pass-1'));
  assert.ok(envText.includes('UPDATE_REGISTRY_TOKEN=secret-token-2'));

  const get = await app.inject({
    method: 'GET',
    url: '/api/update/config',
    headers: { authorization: `Bearer ${token}` },
  });
  const data = get.json();
  assert.equal(data.giteaUrl, 'https://gitea.example.com');
  assert.equal(data.giteaAuthType, 'password');
  assert.equal(data.giteaUsername, 'example');
  assert.equal(data.giteaPassword, 'repo-pass-1');
  assert.equal(data.registryToken, 'secret-token-2');
});

test('PUT config 凭据空串即清除，未传字段保持不变', async () => {
  await app.inject({
    method: 'PUT',
    url: '/api/update/config',
    headers: { authorization: `Bearer ${token}` },
    payload: { giteaPassword: '', registryToken: 'secret-token-2' },
  });
  let envText = fs.readFileSync(path.join(temp, '.env'), 'utf8');
  assert.ok(!envText.includes('UPDATE_GITEA_PASSWORD='), '空串应清除凭据');
  assert.ok(envText.includes('UPDATE_GITEA_AUTH_TYPE=password'), '未传字段保留');
  assert.ok(envText.includes('UPDATE_REGISTRY_TOKEN=secret-token-2'), '其他键保留');
});

test('POST /api/update/check 未配置远端仓库时返回可判定结果（无崩溃）', async () => {
  // 清掉远端仓库配置再查：应正常返回而非 500
  fs.rmSync(path.join(temp, '.env'), { force: true });
  const res = await app.inject({
    method: 'POST',
    url: '/api/update/check',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.hasUpdate, false);
  assert.equal(data.latestVersion, null);
});

test('POST /api/update/apply 无 sock 时 400 拒绝', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/update/apply',
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.ok(String(res.json().error).includes('Docker socket'));
});

test('未认证请求被拒绝', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/update/state' });
  assert.equal(res.statusCode, 401);
});
