import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dshHome,
  dshPatchPath,
  dshRegistered,
  getDshStatus,
  registerDshMcp,
  unregisterDshMcp,
} from './dshConfig.js';

function tmpPatch(content = ''): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-')), 'cordis.patch.yml');
  if (content) fs.writeFileSync(file, content);
  return file;
}

test('dshHome 尊重 DSH_HOME 环境变量，缺省为 ~/.dsh', () => {
  const old = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = 'D:\\tmp\\dsh-home';
    assert.equal(dshHome(), 'D:\\tmp\\dsh-home');
    delete process.env.DSH_HOME;
    assert.ok(dshHome().endsWith('.dsh'));
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
  }
});

test('无文件时注册：生成头注释 + engram 块', () => {
  const file = tmpPatch();
  registerDshMcp('http://127.0.0.1:18180/mcp', 'tok-1', file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes("$DSH_HOME/cordis.patch.yml"));
  assert.ok(text.includes("- id: mcp-engram"));
  assert.ok(text.includes("url: http://127.0.0.1:18180/mcp"));
  assert.ok(text.includes("Authorization: 'Bearer tok-1'"));
  assert.ok(dshRegistered(file));
});

test('重复注册：整块替换为新 token，文件头注释保留', () => {
  const file = tmpPatch();
  registerDshMcp('http://127.0.0.1:18180/mcp', 'tok-1', file);
  registerDshMcp('http://127.0.0.1:18080/mcp', 'tok-2', file);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/mcp-engram/g)?.length, 1);
  assert.ok(text.includes("'Bearer tok-2'"));
  assert.ok(!text.includes('tok-1'));
  assert.ok(text.includes('url: http://127.0.0.1:18080/mcp'));
  assert.ok(text.includes("$DSH_HOME/cordis.patch.yml"));
});

const USER_LIKE_FILE = [
  '﻿' + '# Machine-local DSH user patch layer ($DSH_HOME/cordis.patch.yml).',
  "# Applied over EVERY profile's own cordis.patch.yml (web / headless / sdk / acp / ...),",
  '# so keep this a top-level YAML array of loader patch entries.',
  '',
  '# 另一个手写 MCP 服务器，Authorization 用 !!js 读环境变量',
  '- insert:',
  '    - id: mcp-web',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: web',
  '        transport: streamable-http',
  '        url: http://localhost:3000/mcp',
  '        headers:',
  "          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'",
  '',
  '# 旧 Engram 注释，应随块一起消失',
  '- insert:',
  '    - id: mcp-engram',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: engram',
  '        transport: streamable-http',
  '        url: http://127.0.0.1:18180/mcp',
  '        headers:',
  "          Authorization: 'Bearer lwiki_old'",
  '',
].join('\r\n');

test('真实形态文件（BOM/CRLF/!!js/多块）：注册只替换 engram 块，其余逐字保留', () => {
  const file = tmpPatch(USER_LIKE_FILE);
  registerDshMcp('http://127.0.0.1:9999/mcp', 'tok-new', file);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/mcp-engram/g)?.length, 1);
  assert.ok(text.includes("'Bearer tok-new'"));
  assert.ok(!text.includes('lwiki_old'));
  assert.ok(!text.includes('旧 Engram 注释'));
  // 其他块与其 !!js 行不动
  assert.ok(text.includes('!!js'));
  assert.ok(text.includes('- id: mcp-web'));
  assert.ok(text.includes('serverName: web'));
  assert.ok(text.includes('# 另一个手写 MCP 服务器'));
  // 文件头注释保留（BOM 被剥离）
  assert.ok(text.includes("$DSH_HOME/cordis.patch.yml"));
  assert.ok(!text.startsWith('﻿'));
});

test('注销：删 engram 块及其注释，保留其他块', () => {
  const file = tmpPatch(USER_LIKE_FILE);
  unregisterDshMcp(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('mcp-engram'));
  assert.ok(!text.includes('旧 Engram 注释'));
  assert.ok(!text.includes('lwiki_old'));
  assert.ok(dshRegistered(file) === false);
  assert.ok(text.includes('- id: mcp-web'));
  assert.ok(text.includes('!!js'));
  // 注销后可再次注册
  registerDshMcp('http://127.0.0.1:18180/mcp', 'tok-3', file);
  assert.ok(dshRegistered(file));
});

test('注销幂等：无文件、无块均安全', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-')), 'nope.yml');
  unregisterDshMcp(missing); // 不抛错
  const file = tmpPatch('# 只有注释\n');
  unregisterDshMcp(file);
  assert.ok(fs.readFileSync(file, 'utf8').includes('# 只有注释'));
  assert.equal(dshRegistered(file), false);
});

test('getDshStatus 汇总安装/登录/注册状态', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const s1 = getDshStatus();
    assert.equal(s1.installed, true);
    assert.equal(s1.loggedIn, false);
    assert.equal(s1.registered, false);
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrecords:\n  k: v\n');
    const s2 = getDshStatus();
    assert.equal(s2.loggedIn, true);
    registerDshMcp('http://127.0.0.1:18180/mcp', 'tok', dshPatchPath(home));
    assert.equal(getDshStatus().registered, true);
    assert.equal(getDshStatus().home, home);
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
  }
});
