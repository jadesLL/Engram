import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repoAuthHeaders,
  latestReleaseUrl,
  parseLatestReleaseResponse,
  type RepoAuth,
} from './giteaRelease.js';

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

test('latestReleaseUrl 拼接并容忍末尾斜杠', () => {
  assert.equal(
    latestReleaseUrl('https://gitea.example.com/', 'example/ExampleProject'),
    'https://gitea.example.com/api/v1/repos/example/ExampleProject/releases/latest',
  );
});

test('parseLatestReleaseResponse 正常响应解析版本号与附件', () => {
  const body = JSON.stringify({
    tag_name: 'v1.2.3',
    assets: [
      { name: 'Setup 1.2.3.exe', browser_download_url: 'https://x/Setup.exe', size: 100 },
      { name: '无地址附件', size: 1 },
    ],
  });
  const r = parseLatestReleaseResponse(200, body);
  assert.equal(r?.tag, 'v1.2.3');
  assert.equal(r?.version, '1.2.3');
  assert.equal(r?.assets.length, 1);
  assert.equal(r?.assets[0].name, 'Setup 1.2.3.exe');
});

test('parseLatestReleaseResponse 404 返回 null，非 2xx 抛错带 message', () => {
  assert.equal(parseLatestReleaseResponse(404, '{}'), null);
  assert.throws(
    () => parseLatestReleaseResponse(401, JSON.stringify({ message: 'token 无效' })),
    /仓库 API 401: token 无效/,
  );
});
