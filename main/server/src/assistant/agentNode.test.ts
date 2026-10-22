import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  AGENT_NODE_MISSING_ERROR,
  agentNodeCandidates,
  ensureAgentNodeRuntime,
  isElectronRuntime,
  nativePathForPlainNode,
  nodeMajor,
  parseNodeVersion,
  pickUsableAgentNode,
  resetAgentNodeRuntimeCache,
} from './agentNode.js';

/** 假 versions：带 electron 即模拟桌面端 ELECTRON_RUN_AS_NODE 纯 Node 模式 */
function versions(extra: Record<string, string> = {}): NodeJS.ProcessVersions {
  return { node: '22.19.0', ...extra } as unknown as NodeJS.ProcessVersions;
}

test('parseNodeVersion / nodeMajor：容忍 v 前缀与空白，非法版本按 0 处理', () => {
  assert.equal(parseNodeVersion('v22.20.0\n'), '22.20.0');
  assert.equal(parseNodeVersion('22.19.0'), '22.19.0');
  assert.equal(parseNodeVersion('  v20.1.2  '), '20.1.2');
  assert.equal(parseNodeVersion('not-a-version'), null);
  assert.equal(parseNodeVersion(undefined), null);
  assert.equal(nodeMajor('22.20.0'), 22);
  assert.equal(nodeMajor(''), 0);
});

test('isElectronRuntime：只看 process.versions.electron 是否为非空字符串', () => {
  assert.equal(isElectronRuntime(versions()), false);
  assert.equal(isElectronRuntime(versions({ electron: '36.9.5' })), true);
  assert.equal(isElectronRuntime(versions({ electron: '' })), false);
});

test('agentNodeCandidates：ENGRAM_NODE_BIN → 安装包 resources → 便携 → PATH，并排除进程自身', () => {
  // 用当前平台的文件名规则构造 PATH，保证 Windows 宿主机与 Linux 容器里断言一致
  const isWin = process.platform === 'win32';
  const nodeName = isWin ? 'node.exe' : 'node';
  const env = {
    ENGRAM_NODE_BIN: '/opt/engram/bin/' + nodeName,
    LOCALAPPDATA: '/home/u/AppData/Local',
    PATH: ['/usr/local/bin', '/opt/engram/bin', ''].join(path.delimiter),
  } as NodeJS.ProcessEnv;
  const resourcesPath = '/app/resources';
  const execPath = '/usr/local/bin/electron';
  // 实现内部会 path.resolve 归一化后再 exists，测试里的路径也必须用同一套归一化
  const norm = (p: string) => path.resolve(p);
  const present = new Set(
    [
      '/opt/engram/bin/' + nodeName,
      '/app/resources/node/' + nodeName,
      '/home/u/AppData/Local/engram/node/node.exe',
      '/usr/local/bin/' + nodeName,
      '/opt/engram/bin/' + nodeName, // 与 ENGRAM_NODE_BIN 重复：应去重
      execPath,
    ].map(norm),
  );
  const candidates = agentNodeCandidates({
    env,
    resourcesPath,
    execPath,
    platform: isWin ? 'win32' : 'linux',
    exists: (p) => present.has(p),
  });
  assert.deepEqual(
    candidates.map((c) => [c.source, c.path]),
    [
      ['env', norm('/opt/engram/bin/' + nodeName)],
      ['bundled', norm('/app/resources/node/' + nodeName)],
      ['portable', norm('/home/u/AppData/Local/engram/node/node.exe')],
      ['path', norm('/usr/local/bin/' + nodeName)],
    ],
  );
});

test('agentNodeCandidates：进程自身（Electron）即使出现在 PATH 里也不能当 Node', () => {
  // 桌面端 process.execPath 是 Engram.exe，安装在 PATH 目录里也不会是 node.exe，
  // 但显式 ENGRAM_NODE_BIN 指回自己时必须被排除（防止把 Electron 再当 Node 拉起）。
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'C:\\App\\Engram.exe' : '/app/Engram';
  const candidates = agentNodeCandidates({
    env: { ENGRAM_NODE_BIN: exe, PATH: '' } as NodeJS.ProcessEnv,
    execPath: exe,
    platform: isWin ? 'win32' : 'linux',
    exists: () => true,
  });
  assert.deepEqual(candidates, []);
});

