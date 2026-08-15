import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

import { registerStaticAssetCache } from './staticAssets.js';

test('static files and SPA fallback remain available after the build directory disappears', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-static-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<main>cached shell</main>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'window.cached = true;');

  const app = Fastify();
  const cache = await registerStaticAssetCache(app, root);
  assert.equal(cache.files, 2);
  assert.equal(cache.totalBytes, 46);
  fs.rmSync(root, { recursive: true, force: true });

  const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(script.statusCode, 200);
  assert.equal(script.body, 'window.cached = true;');
  assert.match(script.headers['content-type'] || '', /application\/javascript/);
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(script.headers.etag);

  const unchanged = await app.inject({
    method: 'GET',
    url: '/assets/app.js',
    headers: { 'if-none-match': String(script.headers.etag) },
  });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, '');

  const spa = await app.inject({ method: 'GET', url: '/page/example' });
  assert.equal(spa.statusCode, 200);
  assert.equal(spa.body, '<main>cached shell</main>');
  assert.equal(spa.headers['cache-control'], 'no-cache');

  const head = await app.inject({ method: 'HEAD', url: '/assets/app.js' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '21');

  const apiMissing = await app.inject({ method: 'GET', url: '/api/missing' });
  assert.equal(apiMissing.statusCode, 404);
  assert.deepEqual(apiMissing.json(), { error: '资源不存在' });

  await app.close();
});
