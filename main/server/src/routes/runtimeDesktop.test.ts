import test from 'node:test';
import assert from 'node:assert/strict';

// 能力协商的取值在 config 模块加载时定型，因此正例必须在设置环境变量之后再动态引入被测路由。
process.env.HOST = '127.0.0.1';
process.env.ENGRAM_WEB_DIST = '/tmp/engram-runtime-test-web';
process.env.ONLYOFFICE_JWT_SECRET = 'test-secret';
process.env.OFFICE_EDITOR_ENABLED = 'true';

test('configured office editor and desktop shell are reported as available', async () => {
  const Fastify = (await import('fastify')).default;
  const { runtimeRoutes } = await import('./runtime.js');
  const app = Fastify();
  await app.register(runtimeRoutes);
  const response = await app.inject({ method: 'GET', url: '/api/runtime/capabilities' });
  await app.close();
  const payload = response.json();
  assert.equal(payload.runtime, 'desktop');
  assert.equal(payload.localFirst, true);
  assert.equal(payload.features.onlyOffice, true);
});
