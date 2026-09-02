import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-health-'));
process.env.DATA_DIR = temp;

function makeApp() {
  const app = Fastify();
  app.get('/health', async () => 'ok');
  return app;
}

after(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

test('/health returns the historical plain-text response', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  await app.close();
});