test('nativePathForPlainNode：app.asar → app.asar.unpacked（仅当真实文件存在）', () => {
  const asarPath = 'C:/Program Files/Engram/resources/app.asar/server/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const unpacked = 'C:/Program Files/Engram/resources/app.asar.unpacked/server/node_modules/@deepseek-ai/dsh/lib/bin.js';
  assert.equal(nativePathForPlainNode(asarPath, (p) => p === unpacked), unpacked);
  // 解包目标不存在（打包配置漏了 asarUnpack）时原样返回，交给启动失败报错，不能假装可用
  assert.equal(nativePathForPlainNode(asarPath, () => false), asarPath);
  // 源码模式 / Docker：没有 asar 段，原样返回
  assert.equal(nativePathForPlainNode('/repo/main/server/node_modules/x/lib/bin.js'), '/repo/main/server/node_modules/x/lib/bin.js');
});

test('pickUsableAgentNode：跳过探测失败与版本过低，取第一个 >= 20', () => {
  const nodes = [
    { path: '/a/node', source: 'path' as const },
    { path: '/b/node', source: 'portable' as const },
    { path: '/c/node', source: 'bundled' as const },
  ];
  const versions: Record<string, string | null> = { '/a/node': null, '/b/node': '18.19.0', '/c/node': '22.20.0' };
  assert.deepEqual(pickUsableAgentNode(nodes, (f) => versions[f] ?? null), {
    path: '/c/node',
    source: 'bundled',
    version: '22.20.0',
  });
  assert.equal(pickUsableAgentNode(nodes, () => '18.0.0'), null);
});

test('ensureAgentNodeRuntime：真实 Node 进程直接用自己的 execPath（Docker / 源码直跑）', () => {
  resetAgentNodeRuntimeCache();
  const status = ensureAgentNodeRuntime({
    processVersions: versions(),
    execPath: '/usr/bin/node',
    applyExecPath: () => {
      throw new Error('非 Electron 模式不该覆盖 execPath');
    },
  });
  assert.equal(status.ok, true);
  assert.equal(status.source, 'process');
  assert.equal(status.path, '/usr/bin/node');
  assert.equal(status.version, '22.19.0');
  resetAgentNodeRuntimeCache();
});

test('ensureAgentNodeRuntime：Electron 模式覆盖 execPath 指向真实 Node（聊天 SDK 走 process.execPath）', () => {
  resetAgentNodeRuntimeCache();
  const applied: string[] = [];
  let probes = 0;
  const nodeBin = path.resolve('C:/engram/node/node.exe');
  const status = ensureAgentNodeRuntime({
    processVersions: versions({ electron: '36.9.5' }),
    env: { ENGRAM_NODE_BIN: nodeBin } as NodeJS.ProcessEnv,
    exists: (p) => p === nodeBin,
    platform: 'win32',
    execPath: path.resolve('C:/engram/Engram.exe'),
    probe: () => {
      probes += 1;
      return '22.20.0';
    },
    applyExecPath: (file) => applied.push(file),
  });
  assert.equal(status.ok, true);
  assert.equal(status.source, 'env');
  assert.equal(status.version, '22.20.0');
  assert.deepEqual(applied, [nodeBin]);
  // 缓存：第二次不再探测
  ensureAgentNodeRuntime({ processVersions: versions({ electron: '36.9.5' }), probe: () => null });
  assert.equal(probes, 1);
  resetAgentNodeRuntimeCache();
});

test('ensureAgentNodeRuntime：Electron 模式找不到 Node 时给出可操作的原因（不覆盖 execPath）', () => {
  resetAgentNodeRuntimeCache();
  let applied = 0;
  const status = ensureAgentNodeRuntime({
    processVersions: versions({ electron: '36.9.5' }),
    env: { PATH: '' } as NodeJS.ProcessEnv,
    exists: () => false,
    platform: 'win32',
    execPath: 'C:/engram/Engram.exe',
    probe: () => null,
    applyExecPath: () => {
      applied += 1;
    },
  });
  assert.equal(status.ok, false);
  assert.equal(status.source, 'none');
  assert.equal(applied, 0);
  assert.ok(status.error.includes(AGENT_NODE_MISSING_ERROR));
  assert.ok(status.error.includes('没有找到任何候选 Node'));
  resetAgentNodeRuntimeCache();
});
