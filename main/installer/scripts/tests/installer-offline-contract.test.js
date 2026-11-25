// 客户安装器「免联网、免构建、装完即最新」契约测试（node 原生，无第三方依赖，跨平台）：
//   node installer/scripts/tests/installer-offline-contract.test.js
//
// 背景（2026-11-26 排查）：固定链接上的 Engram-source-setup.exe 里只有 Node/pnpm 运行时、
// 没有内置环境包，客户一装就走「git clone（要私有库凭据）→ pnpm install 1GB 依赖 →
// 本机 tsc/vite 构建 → 再下 Electron 运行时」；仓库里那份预构建包还是 10-08 的旧包（v1.3.8），
// 谁本地打出来的安装器就把 1.3.8 装给客户。本测试锁住四件事：
//   1) 部署引擎有 -RequireBundle：没有内置包直接失败，绝不悄悄退回联网构建；
//   2) 包完整性门禁：缺 Node/Electron/依赖/构建产物/依赖记录的包在解压前被拒；
//   3) 预构建安装会离线落位便携 Node、还原可选离线资源（不覆盖用户已有文件）；
//   4) 打包/构建链路把「版本 + 提交」写进包清单并自检 exe 里真的带了包。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const installerDir = path.join(__dirname, '..', '..');
const mainDir = path.join(installerDir, '..');
const ps1 = fs.readFileSync(path.join(mainDir, 'scripts', 'install-engram.ps1'), 'utf8');
const pack = fs.readFileSync(path.join(mainDir, 'scripts', 'pack-prebuilt-bundle.ps1'), 'utf8');
const build = fs.readFileSync(path.join(mainDir, 'scripts', 'build-customer-installer.ps1'), 'utf8');
const gui = fs.readFileSync(path.join(installerDir, 'main.js'), 'utf8');
const ui = fs.readFileSync(path.join(installerDir, 'ui.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(installerDir, 'package.json'), 'utf8'));

const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

// ---------- 1) 引擎：没包就失败，不退回联网构建 ----------
check('引擎声明 -RequireBundle 开关', /\$RequireBundle/.test(ps1));
check(
  '带 -RequireBundle 且没有包时走 ##FAIL（不是源码模式）',
  /if \(-not \$bundleZip -and \$RequireBundle\)[\s\S]{0,400}##FAIL:bundle/.test(ps1),
);
check('失败文案点明这是安装包构建问题', ps1.includes('安装包缺少内置运行环境'));
check(
  '-RequireBundle 的失败分支在「if ($bundleZip) … else { 源码模式 }」之前',
  ps1.indexOf('if (-not $bundleZip -and $RequireBundle)') < ps1.indexOf('if ($bundleZip) {\n  Install-FromBundle'),
);

// ---------- 2) 包完整性门禁 ----------
const missingFn = /function Get-BundleMissingParts[\s\S]*?\n}/.exec(ps1);
check('引擎有包完整性检查 Get-BundleMissingParts', Boolean(missingFn));
for (const required of [
  'main/server/dist/index.js',
  'main/web/dist/index.html',
  'main/desktop/web/dist/index.html',
  'main/desktop/node_modules/electron/dist/Engram.exe',
  'main/desktop/server/node_modules/better-sqlite3/package.json',
  'main/node/node.exe',
  'main/node_modules/.engram-deps.json',
  'main/desktop/server/node_modules/.engram-deps.json',
  'main/.engram-prebuilt.json',
]) {
  check('完整性检查要求 ' + required, Boolean(missingFn) && missingFn[0].includes(required));
}
check(
  '缺件在解压覆盖之前就失败（先查后解压）',
  ps1.indexOf('Get-BundleMissingParts $zipPath') < ps1.indexOf("Invoke-Logged 'tar.exe' @('-xf'"),
);

// ---------- 3) 离线落位：便携 Node + 可选资源 ----------
check('预构建安装从包内安装便携 Node', ps1.includes("$bundleNode = Join-Path $mainDir 'node\\node.exe'"));
check(
  '便携 Node 落到 %LOCALAPPDATA%\\engram\\node（应用约定的路径）',
  ps1.includes("$portableNodeDir = Join-Path $installDir 'node'") && ps1.includes('Copy-Item -LiteralPath $bundleNode'),
);
check('有离线资源时发独立步骤（界面可见）', ps1.includes('##STEPS:bundle=解压预构建环境;assets=安装离线资源;shortcut=创建桌面快捷方式;launch=启动 Engram'));
check('离线资源只补缺、不覆盖用户文件', ps1.includes('if (Test-Path -LiteralPath $target) { $skipped++; continue }'));
check('数据目录按 config.json 的 dataDir 解析', ps1.includes('function Resolve-DataRoot') && ps1.includes(".dataDir"));
check('包清单里的版本/提交写进安装标记', ps1.includes('if ($bundleManifest) {') && ps1.includes("foreach ($prop in $bundleManifest.PSObject.Properties)"));

// ---------- 4) 打包链路：包清单 + 自检 ----------
check('打包器要求随包 Node', pack.includes("$bundleNodeSource") && pack.includes("Join-Path $bundleMain 'node'"));
check('打包器校验 Node 版本 >= 20', pack.includes("-lt 20"));
check('打包器校验 better-sqlite3 ABI 与 Electron 一致', pack.includes('verify-packaged-abi.js') && pack.includes('--electron-version'));
check('包清单写版本号', pack.includes('version    = $appVersion'));
check('打包器写回执（versions/sha256/offline）', pack.includes("($Out + '.json')"));
check('离线资源只带模型/运行时本体（不带用户凭据与数据）', pack.includes("src = 'dsh\\speech-to-text\\sensevoice\\models'") && !pack.includes("src = 'dsh';"));

check('一键构建脚本存在并调打包器', build.includes('pack-prebuilt-bundle.ps1'));
check('构建脚本用客户专用 electron-builder 配置', build.includes('electron-builder.customer.json'));
check('构建脚本自检 exe 内确实带包', build.includes("resources\\prebuilt") && build.includes('没有内置环境包'));
check('构建脚本自检引擎带 -RequireBundle', build.includes('$RequireBundle'));
check('构建脚本校验包版本/提交与源码一致', build.includes('与源码版本') && build.includes('与源码提交'));

const customerConfigPath = path.join(installerDir, 'electron-builder.customer.json');
check('客户配置存在', fs.existsSync(customerConfigPath));
if (fs.existsSync(customerConfigPath)) {
  const cfg = JSON.parse(fs.readFileSync(customerConfigPath, 'utf8'));
  const froms = (cfg.extraResources || []).map((e) => String(e.from).replace(/\\/g, '/'));
  check('客户配置带 prebuilt', froms.includes('resources/prebuilt'));
  check('客户配置带部署引擎', froms.includes('../scripts/install-engram.ps1'));
  check('客户配置不带 runtime（源码模式才需要）', !froms.includes('resources/runtime'));
  check('客户配置打 portable exe', JSON.stringify(cfg.win.target).includes('portable'));
}

// ---------- 5) GUI：强制要求内置包 ----------
check('GUI 在引擎支持时传 -RequireBundle', gui.includes("args.push('-RequireBundle')"));
check('GUI 只在有包时走预构建模式', gui.includes('if (bundle && engineText.includes(\'BundleZip\'))'));
check('界面显示内置包版本与提交', ui.includes('info.version') && ui.includes('info.commit'));
check('bundleInfo 读打包回执', fs.readFileSync(path.join(installerDir, 'scripts', 'lib', 'bundle-zip.js'), 'utf8').includes("zip + '.json'"));

// 内置包目录与 runtime 目录都不进 Git（二进制产物走发布归档）。
// .gitignore 可能在仓库根（main/..）也可能被 verify/子检出按 main/ 复制——两处任一排除即可。
const gitignoreTexts = [path.join(mainDir, '.gitignore'), path.join(mainDir, '..', '.gitignore')]
  .filter((p) => fs.existsSync(p))
  .map((p) => fs.readFileSync(p, 'utf8'));
check(
  '预构建包（zip 与回执 json）被 .gitignore 排除',
  gitignoreTexts.some((s) => s.includes('installer/resources/prebuilt/*.zip')),
);
check('运行时不进 Git', gitignoreTexts.some((s) => s.includes('installer/resources/runtime/')));
check(
  '安装器产物目录不进 Git',
  gitignoreTexts.some((s) => /^installer\/dist\/?$/m.test(s)) || gitignoreTexts.some((s) => s.includes('installer/dist/')),
  'installer/package.json 的 dist 输出目录应被忽略',
);

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : '  (' + (c.detail || '不满足') + ')'));
}
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
if (failed) process.exit(1);
