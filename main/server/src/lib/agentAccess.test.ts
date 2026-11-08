import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentClientStatus,
  agentClients,
  isAgentClientId,
  registerAgentAccess,
  unregisterAgentAccess,
  type AgentClientId,
} from './agentAccess.js';
import { cliShimPath, type CliRuntime } from './cliShim.js';

/** 测试用 CLI 运行时：只是把路径拼好，不真的跑命令 */
function runtimeFor(home: string): CliRuntime {
  return {
    nodePath: '/usr/local/bin/node',
    scriptPath: '/app/server/dist/cli/cli.js',
    command: '"/usr/local/bin/node" "/app/server/dist/cli/cli.js"',
    shimPath: cliShimPath(home, 'linux'),
    available: true,
  };
}

/** isDir 注入：只有传入的这些目录算存在 */
function onlyDirs(...dirs: string[]): (candidate: string) => boolean {
  return (candidate) => dirs.includes(candidate);
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-access-'));
}

test('检测：客户端目录存在即 installed，skill 根与命令按契约表格', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const claude = agentClientStatus('claude', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.claude')),
      exists: () => false,
    });
    assert.equal(claude.installed, true);
    assert.equal(claude.title, 'Claude Code');
    assert.equal(claude.skillPath, path.join(home, '.claude', 'skills', 'engram', 'SKILL.md'));
    assert.deepEqual(claude.skillPaths, [path.join(home, '.claude', 'skills', 'engram', 'SKILL.md')]);
    assert.equal(claude.skillsInstalled, false);
    assert.equal(claude.cliAvailable, true);
    assert.equal(claude.cliCommand, runtime.command);

    // 只检测到 claude 时，其余客户端不能误判为已安装
    for (const id of ['codex', 'dsh', 'zcode', 'kimi-code', 'workbuddy', 'qoder'] as AgentClientId[]) {
      const status = agentClientStatus(id, home, {
        runtime,
        env: { PATH: '' },
        isDir: onlyDirs(path.join(home, '.claude')),
        exists: () => false,
      });
      assert.equal(status.installed, false, id + ' 不应被判为已安装');
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('检测：环境变量优先的客户端（CODEX_HOME / DSH_HOME / KIMI_CODE_HOME）与 skill 根', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const codex = agentClientStatus('codex', home, {
      runtime,
      env: { CODEX_HOME: '/opt/codex' },
      isDir: onlyDirs('/opt/codex'),
      exists: () => false,
    });
    assert.equal(codex.installed, true);
    // Codex 的 skill 根是共享的 ~/.agents/skills，不在 $CODEX_HOME 下
    assert.equal(codex.skillPath, path.join(home, '.agents', 'skills', 'engram', 'SKILL.md'));

    const dsh = agentClientStatus('dsh', home, {
      runtime,
      env: { DSH_HOME: '/data/dsh' },
      isDir: onlyDirs('/data/dsh'),
      exists: () => false,
    });
    assert.equal(dsh.installed, true);
    assert.equal(dsh.skillPath, path.join('/data/dsh', 'skills', 'engram', 'SKILL.md'));

    const kimi = agentClientStatus('kimi-code', home, {
      runtime,
      env: { KIMI_CODE_HOME: '/opt/kimi' },
      isDir: onlyDirs('/opt/kimi'),
      exists: () => false,
    });
    assert.equal(kimi.installed, true);
    assert.equal(kimi.skillPath, path.join('/opt/kimi', 'skills', 'engram', 'SKILL.md'));

    // 变体目录由环境变量指定时只管该目录；目录不存在就不算已安装（避免往没人读的位置写 skill）
    const workbuddyEnv = agentClientStatus('workbuddy', home, {
      runtime,
      env: { WORKBUDDY_CONFIG_DIR: '/opt/workbuddy' },
      isDir: onlyDirs('/opt/workbuddy'),
      exists: () => false,
    });
    assert.equal(workbuddyEnv.installed, true);
    assert.deepEqual(workbuddyEnv.skillPaths, [path.join('/opt/workbuddy', 'skills', 'engram', 'SKILL.md')]);
    const workbuddyMissing = agentClientStatus('workbuddy', home, {
      runtime,
      env: { WORKBUDDY_CONFIG_DIR: '/opt/missing' },
      isDir: () => false,
      exists: () => false,
    });
    assert.equal(workbuddyMissing.installed, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('检测：WorkBuddy / Qoder 变体目录全部维护，Codex 的 PATH 探测', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    // WorkBuddy 标准安装：skill 根是配置目录下的 skills（运行时监视该目录）
    const workbuddy = agentClientStatus('workbuddy', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.workbuddy')),
      exists: () => false,
    });
    assert.equal(workbuddy.installed, true);
    assert.deepEqual(workbuddy.skillPaths, [path.join(home, '.workbuddy', 'skills', 'engram', 'SKILL.md')]);

    // 只装了海外版目录：skill 根跟随该变体
    const workbuddyAi = agentClientStatus('workbuddy', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.workbuddy-ai')),
      exists: () => false,
    });
    assert.equal(workbuddyAi.installed, true);
    assert.deepEqual(workbuddyAi.skillPaths, [path.join(home, '.workbuddy-ai', 'skills', 'engram', 'SKILL.md')]);

    // 两个变体都装了：两套 skill 根都要维护，不能只写其中一套
    const workbuddyBoth = agentClientStatus('workbuddy', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.workbuddy'), path.join(home, '.workbuddy-ai')),
      exists: () => false,
    });
    assert.equal(workbuddyBoth.skillPaths.length, 2);

    // Qoder 只装了国内版目录：skill 根落在该变体下
    const qoder = agentClientStatus('qoder', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.qoder-cn')),
      exists: () => false,
    });
    assert.equal(qoder.installed, true);
    assert.deepEqual(qoder.skillPaths, [path.join(home, '.qoder-cn', 'skills', 'engram', 'SKILL.md')]);

    // 两个 Qoder 变体都装了（本机常见）：国际版与国内版都要写入
    const qoderBoth = agentClientStatus('qoder', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.qoder'), path.join(home, '.qoder-cn')),
      exists: () => false,
    });
    assert.deepEqual(qoderBoth.skillPaths, [
      path.join(home, '.qoder', 'skills', 'engram', 'SKILL.md'),
      path.join(home, '.qoder-cn', 'skills', 'engram', 'SKILL.md'),
    ]);

    // Codex 不在 PATH 的常见位置，但 codex 命令在 PATH 里（Windows 下还带 PATHEXT，判据放宽）
    // 只按文件名判断：Windows 下 path.join 会把 /usr/local/bin 拼成反斜杠路径，目录比对不可移植
    const isCodexBinary = (file: string): boolean => /^codex(\.(exe|cmd|bat|com))?$/i.test(path.basename(file));
    const codex = agentClientStatus('codex', home, {
      runtime,
      env: { PATH: '/usr/local/bin' },
      isDir: () => false,
      exists: isCodexBinary,
    });
    assert.equal(codex.installed, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('客户端清单：7 个客户端、id 固定；未知 id 报错', () => {
  const home = tempHome();
  try {
    const clients = agentClients(home, {
      runtime: runtimeFor(home),
      env: {},
      isDir: () => false,
      exists: () => false,
    });
    assert.deepEqual(clients.map((client) => client.id), [
      'claude',
      'codex',
      'dsh',
      'zcode',
      'kimi-code',
      'workbuddy',
      'qoder',
    ]);
    assert.equal(isAgentClientId('claude'), true);
    assert.equal(isAgentClientId('kimiwork'), false);
    assert.throws(() => agentClientStatus('nope' as AgentClientId, home), /未知客户端/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('一键接入：写本机 shim + 两份 skill，正文用完整命令；重复注册幂等', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const options = {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.claude')),
      exists: () => false,
    };
    const result = registerAgentAccess('claude', home, options);
    assert.equal(result.skillPaths.length, 2);
    for (const file of result.skillPaths) assert.equal(fs.existsSync(file), true, file);
    assert.ok(fs.readFileSync(result.skillPaths[0], 'utf8').includes(runtime.command));
    assert.equal(fs.existsSync(runtime.shimPath), true, '注册时同时写本机 engram 包装脚本');
    assert.equal(result.client.skillsInstalled, true);
    assert.equal(result.client.installed, true);

    const again = registerAgentAccess('claude', home, options);
    assert.deepEqual(again.skillPaths, result.skillPaths);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('一键接入：Qoder 两个变体都装了两份 skill，移除时两套都清', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const qoderRoot = path.join(home, '.qoder');
    const qoderCnRoot = path.join(home, '.qoder-cn');
    const options = {
      runtime,
      env: {},
      isDir: onlyDirs(qoderRoot, qoderCnRoot),
      exists: () => false,
    };
    const result = registerAgentAccess('qoder', home, options);
    assert.equal(result.skillPaths.length, 4);
    for (const root of [qoderRoot, qoderCnRoot]) {
      assert.equal(fs.existsSync(path.join(root, 'skills', 'engram', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(root, 'skills', 'engram-customer-research', 'SKILL.md')), true);
    }
    assert.equal(result.client.skillsInstalled, true);

    const removed = unregisterAgentAccess('qoder', home, options);
    assert.equal(removed.removed.length, 4);
    assert.equal(removed.client.skillsInstalled, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('一键接入：Codex 顺带清掉旧 MCP 表，其他配置与注释保留', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(configPath, [
      'model = "gpt-5"',
      '',
      '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换下面这张表）。',
      '# Engram 未启动时 Codex 照常启动，只是这组 mcp__engram__* 工具缺席。',
      '[mcp_servers.engram]',
      'url = "http://127.0.0.1:18180/mcp"',
      'http_headers = { "Authorization" = "Bearer x" }',
      '',
      '[mcp_servers.other]',
      'url = "http://127.0.0.1:9999/mcp"',
    ].join('\n') + '\n', 'utf8');

    const result = registerAgentAccess('codex', home, {
      runtime,
      env: { CODEX_HOME: codexHome },
      isDir: onlyDirs(codexHome),
      exists: () => false,
    });
    assert.ok(result.cleaned.includes(configPath));
    const text = fs.readFileSync(configPath, 'utf8');
    assert.equal(text.includes('[mcp_servers.engram]'), false);
    assert.equal(text.includes('mcp__engram__'), false);
    assert.ok(text.includes('model = "gpt-5"'));
    assert.ok(text.includes('[mcp_servers.other]'));
    assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'engram', 'SKILL.md')), true);

    // 幂等：清理过的配置再接入不再产生清理项
    const again = registerAgentAccess('codex', home, {
      runtime,
      env: { CODEX_HOME: codexHome },
      isDir: onlyDirs(codexHome),
      exists: () => false,
    });
    assert.equal(again.cleaned.includes(configPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('一键接入：WorkBuddy 清掉旧 ~/.codebuddy/skills 里的管理 skill，用户自己的不动', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const legacyRoot = path.join(home, '.codebuddy', 'skills');
    fs.mkdirSync(path.join(legacyRoot, 'engram'), { recursive: true });
    fs.mkdirSync(path.join(legacyRoot, 'user-skill'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'engram', 'SKILL.md'), '<!-- engram-managed -->\n旧版 skill\n');
    fs.writeFileSync(path.join(legacyRoot, 'user-skill', 'SKILL.md'), '用户自己的 skill\n');

    const result = registerAgentAccess('workbuddy', home, {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.workbuddy')),
      exists: () => false,
    });
    assert.equal(fs.existsSync(path.join(legacyRoot, 'engram', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(legacyRoot, 'user-skill', 'SKILL.md')), true);
    assert.equal(result.client.skillsInstalled, true);
    assert.equal(fs.existsSync(path.join(home, '.workbuddy', 'skills', 'engram', 'SKILL.md')), true);
    assert.ok(result.cleaned.some((file) => file.includes('.codebuddy')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('一键接入：未检测到客户端 / CLI 未构建时报错，且不写任何文件', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    assert.throws(
      () => registerAgentAccess('claude', home, { runtime, env: {}, isDir: () => false, exists: () => false }),
      /未检测到本机 Claude Code 客户端/,
    );
    assert.throws(
      () => registerAgentAccess('claude', home, {
        runtime: { ...runtime, available: false, error: '缺少 cli.js' },
        env: {},
        isDir: onlyDirs(path.join(home, '.claude')),
        exists: () => false,
      }),
      /engram CLI 尚未就绪/,
    );
    assert.equal(fs.existsSync(runtime.shimPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('一键接入：同名非 Engram 管理的 skill 拒绝覆盖，且不写 shim', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const root = path.join(home, '.claude', 'skills');
    const userFile = path.join(root, 'engram', 'SKILL.md');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, '用户自己的 skill');
    assert.throws(
      () => registerAgentAccess('claude', home, {
        runtime,
        env: {},
        isDir: onlyDirs(path.join(home, '.claude')),
        exists: () => false,
      }),
      /拒绝覆盖/,
    );
    assert.equal(fs.readFileSync(userFile, 'utf8'), '用户自己的 skill');
    assert.equal(fs.existsSync(runtime.shimPath), false, '预检失败时不应留下半套接入文件');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('移除接入：只删两份管理标记的 skill', () => {
  const home = tempHome();
  try {
    const runtime = runtimeFor(home);
    const options = {
      runtime,
      env: {},
      isDir: onlyDirs(path.join(home, '.claude')),
      exists: () => false,
    };
    registerAgentAccess('claude', home, options);
    const removed = unregisterAgentAccess('claude', home, options);
    assert.equal(removed.removed.length, 2);
    for (const file of removed.removed) assert.equal(fs.existsSync(file), false);
    assert.equal(removed.client.skillsInstalled, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
