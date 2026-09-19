import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { runtimeRoutes } from './runtime.js';
import { officeConfigured } from '../office/service.js';
import { isDesktopMode } from '../lib/runtimeMode.js';

async function capabilities() {
  const app = Fastify();
  await app.register(runtimeRoutes);
  const response = await app.inject({ method: 'GET', url: '/api/runtime/capabilities' });
  await app.close();
  assert.equal(response.statusCode, 200);
  return response.json();
}

test('runtime capabilities preserve the complete server feature set', async () => {
  const payload = await capabilities();
  assert.deepEqual(payload.syncRoles, ['none', 'hub', 'member']);
  assert.equal(payload.features.agent, true);
  assert.equal(payload.features.serverUpdate, true);
});

test('onlyOffice and runtime flags follow the same predicates the app uses', async () => {
  const payload = await capabilities();
  assert.equal(payload.features.onlyOffice, officeConfigured());
  assert.equal(payload.runtime, isDesktopMode() ? 'desktop' : 'server');
  assert.equal(payload.localFirst, isDesktopMode());
});
