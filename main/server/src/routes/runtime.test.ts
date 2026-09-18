import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { runtimeRoutes } from './runtime.js';

test('runtime capabilities preserve the complete server feature set', async () => {
  const app = Fastify();
  await app.register(runtimeRoutes);
  const response = await app.inject({ method: 'GET', url: '/api/runtime/capabilities' });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.deepEqual(payload.syncRoles, ['none', 'hub', 'member']);
  assert.equal(payload.features.agent, true);
  assert.equal(payload.features.serverUpdate, true);
  await app.close();
});
