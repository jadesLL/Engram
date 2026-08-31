import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

// /health 的 direct 字段（IPv6 直连发现）：env 驱动，两种形态都要验证。
// 不复用 index.ts 的完整 app（那会拖起任务队列/飞书等），此处最小化注册同款路由。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-health-'));
process.env.DATA_DIR = temp;

function makeApp() {
  const app = Fastify();
  app.get('/health', async () =>
    process.env.DIRECT_ACCESS_URL
      ? { ok: 'ok', direct: process.env.DIRECT_ACCESS_URL }
      : 'ok'
  );
  return app;
}

after(() => {
  delete process.env.DIRECT_ACCESS_URL;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('未配置 DIRECT_ACCESS_URL：纯文本 ok（历史行为不变）', async () => {
  delete process.env.DIRECT_ACCESS_URL;
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  await app.close();
});

test('配置 DIRECT_ACCESS_URL：返回 direct 地址供客户端发现', async () => {
  process.env.DIRECT_ACCESS_URL = 'http://v6.example.com:18080';
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: 'ok', direct: 'http://v6.example.com:18080' });
  await app.close();
});
