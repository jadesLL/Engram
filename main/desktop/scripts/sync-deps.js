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
const { repairElectronRuntime } = require('./lib/electron-runtime');

const appRoot = (() => {
  const i = process.argv.indexOf('--app-root');
  const dir = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.resolve(__dirname, '..', '..');
  return path.resolve(dir);
})();

const phase = (process.argv[2] || '').toLowerCase();

function say(msg) {
  process.stdout.write(`[deps] ${msg}\n`);
}

/** 子进程执行：输出直接透传（应用内更新据此实时回显），返回退出码；options.capture 传数组时同时收集输出 */
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { capture, ...spawnOptions } = options;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    const pipe = (stream, sink) => {
      stream.on('data', (d) => {
        sink.write(d);
        if (capture) capture.push(String(d));
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
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

/**
 * Electron 包目录是否残缺。除了「剪枝删一半」（缺 package.json/install.js），还要挡「空文件」：
 * 客户机实测（2026-09-17）install.js 只剩 0 字节，`node install.js` 于是静默退出 0、dist 永远补
 * 不出来，而只按「文件存在」判定会一直走下载路径，每次都以「下载失败」收场。残缺只能重装依赖
 * （pnpm install --force 会 refetch 被改坏的 store 文件）。
 */
function electronPackageBroken(electronDir) {
  const installJs = path.join(electronDir, 'install.js');
  const pkgJson = path.join(electronDir, 'package.json');
  if (!fs.existsSync(installJs) || !fs.existsSync(pkgJson)) return true;
  try {
    if (fs.statSync(installJs).size < 200) return true; // electron 的 install.js 约 3KB，空/截断即残缺
    return !JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
  } catch {
    return true;
  }
}

/**
 * 工作区阶段的动作判定（拆成纯判定便于单测，见 tests/sync-deps.workspace.test.js）：
 *   skip      依赖与 Electron 运行时都齐 → 什么都不做
 *   install   依赖需要（重）装 → pnpm install --frozen-lockfile
 *   reinstall Electron 包目录残缺（缺/空 install.js，补不回来）→ --force 重落整套依赖
 *   runtime   依赖齐但运行时缺（postinstall 失败的残局）→ 只补运行时，不整树重装
 */
function workspaceAction(root) {
  const state = deps.workspaceInstallState(root);
  const electronDir = path.join(root, 'desktop', 'node_modules', 'electron');
  // 包目录整个不在（全新机器）不算残缺，交给正常安装
  const packageBroken = fs.existsSync(electronDir) && electronPackageBroken(electronDir);
  if (packageBroken) return { action: 'reinstall', reason: state.reason };
  if (state.needed) return { action: 'install', reason: state.reason };
  if (!deps.electronRuntimeOk(root)) return { action: 'runtime', reason: state.reason };
  return { action: 'skip', reason: state.reason };
}

/**
 * 工作区阶段：构建前，依赖变化才 pnpm install --frozen-lockfile，装完显式确认 Electron 运行时。
 *
 * 「包在、dist 不在」是最常见的残局：上一次安装在 electron 的 postinstall 阶段失败（下载被掐断等），
 * pnpm 仍把整套依赖记成已装，之后再跑 pnpm install 一律空转、不会再跑 postinstall —— 2026-09-17
 * 客户机正是卡在这里：deps 步显示成功但 dist 始终缺，build 步整树 `--force` 重装又失败。
 * 故运行时缺失一律直接跑 electron 自带的 install.js 补齐（走 npmmirror 镜像），不整树重装。
 */
async function syncWorkspace() {
  const { action, reason } = workspaceAction(appRoot);
  if (action === 'skip') {
    say(`工作区依赖无需安装（${reason}）`);
    return;
  }
  if (action === 'reinstall') say('Electron 包目录残缺（缺 install.js），强制重装工作区依赖');
  else if (action === 'install') say(`工作区依赖需要安装（${reason}）`);
  else say(`工作区依赖无需安装（${reason}），仅补齐 Electron 运行时`);

  if (action === 'install' || action === 'reinstall') {
    const args = ['install', '--frozen-lockfile'];
    if (action === 'reinstall') args.push('--force');
    const code = await runPnpm(args, appRoot);
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
  await ensureElectronRuntime();
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

/**
 * 会让 electron 的 install.js 静默走偏的环境开关。客户机实测（2026-09-17）：设了这类键时
 * install.js 一声不响地退出 0、dist 依旧空，日志里连一行报错都没有，只能看到「下载失败」。
 * 安装必须有真实运行时，故这里直接忽略它们并在日志里说明。
 */
const ELECTRON_ENV_TRAPS = ['ELECTRON_SKIP_BINARY_DOWNLOAD', 'ELECTRON_OVERRIDE_DIST_PATH'];

/** 下载失败时给出可判断的细节：退出码、install.js 大小与最后几行输出、dist 里到底有什么 */
function describeInstallFailure(electronDir, code, captured) {
  const lines = captured
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6);
  let installJs = 'install.js 缺失';
  try {
    installJs = `install.js ${fs.statSync(path.join(electronDir, 'install.js')).size} 字节`;
  } catch {
    /* 缺就保持上面的文案 */
  }
  let dist = '';
  try {
    const entries = fs.readdirSync(path.join(electronDir, 'dist'));
    dist = `dist 有 ${entries.length} 项${entries.length ? `（${entries.slice(0, 8).join(', ')}）` : '（空目录）'}`;
  } catch {
    dist = 'dist 目录不存在';
  }
  const out = lines.length ? lines.join(' / ') : 'install.js 没有任何输出（多为环境开关或空脚本让它静默跳过）';
  return `install.js 退出码 ${code}，${installJs}，${dist}，输出：${out}`;
}

/** Electron 运行时缺失/残缺时补齐（约 110MB，仅首次；默认走 npmmirror 镜像） */
async function ensureElectronRuntime() {
  const electronDir = path.join(appRoot, 'desktop', 'node_modules', 'electron');
  const exe = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const hasPackage = fs.existsSync(path.join(electronDir, 'package.json'));
  if (fs.existsSync(exe) && hasPackage) return;
  if (electronPackageBroken(electronDir)) {
    // 缺/空 install.js、package.json 读不出：补不回来，只能重装依赖
    throw new Error(`Electron 包缺失或不完整（${electronDir}）：请先装工作区依赖，或删除该目录后重跑依赖安装`);
  }
  say('Electron 运行时缺失，开始下载（约 110MB，默认 npmmirror 镜像）');
  const env = { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' };
  for (const key of ELECTRON_ENV_TRAPS) {
    if (env[key]) {
      say(`（忽略环境变量 ${key}=${env[key]}：安装必须有真实运行时）`);
      delete env[key];
    }
  }
  // 平台/架构按当前进程来：被别处设成别的值时 install.js 会下错平台的包，解压完没有 electron.exe
  if (env.npm_config_platform && env.npm_config_platform !== process.platform) {
    say(`（忽略环境变量 npm_config_platform=${env.npm_config_platform}：按当前平台 ${process.platform} 下载）`);
  }
  if (env.npm_config_arch && env.npm_config_arch !== process.arch) {
    say(`（忽略环境变量 npm_config_arch=${env.npm_config_arch}：按当前架构 ${process.arch} 下载）`);
  }
  env.npm_config_platform = process.platform;
  env.npm_config_arch = process.arch;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const captured = [];
  const code = await run(process.execPath, ['install.js'], { cwd: electronDir, env, capture: captured });
  if (code !== 0 || !fs.existsSync(exe)) {
    // install.js 这条链会吞掉失败细节（客户机实测：退出码 0、无输出、dist 只剩 locales/），
    // 故不再直接失败，改用安装器自带的下载+解压+逐项校验兜底。
    say(`install.js 未能补出运行时：${describeInstallFailure(electronDir, code, captured)}`);
    const version = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version;
    await repairElectronRuntime(electronDir, version, { say });
  }
  if (!fs.existsSync(exe)) {
    throw new Error(`Electron 运行时仍不可用（缺 ${exe}）：请把 ${electronDir} 加入杀软白名单后重试`);
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

/**
 * 清扫 Electron 运行时残骸：pnpm 剪枝在 Windows 上删不掉正在使用的 electron.exe 与被映射的 dll，
 * 会把旧版本的 store 目录删成「只剩 dist、package.json 已没了」的半成品。残骸不是可加载的应用，
 * 一旦有启动方式解析到它（如从 electron 包位置推算应用目录）就必弹「Unable to find Electron app」，
 * 故每次依赖同步后顺手清掉；当前链接指向的那份哪怕残缺也留着，交给工作区阶段的强制重装修复。
 */
function sweepBrokenElectronStore(root = appRoot) {
  const store = path.join(root, 'node_modules', '.pnpm');
  let linkedReal = '';
  try {
    linkedReal = fs.realpathSync(path.join(root, 'desktop', 'node_modules', 'electron')).toLowerCase();
  } catch {
    /* 链接缺失或悬空：没有要保护的目标 */
  }
  let names = [];
  try {
    names = fs.readdirSync(store).filter((n) => /^electron@/.test(n));
  } catch {
    return; // 无 .pnpm 存储
  }
  for (const name of names) {
    const dir = path.join(store, name);
    const pkgDir = path.join(dir, 'node_modules', 'electron');
    if (fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
    if (linkedReal && pkgDir.toLowerCase() === linkedReal) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      say(`清理 Electron 运行时残骸：node_modules/.pnpm/${name}（包目录缺 package.json）`);
    } catch (e) {
      say(`（残骸 .pnpm/${name} 暂时删不掉，忽略：${e && e.message ? e.message : e}）`);
    }
  }
}

async function main() {
  if (phase !== 'workspace' && phase !== 'server') {
    process.stderr.write('用法：node desktop/scripts/sync-deps.js <workspace|server> [--app-root <main 目录>]\n');
    process.exit(2);
  }
  say(`应用目录 ${appRoot}`);
  if (phase === 'workspace') await syncWorkspace();
  else await syncServer();
  sweepBrokenElectronStore();
}

module.exports = { sweepBrokenElectronStore, workspaceAction, describeInstallFailure };

// 被测试脚本 require 时只导出清扫函数，不跑 CLI 主流程
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[deps] 失败：${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
