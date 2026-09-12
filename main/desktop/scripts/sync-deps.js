#!/usr/bin/env node
// 依赖同步 CLI：应用内更新（主进程 fork 本脚本）与 scripts/update-from-source.ps1 共用同一条实现。
//
// 用法（在 main/ 下）：
//   node desktop/scripts/sync-deps.js workspace            # 构建前：工作区依赖（依赖变化才 pnpm install）
//   node desktop/scripts/sync-deps.js server               # prepare-desktop 之后：desktop/server 运行时依赖
//   node desktop/scripts/sync-deps.js workspace --app-root <main 目录>
//
// 退出码：0 成功（含「依赖无变化，跳过安装」）；非 0 失败，stderr 说明原因。
// 输出全部走 stdout/stderr 逐行打印，应用内更新会把这些行实时回显到进度小窗。
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const deps = require('./lib/deps');

const appRoot = (() => {
  const i = process.argv.indexOf('--app-root');
  const dir = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.resolve(__dirname, '..', '..');
  return path.resolve(dir);
})();

const phase = (process.argv[2] || '').toLowerCase();

function say(msg) {
  process.stdout.write(`[deps] ${msg}\n`);
}

/** 子进程执行：输出直接透传（应用内更新据此实时回显），返回退出码 */
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('exit', (code) => resolve(code === null ? 1 : code));
  });
}

/**
 * pnpm 调用方式：优先用仓库内共享副本的 JS 入口，用当前 Node/Electron 的 node 模式直接跑
 * （不经过任何 shell）；找不到才回退 PATH 上的 pnpm（Windows 上是 .cmd，需要 shell）。
 */
function pnpmInvoker() {
  const entry = deps.resolvePnpmEntry(appRoot);
  if (entry) {
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return { label: entry, cmd: process.execPath, args: (a) => [entry, ...a], options: { env } };
  }
  return {
    label: 'pnpm(PATH)',
    cmd: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: (a) => a,
    options: { shell: true },
  };
}

/**
 * 从 lockfile 推断 registry（见 lib/deps.js）：本仓库 lockfile 记的是 npmmirror 的 tarball
 * URL，而 pnpm 11 的供应链策略会拿它跟当前 registry（默认 npmjs）的元数据比对，不一致就直接
 * 拒绝安装（ERR_PNPM_TARBALL_URL_MISMATCH，实测 PATH 上的 pnpm 11 在本仓库必现）。
 */
async function runPnpm(args, cwd) {
  const invoker = pnpmInvoker();
  const registry = deps.lockfileRegistry(appRoot);
  // registry 进的是 PATH 回退分支的 shell 命令行，lockfile 里的脏值必须拦在 shell 外
  const safeRegistry = registry && /^https?:\/\//.test(registry) ? registry : null;
  const fullArgs = safeRegistry ? [...args, '--registry', safeRegistry] : args;
  say(`运行 ${invoker.label} ${fullArgs.join(' ')}`);
  const code = await run(invoker.cmd, invoker.args(fullArgs), { cwd, ...invoker.options });
  return code;
}

/** 工作区阶段：构建前，依赖变化才 pnpm install --frozen-lockfile */
async function syncWorkspace() {
  const state = deps.workspaceInstallState(appRoot);
  if (!state.needed) {
    say(`工作区依赖无需安装（${state.reason}）`);
    return;
  }
  say(`工作区依赖需要安装（${state.reason}）`);
  const code = await runPnpm(['install', '--frozen-lockfile'], appRoot);
  if (code !== 0) {
    throw new Error('pnpm install --frozen-lockfile 失败：请检查网络与 pnpm-lock.yaml 是否与 package.json 一致');
  }
  const nodeModules = path.join(appRoot, 'node_modules');
  deps.writeRecord(nodeModules, {
    fingerprint: deps.workspaceFingerprint(appRoot).fingerprint,
    phase: 'workspace',
    installedAt: new Date().toISOString(),
  });
  say('工作区依赖已就绪');
}

