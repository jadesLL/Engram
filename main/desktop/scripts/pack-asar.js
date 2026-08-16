// asar:true 打包：手动生成 app.asar + app.asar.unpacked
// 绕过 electron-builder 因 Windows Defender 锁 electron.exe 致 rename EPERM、无法走到 asar 阶段的问题。
// 在 desktop/ 目录执行：node scripts/pack-asar.js
// 前置：
//   1. dist/win-unpacked/ 已由 Expand-Archive 解压 electron zip 生成（含 resources/，无 rename 不触发 Defender）
//   2. desktop/server/node_modules 已装（prepare-desktop 生成 + pnpm install --prod --node-linker=hoisted）
//   3. better-sqlite3 已由 @electron/rebuild 重编到 Electron ABI（desktop 的 rebuild 脚本，或 EB 内置）
// 依赖 node-linker=hoisted：让 better-sqlite3/sqlite-vec/@napi-rs/canvas 为真实目录而非 pnpm symlink，
//   否则 @electron/asar 对 unpack 的 symlink 在 app.asar.unpacked 重建会因非管理员无 symlink 权限失败。
const fs = require('node:fs');
const path = require('node:path');

// @electron/asar 是 electron-builder 的传递依赖，pnpm isolated 模式不暴露到 desktop/node_modules 顶层，
// 需从 .pnpm 虚拟 store 动态查找。
const pnpmRoot = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
let asar;
try {
  asar = require('@electron/asar');
} catch {
  const asarPkg = fs.readdirSync(pnpmRoot).find((d) => d.startsWith('@electron+asar@'));
  if (!asarPkg) throw new Error('找不到 @electron/asar，请先在仓库根 pnpm install');
  asar = require(path.join(pnpmRoot, asarPkg, 'node_modules', '@electron', 'asar'));
}

// patch app-builder-lib 的 NSIS 模板 installSection.nsh：SetDetailsPrint none→both。
// electron-builder 默认 ShowInstDetails nevershow + SetDetailsPrint none，安装时只有进度条看不到日志；
// customHeader（installer.nsh）已把详情框改 show，但 File 解压 detail 仍被 none 抑制，故 patch 成 both。
// 改的是 node_modules 模板，每次 pnpm install 会覆盖，故每次打包前由本脚本重 patch。
try {
  const abPkg = fs.readdirSync(pnpmRoot).find((d) => d.startsWith('app-builder-lib@'));
  if (abPkg) {
    const nsh = path.join(pnpmRoot, abPkg, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installSection.nsh');
    if (fs.existsSync(nsh)) {
      const s = fs.readFileSync(nsh, 'utf8');
      if (s.includes('SetDetailsPrint none')) {
        fs.writeFileSync(nsh, s.replace(/SetDetailsPrint none/g, 'SetDetailsPrint both'));
        console.log('[pack-asar] patch installSection.nsh: SetDetailsPrint none→both（安装时显示文件解压日志）');
      }
    }
  }
} catch (e) {
  console.log('[pack-asar] 跳过 installSection.nsh patch: ' + e.message);
}

const desktopRoot = path.resolve(__dirname, '..');
const staging = path.join(desktopRoot, 'staging');
const winUnpacked = path.join(desktopRoot, 'dist', 'win-unpacked');
const resourcesDir = path.join(winUnpacked, 'resources');
const asarOut = path.join(resourcesDir, 'app.asar');

function copy(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

// 1. 组装 staging（只含运行时文件，对齐 package.json 的 files glob）
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
copy(path.join(desktopRoot, 'main.js'), path.join(staging, 'main.js'));
copy(path.join(desktopRoot, 'preload.js'), path.join(staging, 'preload.js'));
copy(path.join(desktopRoot, 'index.html'), path.join(staging, 'index.html'));
copy(path.join(desktopRoot, 'server'), path.join(staging, 'server'));
copy(path.join(desktopRoot, 'web', 'dist'), path.join(staging, 'web', 'dist'));

// 2. staging/package.json（Electron 据此定位 main: main.js）
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(staging, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, main: 'main.js' }, null, 2)
);

// 2.5 把 electron.exe 重命名为 productName.exe（--prepackaged 模式不会自动重命名，
//     NSIS 快捷方式指向 productName.exe，不重命名则安装后快捷方式失效）
const productName = pkg.build && pkg.build.productName ? pkg.build.productName : pkg.name;
const exeSrc = path.join(winUnpacked, 'electron.exe');
const exeDst = path.join(winUnpacked, productName + '.exe');
if (fs.existsSync(exeSrc) && !fs.existsSync(exeDst)) {
  fs.renameSync(exeSrc, exeDst);
  console.log('[pack-asar] ' + path.basename(exeSrc) + ' → ' + productName + '.exe（快捷方式目标）');
}

// 3. asar 打包，对齐 package.json 的 asarUnpack（三个原生模块解包到 app.asar.unpacked）
// 用 unpackDir（基于 relativePath 的 isUnpackedDir 能正确匹配）而非 unpack（其内部 minimatch 用绝对 filename 有 bug）；
// 单个 brace pattern（minimatch 不接受数组）。
(async () => {
  if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
  await asar.createPackageWithOptions(staging, asarOut, {
    unpackDir: 'server/node_modules/**/{better-sqlite3,sqlite-vec*,@napi-rs/canvas*}',
  });
  const stat = fs.statSync(asarOut);
  console.log('[pack-asar] app.asar 生成完成：' + asarOut);
  console.log('[pack-asar] app.asar 大小：' + (stat.size / 1048576).toFixed(2) + ' MB');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  if (fs.existsSync(unpackedDir)) {
    const bins = [];
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.node') || e.name.endsWith('.dll')) bins.push(p);
      });
    walk(unpackedDir);
    console.log('[pack-asar] app.asar.unpacked 原生二进制：');
    bins.forEach((b) => console.log('  ' + path.relative(unpackedDir, b)));
    if (bins.length === 0) console.log('  (无，asarUnpack 可能未生效)');
  }
})();
