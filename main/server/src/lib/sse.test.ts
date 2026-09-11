import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sse } from './sse.js';

/**
 * SSE 必须立刻 flush 响应头并写一条注释：
 * 否则响应头只暂存在 Node 缓冲里，反代在上游读超时（Lucky/nginx 常见 30s）
 * 前收不到任何字节，判上游无响应返回 502。
 * 阈值取 3s：远大于正常即时（毫秒级），又远小于 keepalive 间隔（15s）——
 * 一旦 flush 缺失，首字节要等到第一次 keepalive，必失败。
 */
test('sse 立即发出响应头与首字节，不等 keepalive', async () => {
  const app = Fastify();
  app.get('/s', async (req, reply) => {
    const stream = sse(reply);
    const timer = setInterval(() => {
      try { (reply.raw as import('node:http').ServerResponse).write(': ping\n\n'); } catch { /* closed */ }
    }, 15_000);
    timer.unref();
    req.raw.on('close', () => { clearInterval(timer); try { stream.close(); } catch { /* closed */ } });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const ac = new AbortController();
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/s`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const { value } = await res.body!.getReader().read();
  const elapsed = Date.now() - started;
  assert.ok(value && value.length > 0, '首个数据块应非空');
  assert.ok(elapsed < 3000, `首字节应远早于 keepalive 间隔，实际 ${elapsed}ms`);
  ac.abort();
  await app.close();
});
