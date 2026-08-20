import test from 'node:test';
import assert from 'node:assert/strict';
import { repoAuthHeaders, type RepoAuth } from './giteaRelease.js';

test('repoAuthHeaders 无凭据返回空（匿名访问公开仓库）', () => {
  assert.deepEqual(repoAuthHeaders(undefined), {});
  assert.deepEqual(repoAuthHeaders({ type: 'token' }), {});
  assert.deepEqual(repoAuthHeaders({ type: 'password', username: 'u' }), {});
});

test('repoAuthHeaders token 方式生成 token 头', () => {
  assert.deepEqual(repoAuthHeaders({ type: 'token', token: 'abc123' }), {
    Authorization: 'token abc123',
  });
});

test('repoAuthHeaders password 方式生成 Basic 头', () => {
  const headers = repoAuthHeaders({ type: 'password', username: 'example', password: 'p@ss' });
  const expected = `Basic ${Buffer.from('example:p@ss').toString('base64')}`;
  assert.deepEqual(headers, { Authorization: expected });
});

test('repoAuthHeaders password 缺一不可时回退 token', () => {
  const auth: RepoAuth = { type: 'password', username: 'u', token: 'tk' };
  assert.deepEqual(repoAuthHeaders(auth), { Authorization: 'token tk' });
});
