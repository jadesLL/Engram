#!/usr/bin/env node
// 打包产物原生模块 ABI 校验：断言 asar 解包出来的 better_sqlite3.node 与打包进去的 Electron ABI 一致。
//
// 用法（在仓库 main/ 下，或 CI 容器内的 /work 下）：
//   node desktop/scripts/verify-packaged-abi.js --app-dir desktop/dist/win-unpacked
//   node desktop/scripts/verify-packaged-abi.js --binding <.../better_sqlite3.node> --electron-version 36.9.5
//   node desktop/scripts/verify-packaged-abi.js --app-dir desktop/dist/win-unpacked --quiet
//
// 期望的 Electron 版本按优先级取值：--electron-version > electron-builder 的
// dist/builder-effective-config.yaml（真正打包进去的那个版本）> desktop/node_modules/electron/package.json。
//
// 退出码：0 一致；非 0 = 不一致/缺文件/读不出 ABI（**打包流程必须因此失败**）。
// 背景见 lib/electron-abi.js 顶部：v1.3.0 就是因为这里没人校验，把 ABI 133 的 binding 装进了
// 需要 ABI 135 的 Electron 36，所有装了 1.3.0 的机器都被「本地服务启动失败」挡住。
const fs = require('node:fs');
const path = require('node:path');
const abiLib = require('./lib/electron-abi');

const desktopDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { appDir: '', binding: '', electronVersion: '', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--app-dir') out.appDir = argv[++i] || '';
    else if (a === '--binding') out.binding = argv[++i] || '';
    else if (a === '--electron-version') out.electronVersion = argv[++i] || '';
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/** electron-builder 写下的实际打包配置：里面的 electronVersion 才是真正打进 exe 的那个版本 */
function electronVersionFromBuilderConfig(appDir) {
  const distDir = path.dirname(path.resolve(appDir));
  for (const name of ['builder-effective-config.yaml', 'builder-debug.yml']) {
    const file = path.join(distDir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = text.match(/^\s*electronVersion:\s*['"]?([0-9][0-9.]*)['"]?\s*$/m);
    if (m) return { version: m[1], source: file };
  }
  return null;
}

function electronVersionFromNodeModules() {
  const pkg = path.join(desktopDir, 'node_modules', 'electron', 'package.json');
  try {
    const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
    if (version) return { version, source: pkg };
  } catch {
    /* 没装 Electron（例如 CI 里的纯校验场景）时由调用方显式给 --electron-version */
  }
  return null;
}

function resolveElectronVersion(args) {
  if (args.electronVersion) return { version: args.electronVersion, source: '--electron-version' };
  if (args.appDir) {
    const fromBuilder = electronVersionFromBuilderConfig(args.appDir);
    if (fromBuilder) return fromBuilder;
  }
  const fromNodeModules = electronVersionFromNodeModules();
  if (fromNodeModules) return fromNodeModules;
  throw new Error('拿不到 Electron 版本：传 --electron-version，或在 desktop/ 下装好 electron 依赖');
}

function resolveBinding(args) {
  if (args.binding) return path.resolve(args.binding);
  if (!args.appDir) throw new Error('要么给 --app-dir，要么给 --binding');
  const unpacked = path.join(path.resolve(args.appDir), 'resources', 'app.asar.unpacked');
  const found = abiLib.findBetterSqlite3Binding(unpacked);
  if (found) return found;
  throw new Error(
    `app.asar.unpacked 里没有 better_sqlite3.node：${unpacked}\n` +
      '  打包时 asarUnpack 未生效，内嵌 server 启动会报 Could not locate the bindings file',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.appDir && !args.binding)) {
    console.log(
      '用法：node desktop/scripts/verify-packaged-abi.js --app-dir <win-unpacked> [--quiet]\n' +
        '      node desktop/scripts/verify-packaged-abi.js --binding <better_sqlite3.node> --electron-version <版本>',
    );
    return args.help ? 0 : 2;
  }
  const { version, source } = resolveElectronVersion(args);
  const binding = resolveBinding(args);
  const result = abiLib.assertBindingAbi({ bindingFile: binding, electronVersion: version });
  if (!args.quiet) {
    console.log(`[abi] Electron ${version}（${source}）`);
    console.log(`[abi] ${binding}`);
    if (result.napi) console.log('[abi] NAPI 模块，ABI 跨版本稳定，无需比对');
    else console.log(`[abi] ✓ 原生模块 ABI ${result.abi} 与打包的 Electron 一致`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error('[abi] ✗ ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, resolveElectronVersion, resolveBinding, electronVersionFromBuilderConfig };
