import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 多个 test 文件并行运行时，默认 DATA_DIR 会共用同一个 wiki.db，偶发 SQLITE_BUSY：
// 导入 db 链（agentConsole → config → lib/db）之前先把 DATA_DIR 指到本测试自己的临时目录。
const DATA_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-console-test-'));
process.env.DATA_DIR = DATA_TEMP;
after(async () => {
  try {
    const { db } = await import('../lib/db.js');
    db.close();
  } catch { /* 未打开或已关闭 */ }
  fs.rmSync(DATA_TEMP, { recursive: true, force: true });
});

const { AGENT_CONSOLE_PREFIX, normalizeOrigin, parseConsoleUrl, upstreamPath } = await import('./agentConsole.js');

test('parseConsoleUrl：从 dsh 的启动行里取地址与 token', () => {
  const line = 'dsh web: http://127.0.0.1:3099/?token=abcDEF_123-xyz\n';
  const parsed = parseConsoleUrl(line);
  assert.ok(parsed);
  assert.equal(parsed?.token, 'abcDEF_123-xyz');
  assert.match(parsed?.url ?? '', /^http:\/\/127\.0\.0\.1:3099\/\?token=/);
  assert.equal(parseConsoleUrl('no url here'), null);
});

// HTTPS 部署下 --public-url 是 https，dsh 打印的启动行也是 https（NAS 域名 + 反代），
// 只认 http 会让控制台永远等不到地址、45 秒后报「控制台启动超时」。
test('parseConsoleUrl：HTTPS 部署（public-url 为 https）也能取到 token', () => {
  const line =
    'dsh web: https://engram.example.com:11111/agent-console/?token=BzS_31V70YT0504gc1W52rKjLp9mgb80TT5S2djk9Mc\n';
  const parsed = parseConsoleUrl(line);
  assert.ok(parsed);
  assert.equal(parsed?.token, 'BzS_31V70YT0504gc1W52rKjLp9mgb80TT5S2djk9Mc');
  assert.equal(parsed?.url, 'https://engram.example.com:11111/agent-console/?token=BzS_31V70YT0504gc1W52rKjLp9mgb80TT5S2djk9Mc');
});

test('parseConsoleUrl：只认 http(s)，其它协议与残缺行返回 null', () => {
  assert.equal(parseConsoleUrl('dsh web: ftp://127.0.0.1:3099/?token=x'), null);
  assert.equal(parseConsoleUrl('dsh web: http://'), null);
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
