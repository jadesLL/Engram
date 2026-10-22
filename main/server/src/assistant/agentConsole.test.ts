import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_CONSOLE_PREFIX, normalizeOrigin, parseConsoleUrl, upstreamPath } from './agentConsole.js';

test('parseConsoleUrl：从 dsh 的启动行里取地址与 token', () => {
  const line = 'dsh web: http://127.0.0.1:3099/?token=abcDEF_123-xyz\n';
  const parsed = parseConsoleUrl(line);
  assert.ok(parsed);
  assert.equal(parsed?.token, 'abcDEF_123-xyz');
  assert.match(parsed?.url ?? '', /^http:\/\/127\.0\.0\.1:3099\/\?token=/);
  assert.equal(parseConsoleUrl('no url here'), null);
});

test('normalizeOrigin：只接受 http/https + 合法 authority', () => {
  assert.equal(normalizeOrigin('http', '127.0.0.1:18180'), 'http://127.0.0.1:18180');
  assert.equal(normalizeOrigin('https', 'nas.example.com'), 'https://nas.example.com');
  assert.equal(normalizeOrigin('ftp', '127.0.0.1'), null);
  assert.equal(normalizeOrigin('http', ''), null);
  assert.equal(normalizeOrigin('http', 'evil host'), null);
  assert.equal(normalizeOrigin('http', 'host/path'), null);
});

test('upstreamPath：剥掉 /agent-console 前缀并保留查询串', () => {
  assert.equal(upstreamPath('/agent-console/'), '/');
  assert.equal(upstreamPath('/agent-console'), '/');
  assert.equal(upstreamPath('/agent-console/api/settings/describe?x=1'), '/api/settings/describe?x=1');
  assert.equal(upstreamPath('/agent-console/api/remote.mux'), '/api/remote.mux');
  assert.equal(AGENT_CONSOLE_PREFIX, '/agent-console');
});
