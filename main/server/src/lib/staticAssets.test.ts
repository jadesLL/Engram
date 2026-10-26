import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

import { loadStaticAssetCache, registerStaticAssetCache } from './staticAssets.js';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-static-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<main>cached shell</main>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'window.cached = true;');
  return root;
}

test('静态资源按需加载：启动只预读 index.html，首次请求再读盘并缓存（etag/304/HEAD 语义不变）', async () => {
  const root = makeRoot();
  const app = Fastify();
  const cache = await registerStaticAssetCache(app, root);

  // 启动时只发现清单、只预读 index.html——其余文件不得被 readFile
  assert.equal(cache.files, 2);
  assert.equal(cache.assets.size, 1);
  assert.ok(cache.assets.has('/index.html'));
  assert.equal(cache.totalBytes, fs.statSync(path.join(root, 'index.html')).size);
  assert.ok(cache.pending.has('/assets/app.js'));

  // 未预读的文件首次请求能命中（此时才读盘），响应头与旧实现一致
  const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(script.statusCode, 200);
  assert.equal(script.body, 'window.cached = true;');
  assert.match(script.headers['content-type'] || '', /application\/javascript/);
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(script.headers.etag);
  assert.ok(cache.assets.has('/assets/app.js'));
  assert.equal(cache.totalBytes, 46);

  // 命中内存缓存后 ETag/304 与 HEAD 行为保持
  const unchanged = await app.inject({
    method: 'GET',
    url: '/assets/app.js',
    headers: { 'if-none-match': String(script.headers.etag) },
  });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, '');

  const head = await app.inject({ method: 'HEAD', url: '/assets/app.js' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '21');

  const spa = await app.inject({ method: 'GET', url: '/page/example' });
  assert.equal(spa.statusCode, 200);
  assert.equal(spa.body, '<main>cached shell</main>');
  assert.equal(spa.headers['cache-control'], 'no-cache');

  const apiMissing = await app.inject({ method: 'GET', url: '/api/missing' });
  assert.equal(apiMissing.statusCode, 404);
  assert.deepEqual(apiMissing.json(), { error: '资源不存在' });

  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('已按需加载的资源在构建目录消失后仍可服务，SPA fallback 不受影响', async () => {
  const root = makeRoot();
  const app = Fastify();
  await registerStaticAssetCache(app, root);

  // 先请求一次把资源读进内存（旧实现是启动时整包读入）
  const first = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(first.statusCode, 200);
  fs.rmSync(root, { recursive: true, force: true });

  const cached = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body, 'window.cached = true;');

  // index.html 常驻：/ 与未知前端路径的 SPA fallback 仍然可用
  const spa = await app.inject({ method: 'GET', url: '/page/example' });
  assert.equal(spa.statusCode, 200);
  assert.equal(spa.body, '<main>cached shell</main>');

  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('构建目录不存在时缓存为空且不抛错', async () => {
  const missing = path.join(os.tmpdir(), 'engram-static-missing-' + Date.now());
  const cache = await loadStaticAssetCache(missing);
  assert.equal(cache.files, 0);
  assert.equal(cache.totalBytes, 0);
  assert.equal(cache.assets.size, 0);
  assert.equal(cache.pending.size, 0);
});
