import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexCliOnPath,
  codexConfigPath,
  codexHome,
  codexRegistered,
  getCodexStatus,
  registerCodexMcp,
  unregisterCodexMcp,
} from './codexConfig.js';

function tmpConfig(content = ''): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-')), 'config.toml');
  if (content) fs.writeFileSync(file, content);
  return file;
}

test('codexHome 尊重 CODEX_HOME 环境变量，缺省为 ~/.codex', () => {
  const old = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = 'D:\\tmp\\codex-home';
    assert.equal(codexHome(), 'D:\\tmp\\codex-home');
    assert.ok(codexConfigPath().endsWith('config.toml'));
    delete process.env.CODEX_HOME;
    assert.ok(codexHome().endsWith('.codex'));
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = old;
  }
});

test('无文件时注册：生成注释 + [mcp_servers.engram] 表', () => {
  const file = tmpConfig();
  registerCodexMcp('http://127.0.0.1:18180/mcp', 'tok-1', file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('[mcp_servers.engram]'));
  assert.ok(text.includes('url = "http://127.0.0.1:18180/mcp"'));
  assert.ok(text.includes('http_headers = { "Authorization" = "Bearer tok-1" }'));
  assert.ok(text.includes('Engram 知识库 MCP'));
  assert.ok(codexRegistered(file));
  // 无文件时也应被 getCodexStatus 判为未注册
  const missing = path.join(path.dirname(file), 'nope.toml');
  assert.equal(codexRegistered(missing), false);
});

test('重复注册：整块替换为新 token，块外的配置保留', () => {
  const file = tmpConfig();
  registerCodexMcp('http://127.0.0.1:18180/mcp', 'tok-1', file);
  registerCodexMcp('http://127.0.0.1:18080/mcp', 'tok-2', file);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^\[mcp_servers\.engram\]$/gm)?.length, 1);
  assert.ok(text.includes('"Bearer tok-2"'));
  assert.ok(!text.includes('tok-1'));
  assert.ok(text.includes('url = "http://127.0.0.1:18080/mcp"'));
  assert.ok(text.includes('Engram 知识库 MCP'));
});

const USER_LIKE_FILE = [
  '\uFEFFmodel = "gpt-5-codex"',
  'sandbox_mode = "workspace-write"',
  '',
  '[mcp_servers.node_repl]',
  'command = "node_repl"',
  'args = []',
  '',
  '[mcp_servers.node_repl.env]',
  'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"',
  '',
  '# 旧 Engram 注释，应随块一起消失',
  '[mcp_servers.engram]',
  'url = "http://127.0.0.1:18180/mcp"',
  'http_headers = { "Authorization" = "Bearer lwiki_old" }',
  '',
  '[windows]',
  'sandbox = "unelevated"',
  '',
].join('\r\n');

test('真实形态文件（BOM/CRLF/其他表）：注册只替换 engram 块', () => {
  const file = tmpConfig(USER_LIKE_FILE);
  registerCodexMcp('http://127.0.0.1:9999/mcp', 'tok-new', file);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^\[mcp_servers\.engram\]$/gm)?.length, 1);
  assert.ok(text.includes('"Bearer tok-new"'));
  assert.ok(!text.includes('lwiki_old'));
  assert.ok(!text.includes('旧 Engram 注释'));
  // 其他表与其子表逐字保留，换行风格不变
  assert.ok(text.includes('[mcp_servers.node_repl]'));
  assert.ok(text.includes('[mcp_servers.node_repl.env]'));
  assert.ok(text.includes('[windows]'));
  assert.ok(text.includes('sandbox = "unelevated"'));
  assert.ok(text.includes('model = "gpt-5-codex"'));
  assert.ok(text.includes('\r\n'));
  assert.ok(!text.startsWith('\uFEFF'));
  // engram 块插到文件末尾，未污染 node_repl.env 子表
  assert.ok(text.lastIndexOf('[mcp_servers.engram]') > text.lastIndexOf('[windows]'));
});

test('注销：删 engram 块及其注释，保留其他表', () => {
  const file = tmpConfig(USER_LIKE_FILE);
  unregisterCodexMcp(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('[mcp_servers.engram]'));
  assert.ok(!text.includes('旧 Engram 注释'));
  assert.ok(!text.includes('lwiki_old'));
  assert.equal(codexRegistered(file), false);
  assert.ok(text.includes('[mcp_servers.node_repl]'));
  assert.ok(text.includes('[mcp_servers.node_repl.env]'));
  assert.ok(text.includes('[windows]'));
  // 注销后可再次注册
  registerCodexMcp('http://127.0.0.1:18180/mcp', 'tok-3', file);
  assert.ok(codexRegistered(file));
});

test('注销幂等：无文件、无块均安全', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-')), 'nope.toml');
  unregisterCodexMcp(missing); // 不抛错
  const file = tmpConfig('# 只有注释\n');
  unregisterCodexMcp(file);
  assert.ok(fs.readFileSync(file, 'utf8').includes('# 只有注释'));
  assert.equal(codexRegistered(file), false);
});

test('仅含 Engram 块的文件：注销后留下块头注释，可再次注册', () => {
  const file = tmpConfig();
  registerCodexMcp('http://127.0.0.1:18180/mcp', 'tok-1', file);
  unregisterCodexMcp(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(codexRegistered(file), false);
  assert.ok(text.includes('Engram 知识库 MCP'));
  assert.ok(!text.includes('[mcp_servers.engram]'));
  registerCodexMcp('http://127.0.0.1:18180/mcp', 'tok-2', file);
  assert.ok(fs.readFileSync(file, 'utf8').includes('[mcp_servers.engram]'));
  assert.ok(codexRegistered(file));
});

test('codexCliOnPath 按 PATH 与扩展名探测，忽略空段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'codex.CMD' : 'codex');
  fs.writeFileSync(bin, '');
  assert.equal(codexCliOnPath({ PATH: `${dir}${path.delimiter}` }), true);
  assert.equal(codexCliOnPath({ PATH: path.join(dir, 'missing'), Path: '' }), false);
  assert.equal(codexCliOnPath({ PATH: '' }), false);
});

test('getCodexStatus 汇总安装/注册状态', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const s1 = getCodexStatus();
    assert.equal(s1.installed, true); // CODEX_HOME 存在即视为装过
    assert.equal(s1.registered, false);
    assert.equal(s1.home, home);
    assert.equal(s1.configPath, codexConfigPath(home));
    registerCodexMcp('http://127.0.0.1:18180/mcp', 'tok', codexConfigPath(home));
    assert.equal(getCodexStatus().registered, true);
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = old;
  }
});
