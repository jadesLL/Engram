import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupLegacyAgentConfig } from './agentLegacyConfig.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-legacy-'));
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('codex：清掉 [mcp_servers.engram] 块与 Engram 注释，其他表与注释逐字保留', () => {
  const home = tempHome();
  try {
    const configPath = path.join(home, '.codex', 'config.toml');
    writeFile(configPath, [
      '# 用户自己的头部注释',
      'model = "gpt-5"',
      '',
      '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换下面这张表）。',
      '# Engram 未启动时 Codex 照常启动，只是这组 mcp__engram__* 工具缺席。',
      '[mcp_servers.engram]',
      'url = "http://127.0.0.1:18180/mcp"',
      'http_headers = { "Authorization" = "Bearer x" }',
      '',
      '[mcp_servers.other]',
      'command = "other"',
    ].join('\n') + '\n');

    const cleaned = cleanupLegacyAgentConfig('codex', home, {});
    assert.deepEqual(cleaned, [configPath]);
    const text = fs.readFileSync(configPath, 'utf8');
    assert.equal(text.includes('[mcp_servers.engram]'), false);
    assert.equal(text.includes('mcp__engram__'), false);
    assert.ok(text.includes('# 用户自己的头部注释'));
    assert.ok(text.includes('model = "gpt-5"'));
    assert.ok(text.includes('[mcp_servers.other]'));

    // 幂等
    assert.deepEqual(cleanupLegacyAgentConfig('codex', home, {}), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('codex：只有 Engram 块时整个文件删掉；没有配置文件时不报错', () => {
  const home = tempHome();
  try {
    const configPath = path.join(home, '.codex', 'config.toml');
    writeFile(configPath, [
      '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换下面这张表）。',
      '[mcp_servers.engram]',
      'url = "http://127.0.0.1:18180/mcp"',
    ].join('\n') + '\n');
    assert.deepEqual(cleanupLegacyAgentConfig('codex', home, {}), [configPath]);
    assert.equal(fs.existsSync(configPath), false);
    assert.deepEqual(cleanupLegacyAgentConfig('codex', home, {}), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('qoder：国际版与国内版 settings.json 的 engram 条目都清，其他 MCP 与设置保留', () => {
  const home = tempHome();
  try {
    const international = path.join(home, '.qoder', 'settings.json');
    const china = path.join(home, '.qoder-cn', 'settings.json');
    writeFile(international, JSON.stringify({
      theme: 'dark',
      mcpServers: {
        engram: { type: 'http', url: 'http://127.0.0.1:18180/mcp' },
        other: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      },
    }, null, 2));
    writeFile(china, JSON.stringify({
      enabledPlugins: { 'x@y': true },
      mcpServers: { engram: { type: 'http', url: 'http://127.0.0.1:18180/mcp' } },
    }, null, 2));

    const cleaned = cleanupLegacyAgentConfig('qoder', home, {});
    assert.equal(cleaned.length, 2);

    const left = JSON.parse(fs.readFileSync(international, 'utf8'));
    assert.equal(left.theme, 'dark');
    assert.equal(Object.hasOwn(left.mcpServers, 'engram'), false);
    assert.equal(Object.hasOwn(left.mcpServers, 'other'), true);

    const right = JSON.parse(fs.readFileSync(china, 'utf8'));
    assert.deepEqual(right.enabledPlugins, { 'x@y': true });
    assert.equal(Object.hasOwn(right, 'mcpServers'), false);

    assert.deepEqual(cleanupLegacyAgentConfig('qoder', home, {}), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('workbuddy：mcp.json 的 engram 条目与旧 ~/.codebuddy/skills 一起清，用户 skill 保留', () => {
  const home = tempHome();
  try {
    const mcpPath = path.join(home, '.workbuddy', 'mcp.json');
    writeFile(mcpPath, JSON.stringify({
      mcpServers: {
        engram: { type: 'streamableHttp', url: 'http://127.0.0.1:18180/mcp' },
        other: { type: 'stdio', command: 'x' },
      },
    }, null, 2));
    const legacyRoot = path.join(home, '.codebuddy', 'skills');
    writeFile(path.join(legacyRoot, 'engram', 'SKILL.md'), '<!-- engram-managed -->\nold\n');
    writeFile(path.join(legacyRoot, 'engram-customer-research', 'SKILL.md'), '<!-- engram-managed -->\nold\n');
    writeFile(path.join(legacyRoot, 'mine', 'SKILL.md'), '用户自己的 skill\n');

    const cleaned = cleanupLegacyAgentConfig('workbuddy', home, {});
    assert.ok(cleaned.includes(mcpPath));
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.equal(Object.hasOwn(config.mcpServers, 'engram'), false);
    assert.equal(Object.hasOwn(config.mcpServers, 'other'), true);
    assert.equal(fs.existsSync(path.join(legacyRoot, 'engram', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(legacyRoot, 'engram-customer-research', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(legacyRoot, 'mine', 'SKILL.md')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('kimi-code：mcp.json 的 engram 条目清掉', () => {
  const home = tempHome();
  try {
    const mcpPath = path.join(home, '.kimi-code', 'mcp.json');
    writeFile(mcpPath, JSON.stringify({ mcpServers: { engram: { url: 'http://127.0.0.1:18180/mcp' } } }, null, 2));
    assert.deepEqual(cleanupLegacyAgentConfig('kimi-code', home, {}), [mcpPath]);
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.equal(Object.hasOwn(config, 'mcpServers'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dsh：home patch 里的 mcp-engram 条目清掉，文件随之删除', () => {
  const home = tempHome();
  try {
    const patchPath = path.join(home, '.dsh', 'cordis.patch.yml');
    writeFile(patchPath, [
      '# Machine-local DSH user patch layer ($DSH_HOME/cordis.patch.yml).',
      '',
      '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换）。',
      '- insert:',
      '    - id: mcp-engram',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: engram',
      '        transport: streamable-http',
      '        url: http://127.0.0.1:18180/mcp',
    ].join('\n') + '\n');
    const cleaned = cleanupLegacyAgentConfig('dsh', home, {});
    assert.ok(cleaned.includes(patchPath));
    assert.equal(fs.existsSync(patchPath), false);
    assert.deepEqual(cleanupLegacyAgentConfig('dsh', home, {}), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('坏 JSON 不破坏用户文件；claude / zcode 无遗留时返回空', () => {
  const home = tempHome();
  try {
    const broken = path.join(home, '.qoder', 'settings.json');
    writeFile(broken, '{ not json');
    assert.deepEqual(cleanupLegacyAgentConfig('qoder', home, {}), []);
    assert.equal(fs.readFileSync(broken, 'utf8'), '{ not json');
    assert.deepEqual(cleanupLegacyAgentConfig('claude', home, {}), []);
    assert.deepEqual(cleanupLegacyAgentConfig('zcode', home, {}), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
