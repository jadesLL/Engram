import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerOfficeRetired, retireLegacyDockerOffice } from './officeRuntime.js';

test('Docker 生产运行时取消 Office，桌面与测试运行时保持原有能力', () => {
  assert.equal(dockerOfficeRetired(true, 'production'), true);
  assert.equal(dockerOfficeRetired(false, 'production'), false);
  assert.equal(dockerOfficeRetired(true, 'test'), false);
});

test('旧 Office sidecar 只清理同一部署，容器删除不携带卷删除', async () => {
  const calls: unknown[] = [];
  const self = { Id: 'app', Config: { Image: 'engram:new', Labels: { 'com.docker.compose.project': 'main' } } };
  const office = { Id: 'office', State: { Running: true }, Config: { Image: 'onlyoffice/documentserver:9.4.0', Labels: { 'com.docker.compose.project': 'main', 'com.docker.compose.service': 'onlyoffice' } } };
  const engine = {
    inspectContainer: async (id: string) => (id === 'app' ? self : office) as any,
    stopContainer: async (...args: unknown[]) => { calls.push(['stop', ...args]); },
    removeContainer: async (...args: unknown[]) => { calls.push(['remove', ...args]); },
  };
  assert.equal(await retireLegacyDockerOffice({ retired: true, socket: true, selfId: 'app', engine }), true);
  assert.deepEqual(calls, [['stop', 'office'], ['remove', 'office', false, false]]);
  calls.length = 0;
  office.Config.Labels['com.docker.compose.project'] = 'other-project';
  assert.equal(await retireLegacyDockerOffice({ retired: true, socket: true, selfId: 'app', engine }), false);
  assert.deepEqual(calls, []);
  office.Config.Labels['com.docker.compose.project'] = 'main';
  (self.Config.Labels as Record<string, string>)['com.engram.feature'] = 'preview';
  assert.equal(await retireLegacyDockerOffice({ retired: true, socket: true, selfId: 'app', engine }), false);
  assert.deepEqual(calls, []);
  assert.equal(await retireLegacyDockerOffice({ retired: false, socket: true, engine }), false);
});
