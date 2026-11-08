import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  builtinAgentSkillRoot,
  cliConfigPath,
  cliScriptPath,
  cliShimDir,
  cliShimPath,
  cliShimText,
  ensureLocalAgentCli,
  resolveCliRuntime,
  writeCliShim,
  type CliRuntime,
} from './cliShim.js';

const RUNTIME: CliRuntime = {
  nodePath: 'C:/node/node.exe',
  scriptPath: 'C:/app/dist/cli/cli.js',
  command: '"C:/node/node.exe" "C:/app/dist/cli/cli.js"',
  shimPath: '',
  available: true,
};

function runtimeIn(home: string, platform: NodeJS.Platform = 'linux'): CliRuntime {
  return { ...RUNTIME, shimPath: cliShimPath(home, platform) };
}

test('Windows 包装脚本：@echo off + 引号包住 node/script + 原样转发参数', () => {
  assert.equal(
    cliShimText(runtimeIn(os.tmpdir(), 'win32'), 'win32'),
    '@echo off\r\n"C:/node/node.exe" "C:/app/dist/cli/cli.js" %*\r\n',
  );
});

test('POSIX 包装脚本：sh + exec + "$@"', () => {
  assert.equal(
    cliShimText(runtimeIn(os.tmpdir(), 'linux'), 'linux'),
    '#!/bin/sh\nexec "C:/node/node.exe" "C:/app/dist/cli/cli.js" "$@"\n',
  );
});

test('resolveCliRuntime：cli.js 不存在时 available=false 并给出原因；存在时 command 带引号', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cli-shim-'));
  try {
    const missing = resolveCliRuntime(home, {
      nodePath: '/usr/local/bin/node',
      scriptPath: path.join(home, 'nope', 'cli.js'),
      platform: 'linux',
      exists: () => false,
    });
    assert.equal(missing.available, false);
    assert.match(missing.error || '', /找不到 engram CLI 入口/);
    assert.equal(missing.shimPath, path.join(home, '.engram', 'bin', 'engram'));

    const ready = resolveCliRuntime(home, {
      nodePath: '/usr/local/bin/node',
      scriptPath: '/app/server/dist/cli/cli.js',
      platform: 'linux',
      exists: (file) => file === '/app/server/dist/cli/cli.js',
    });
    assert.equal(ready.available, true);
    assert.equal(ready.command, '"/usr/local/bin/node" "/app/server/dist/cli/cli.js"');
    assert.equal(ready.error, undefined);
    // 未注入 node 时用进程自身的 Node（非 Electron 环境即真实 Node）
    assert.equal(resolveCliRuntime(home, { scriptPath: '/x/cli.js', exists: () => true }).nodePath, process.execPath);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeCliShim 幂等：内容没变不重写；POSIX 置可执行位', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cli-shim-'));
  try {
    const runtime = runtimeIn(home, 'linux');
    const file = writeCliShim(home, runtime, 'linux');
    assert.equal(file, path.join(home, '.engram', 'bin', 'engram'));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.ok(text.includes('C:/app/dist/cli/cli.js'));
    const first = fs.statSync(file).mtimeMs;
    assert.equal(writeCliShim(home, runtime, 'linux'), file);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.ok(fs.statSync(file).mtimeMs >= first);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensureLocalAgentCli：注入运行时后写 shim、PATH 前置 shim 目录、给内置 Agent 装 engram skill', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cli-ensure-'));
  try {
    const runtime = runtimeIn(home, 'linux');
    const skillRoot = path.join(home, 'data', 'dsh', 'skills');
    const result = ensureLocalAgentCli(home, { runtime, skillRoot });
    assert.equal(result.cli.available, true);
    const shimDir = path.dirname(runtime.shimPath);
    assert.equal(fs.existsSync(runtime.shimPath), true);
    assert.ok((result.env.PATH || '').startsWith(shimDir + path.delimiter), 'PATH 必须以 shim 目录开头');
    assert.equal(result.env.Path, undefined, 'Windows 别名 Path 不能与 PATH 同时存在');
    const skillFile = path.join(skillRoot, 'engram', 'SKILL.md');
    assert.equal(fs.existsSync(skillFile), true, '内置 Agent 的 DSH_HOME 由调用方指定，skill 必须装到那里');
    const skill = fs.readFileSync(skillFile, 'utf8');
    assert.ok(skill.includes('engram status'), '内置 Agent 走 PATH 里的 engram，skill 用简写命令');
    assert.doesNotMatch(skill, /\{\{ENGRAM\}\}/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI 路径与配置路径约定', () => {
  assert.equal(path.basename(cliScriptPath()), 'cli.js');
  assert.equal(path.basename(path.dirname(cliScriptPath())), 'cli');
  assert.equal(cliShimDir('/home/u'), path.join('/home/u', '.engram', 'bin'));
  assert.equal(cliShimPath('/home/u', 'win32'), path.join('/home/u', '.engram', 'bin', 'engram.cmd'));
  assert.equal(cliShimPath('/home/u', 'linux'), path.join('/home/u', '.engram', 'bin', 'engram'));
  assert.equal(cliConfigPath('/home/u'), path.join('/home/u', '.engram', 'config.json'));
  assert.equal(builtinAgentSkillRoot('/home/u', {}), path.join('/home/u', '.dsh', 'skills'));
  assert.equal(builtinAgentSkillRoot('/home/u', { DSH_HOME: '/data/dsh' }), path.join('/data/dsh', 'skills'));
});
