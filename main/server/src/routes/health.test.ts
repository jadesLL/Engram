import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

import { healthRoutes } from './health.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-health-'));
process.env.DATA_DIR = temp;

async function makeApp() {
  const app = Fastify();
  await app.register(healthRoutes);
  return app;
}

after(() => {
  delete process.env.DIRECT_ACCESS_URL;
  fs.rmSync(temp, { recursive: true, force: true });
});

test('/health keeps the historical plain-text response when DIRECT_ACCESS_URL is unset', async () => {
  delete process.env.DIRECT_ACCESS_URL;
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  await app.close();
});

test('/health announces direct when DIRECT_ACCESS_URL is set', async () => {
  process.env.DIRECT_ACCESS_URL = 'http://direct.example.com:18080';
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: 'ok', direct: 'http://direct.example.com:18080' });
  await app.close();
});

test('/health returns CORS credential headers for local launcher origins', async () => {
  process.env.DIRECT_ACCESS_URL = 'http://direct.example.com:18080';
  const app = await makeApp();
  for (const origin of ['https://localhost', 'http://localhost:8100', 'https://127.0.0.1']) {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    assert.equal(res.headers['access-control-allow-origin'], origin, `origin=${origin}`);
    assert.equal(res.headers['access-control-allow-credentials'], 'true', `origin=${origin}`);
    assert.equal(res.headers['cache-control'], 'no-store', `origin=${origin}`);
  }
  await app.close();
});

test('/health does not leak CORS headers to arbitrary origins', async () => {
  process.env.DIRECT_ACCESS_URL = 'http://direct.example.com:18080';
  const app = await makeApp();
  const res = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
  await app.close();
});
