import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * fetchRemoteDigest 的 URL 协议补全逻辑需要真实网络才能完整走到 fetch，
 * 这里用本地起一个 http 服务器验证「裸主机名 → http 前缀」路径真实可用，
 * 并断言 https registry 的 URL 拼接不再产生 unknown scheme。
 */

test('fetchRemoteDigest 裸主机名 localhost 走 http 且能取到 digest', async () => {
  const { fetchRemoteDigest } = await import('./registryApi.js');
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url?.includes('/v2/repo/manifests/latest')) {
      res.setHeader('docker-content-digest', 'sha256:abc123');
      res.statusCode = 200;
      res.end('{}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const digest = await fetchRemoteDigest(`127.0.0.1:${port}`, 'repo', { username: '', token: '' });
    assert.equal(digest, 'sha256:abc123');
  } finally {
    server.close();
  }
});

test('fetchRemoteDigest 带 https 前缀的 registry 原样使用（不重复加协议）', async () => {
  const { fetchRemoteDigest } = await import('./registryApi.js');
  // https 指向必然失败的地址：断言错误来自网络层（fetch failed）而非 unknown scheme
  await assert.rejects(
    () => fetchRemoteDigest('https://invalid.invalid:1', 'repo', { username: '', token: '' }),
    (e: Error & { cause?: { message?: string } }) => {
      assert.equal(e.message, 'fetch failed');
      assert.notEqual(e.cause?.message, 'unknown scheme');
      return true;
    },
  );
});
