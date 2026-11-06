// 安装器「内置运行时」回归测试（node 原生，无第三方依赖；不需要 Windows）：
//   node installer/scripts/tests/installer-runtime-bundle.test.js
//
// 目标（2026-11-06 用户要求）：安装器 exe 必须内置固定版本的 Node 与 pnpm，
// 安装时离线解压/拷贝即可，不再「联网下 Node + npm install pnpm」——那条链路在
// Node 22 的 npm.ps1 shim 上翻车（Unknown command: "file"），且版本不受控。
// 本测试锁住四件事：
//   1) 版本号唯一事实源 install-engram.ps1 与 prepare-runtime.js 一致，且与仓库其他 pin 一致；
//   2) 部署脚本先找内置运行时，找不到才退回下载/npm（正常路径绝不经过 npm）；
//   3) 打包配置（private installer + public installer）都把 runtime 打进 exe；
//   4) 运行时产物不进 Git。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const installerDir = path.join(__dirname, '..', '..');
const mainDir = path.join(installerDir, '..');
const ps1 = path.join(mainDir, 'scripts', 'install-engram.ps1');
const text = fs.readFileSync(ps1, 'utf8');
const prepare = require(path.join(installerDir, 'scripts', 'prepare-runtime.js'));
const pkg = JSON.parse(fs.readFileSync(path.join(installerDir, 'package.json'), 'utf8'));

const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

// ---------- 1) 版本 pin 一致 ----------
const pinned = prepare.readPinnedVersions(ps1);
check('ps1 声明 Node 22.20.0', pinned.node === '22.20.0', pinned.node);
check('ps1 声明 pnpm 10.20.0', pinned.pnpm === '10.20.0', pinned.pnpm);
check('prepare-runtime 默认读取 ps1 的版本 pin',
  prepare.readPinnedVersions().node === pinned.node && prepare.readPinnedVersions().pnpm === pinned.pnpm);

const nodeRuntimeLib = fs.readFileSync(path.join(mainDir, 'desktop', 'scripts', 'lib', 'node-runtime.js'), 'utf8');
const mNode = /const NODE_VERSION = '([^']+)'/.exec(nodeRuntimeLib);
check('与桌面端随包 Node 版本一致（' + (mNode ? mNode[1] : '?') + '）',
  Boolean(mNode) && mNode[1] === pinned.node, mNode ? mNode[1] : 'not found');

const dockerfile = fs.readFileSync(path.join(mainDir, 'Dockerfile'), 'utf8');
const mPnpm = /corepack prepare pnpm@([0-9.]+) --activate/.exec(dockerfile);
check('与 Dockerfile 的 pnpm pin 一致（' + (mPnpm ? mPnpm[1] : '?') + '）',
  Boolean(mPnpm) && mPnpm[1] === pinned.pnpm, mPnpm ? mPnpm[1] : 'not found');

// ---------- 2) 部署脚本：内置优先，npm 只在无运行时兜底 ----------
check('脚本声明 ENGINE_VERSION 2', /^# ENGINE_VERSION: 2$/m.test(text));
check('脚本能定位内置运行时目录', text.includes('$runtimeDir') && text.includes('ENGRAM_RUNTIME_DIR'));
check('识别资源目录 runtime\\node zip', text.includes('Join-Path $runtimeDir $nodeZip'));
check('识别资源目录 runtime\\pnpm\\pnpm.cjs', text.includes("Join-Path $runtimeDir 'pnpm'"));
check('内置 Node 走 Expand-Archive 离线解压', text.includes('Expand-Archive $bundledNodeZip'));
check('内置 pnpm 拷贝到安装目录', text.includes('Copy-Item (Join-Path $bundledPnpmDir'));
check('内置 pnpm 会校验精确版本', text.includes('if ($installed -ne $pnpmVer)'));
check('内置 pnpm 先于 npm 兜底（正常路径不执行 npm）',
  text.indexOf('$bundledPnpmDir -and') >= 0 &&
  text.indexOf('$bundledPnpmDir -and') < text.indexOf('function Install-Pnpm'));
check('内置 Node 先于联网下载',
  text.indexOf('if ($bundledNodeZip -and') >= 0 &&
  text.indexOf('if ($bundledNodeZip -and') < text.indexOf('Get-RemoteFile $nodeUrls[0]'));
check('npm 兜底仍走 npm.cmd（npm.ps1 会吞参数）', text.includes('Invoke-Logged $npmCmd @($attempt.args)'));
check('兜底安装的 pnpm 也锁精确版本', text.includes('pnpm@$pnpmVer') && !text.includes('pnpm@$pnpmMajor'));

// ---------- 3) 打包配置 ----------
const extra = pkg.build.extraResources || [];
check('installer/package.json 把 runtime 作为 extraResources',
  extra.some((e) => e && String(e.from).replace(/\\/g, '/') === 'resources/runtime' && e.to === 'runtime'),
  JSON.stringify(extra));
check('installer dist 先准备运行时', String(pkg.scripts.dist).includes('prepare-runtime.js'));
check('installer 提供 prepare-runtime 脚本', pkg.scripts['prepare-runtime'] === 'node scripts/prepare-runtime.js');
check('installer files 带 preload.js', (pkg.build.files || []).includes('preload.js'));

const publish = fs.readFileSync(path.join(mainDir, 'scripts', 'publish-public-installer.ps1'), 'utf8');
check('公开安装器发布流程也准备 runtime', publish.includes('prepare-runtime.js'));
check('公开安装器把 runtime 放进 extraResources', publish.includes("to = 'runtime'"));
check('公开安装器打包后校验 runtime 存在', publish.includes('resources\\runtime'));

const snapshot = fs.readFileSync(path.join(mainDir, 'scripts', 'make-public-snapshot.sh'), 'utf8');
for (const f of ['preload.js', 'bundle-zip.js', 'engine.js', 'prepare-runtime.js']) {
  check('公开快照导出 ' + f, snapshot.includes(f));
}

// ---------- 4) prepare-runtime 的产物与校验 ----------
const prepText = fs.readFileSync(path.join(installerDir, 'scripts', 'prepare-runtime.js'), 'utf8');
check('prepare-runtime 校验 zip 包内 node.exe 版本', prepText.includes('validateNodeZip') && prepText.includes('extractNodeVersion'));
check('prepare-runtime 校验 pnpm.cjs 版本', prepText.includes('pnpmVersionOf') && prepText.includes('-v'));
check('prepare-runtime 提供 --check 自检', prepText.includes("'--check'"));
check('prepare-runtime 写 manifest.json', prepText.includes('manifest.json'));

const gitignore = fs.readFileSync(path.join(mainDir, '..', '.gitignore'), 'utf8');
check('runtime 产物被 .gitignore 排除', gitignore.includes('main/installer/resources/runtime/'));

// ---------- 5) 引擎选择接线（旧克隆不能盖新 exe） ----------
const engineLib = require(path.join(installerDir, 'scripts', 'lib', 'engine.js'));
check('部署脚本版本标记可被 GUI 引擎选择器识别', engineLib.parseEngineVersion(text) === 2);

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : '  (' + (c.detail || '不满足') + ')'));
}
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
if (failed) process.exit(1);
