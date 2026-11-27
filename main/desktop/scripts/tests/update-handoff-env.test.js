// 交接启动器环境变量隔离与 pnpm 残缺提示护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/update-handoff-env.test.js
//
// 背景（2026-11-27 客户机实测）：
//   1) 主进程用 fork()（默认带 ELECTRON_RUN_AS_NODE=1）启动交接中转进程，若未清理该变量，
//      交接脚本或安装卡拉起的新版 Engram.exe 会被当成纯 Node 跑 desktop/main.js，
//      在 `app.on('open-url', ...)` 处报 `Cannot read properties of undefined (reading 'on')` 闪退；
//   2) 旧版安装器缺少 pnpm/worker.js 时，sync-deps.js 文案误导用户删除目录后直接重跑更新。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const handoffLauncher = require('../update-handoff-launcher');
const cardLauncher = require('../../lib/install-card-launcher');
const installCard = require('../../lib/install-card');

const mainRoot = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

// 1. stripElectronRunAsNode：大小写不敏感移除，不篡改入参，保留其他环境变量
for (const [name, fn] of [
  ['update-handoff-launcher', handoffLauncher.stripElectronRunAsNode],
  ['install-card-launcher', cardLauncher.stripElectronRunAsNode],
]) {
  assert.equal(typeof fn, 'function', `${name} 应导出 stripElectronRunAsNode`);
  const input = {
    PATH: 'C:\\Windows\\System32',
    ELECTRON_RUN_AS_NODE: '1',
    Electron_Run_As_Node: '1',
    ENGRAM_KEEP: 'yes',
  };
  const cleaned = fn(input);
  assert.equal(input.ELECTRON_RUN_AS_NODE, '1', `${name} 不应原地修改原 env 对象`);
  assert.equal('ELECTRON_RUN_AS_NODE' in cleaned, false, `${name} 必须删除 ELECTRON_RUN_AS_NODE`);
  assert.equal('Electron_Run_As_Node' in cleaned, false, `${name} 必须大小写不敏感删除变体`);
  assert.equal(cleaned.PATH, 'C:\\Windows\\System32');
  assert.equal(cleaned.ENGRAM_KEEP, 'yes');
}

// 2. 源码接线：update-handoff-launcher / install-card-launcher / uninstall-launcher
const handoffSource = read('desktop/scripts/update-handoff-launcher.js');
assert.match(handoffSource, /set ELECTRON_RUN_AS_NODE=/, '临时 .cmd 必须显式清空 ELECTRON_RUN_AS_NODE');
assert.match(
  handoffSource,
  /env:\s*stripElectronRunAsNode\(process\.env\)/,
  'update-handoff-launcher spawn cmd.exe 时必须传入清理后的 env',
);

const cardLauncherSource = read('desktop/lib/install-card-launcher.js');
assert.match(
  cardLauncherSource,
  /env:\s*stripElectronRunAsNode\(process\.env\)/,
  'install-card-launcher spawn 时必须传入清理后的 env',
);

const uninstallLauncherSource = read('desktop/scripts/uninstall-launcher.js');
assert.match(
  uninstallLauncherSource,
  /toUpperCase\(\)\s*===\s*'ELECTRON_RUN_AS_NODE'/,
  'uninstall-launcher spawn 时必须按大小写不敏感删除 ELECTRON_RUN_AS_NODE',
);

// 3. PowerShell 重启入口：update-from-source.ps1 与 install-card.js
const ps1 = read('scripts/update-from-source.ps1');
const startEngramBlock = ps1.slice(ps1.indexOf('function Start-Engram'), ps1.indexOf('# 1) 拉取最新代码'));
const removeIdx = startEngramBlock.indexOf('Remove-Item Env:ELECTRON_RUN_AS_NODE');
const startIdx = startEngramBlock.indexOf('Start-Process -FilePath $exe');
assert.ok(removeIdx > 0, 'Start-Engram 必须先清理 Env:ELECTRON_RUN_AS_NODE');
assert.ok(startIdx > removeIdx, '清理 Env:ELECTRON_RUN_AS_NODE 必须在 Start-Process 之前');

const cardScript = installCard.buildScript({ installerPath: 'C:\\x\\a.exe' });
assert.ok(
  cardScript.includes('Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue'),
  'install-card 脚本必须清理 Env:ELECTRON_RUN_AS_NODE 防止重拉 Engram.exe 退化成纯 Node',
);

// 4. sync-deps.js 缺少 pnpm/worker.js 的错误提示准确引导用新版安装器覆盖安装
const syncDepsSource = read('desktop/scripts/sync-deps.js');
assert.ok(
  syncDepsSource.includes('请下载并运行新版安装器覆盖安装'),
  'sync-deps.js 缺少 worker.js 时应明确引导用新版安装器覆盖安装',
);
assert.equal(
  syncDepsSource.includes('重新运行更新（安装器会落一份完整的 pnpm 发行包）'),
  false,
  '不得再误导用户删目录后直接重新运行更新',
);

// 5. 真实子进程验证：父环境带 ELECTRON_RUN_AS_NODE=1 时，经 stripElectronRunAsNode 后子进程看不到该变量
const childRes = spawnSync(
  process.execPath,
  ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))'],
  {
    env: handoffLauncher.stripElectronRunAsNode({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }),
    encoding: 'utf8',
    timeout: 15_000,
  },
);
assert.equal(childRes.status, 0, '真实子进程应正常退出：' + childRes.stderr);
assert.equal(childRes.stdout, 'undefined', '子进程不应继承到 ELECTRON_RUN_AS_NODE');

console.log('  ✓ 交接启动器环境变量隔离（handoff/card/uninstall/ps1）与 sync-deps 提示全部通过');