/** 取 better-sqlite3 的 Electron ABI prebuild（优先 npmmirror 镜像） */
async function ensureNativeBinding(serverNodeModules, electronVer) {
  const bsq3Dir = path.join(serverNodeModules, 'better-sqlite3');
  const binding = path.join(bsq3Dir, 'build', 'Release', 'better_sqlite3.node');
  const prebuild = path.join(serverNodeModules, 'prebuild-install', 'bin.js');
  if (fs.existsSync(prebuild) && electronVer) {
    say(`获取 better-sqlite3 Electron@${electronVer} prebuild`);
    const env = {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVer,
      npm_config_better_sqlite3_binary_host_mirror: 'https://registry.npmmirror.com/-/binary/better-sqlite3',
    };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const code = await run(process.execPath, [prebuild, '--runtime', 'electron', '--target', electronVer], {
      cwd: bsq3Dir,
      env,
    });
    if (code !== 0) say('（prebuild-install 非零退出，检查产物是否就位）');
  } else {
    say('未找到 prebuild-install，尝试复用工作区已有 binding');
  }
  if (fs.existsSync(binding)) return;

  // 兜底：从工作区 node_modules（含 .pnpm 存储）拷一份 binding。ABI 可能与 Electron 不符，
  // 仅在系统 Node 与 Electron 同 ABI 时可用，故只作最后手段。
  const candidates = [path.join(appRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')];
  const store = path.join(appRoot, 'node_modules', '.pnpm');
  try {
    for (const name of fs.readdirSync(store)) {
      if (/^better-sqlite3@/.test(name)) {
        candidates.push(path.join(store, name, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
      }
    }
  } catch {
    /* 无 .pnpm 存储 */
  }
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) throw new Error('未找到 better-sqlite3 native binding（先确认工作区依赖已安装）');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.copyFileSync(src, binding);
  say(`回退拷贝 better-sqlite3 binding ← ${src}（ABI 可能与 Electron 不符）`);
}

/** Electron 运行时缺失时下载（约 110MB，仅首次；默认走 npmmirror 镜像） */
async function ensureElectronRuntime() {
  const electronDir = path.join(appRoot, 'desktop', 'node_modules', 'electron');
  const exe = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(exe)) return;
  if (!fs.existsSync(path.join(electronDir, 'install.js'))) {
    throw new Error(`Electron 运行时缺失且找不到 ${electronDir}/install.js（请先安装工作区依赖）`);
  }
  say('Electron 运行时缺失，开始下载（约 110MB，默认 npmmirror 镜像）');
  const env = { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const code = await run(process.execPath, ['install.js'], { cwd: electronDir, env });
  if (code !== 0 || !fs.existsSync(exe)) {
    throw new Error('Electron 运行时下载失败：可手动解压 electron 压缩包到 desktop/node_modules/electron/dist/');
  }
  say('Electron 运行时已就绪');
}

/** server 阶段：prepare-desktop 之后，装 desktop/server 运行时依赖 + 原生 binding + Electron 运行时 */
async function syncServer() {
  const serverDir = path.join(appRoot, 'desktop', 'server');
  const serverNodeModules = path.join(serverDir, 'node_modules');
  if (!fs.existsSync(path.join(serverDir, 'package.json'))) {
    throw new Error('desktop/server/package.json 不存在：请先运行 node desktop/scripts/prepare-desktop.js');
  }
  let state = deps.serverInstallState(appRoot);
  if (state.needsInstall) {
    say(`desktop/server 运行时依赖需要安装（${state.installReason}）`);
    // 与手工打包一致：nodeLinker 已在 desktop/server/pnpm-workspace.yaml 设 hoisted；
    // pnpm 对被忽略的构建脚本可能非零退出，容忍后由下方 binding 步骤兜底
    const code = await runPnpm(
      ['-C', path.join('desktop', 'server'), 'install', '--prod', '--node-linker=hoisted', '--ignore-workspace', '--no-frozen-lockfile'],
      appRoot,
    );
    if (code !== 0) say('（pnpm 非零退出：ignored builds 可容忍，继续）');
  } else {
    say(`desktop/server 运行时依赖${state.installReason || '无变化'}，跳过安装`);
  }

  state = deps.serverInstallState(appRoot);
  if (state.needsNative) {
    say(`better-sqlite3 binding 需要处理（${state.nativeReason}）`);
    await ensureNativeBinding(serverNodeModules, state.electronVersion);
  } else {
    say('better-sqlite3 binding 已就位');
  }

  await ensureElectronRuntime();

  deps.writeRecord(serverNodeModules, {
    fingerprint: deps.serverFingerprint(appRoot).fingerprint,
    phase: 'server',
    electronVersion: state.electronVersion,
    betterSqlite3Version: state.betterSqlite3Version,
    installedAt: new Date().toISOString(),
  });
  say('desktop/server 运行时依赖已就绪');
}

async function main() {
  if (phase !== 'workspace' && phase !== 'server') {
    process.stderr.write('用法：node desktop/scripts/sync-deps.js <workspace|server> [--app-root <main 目录>]\n');
    process.exit(2);
  }
  say(`应用目录 ${appRoot}`);
  if (phase === 'workspace') await syncWorkspace();
  else await syncServer();
}

main().catch((e) => {
  process.stderr.write(`[deps] 失败：${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
