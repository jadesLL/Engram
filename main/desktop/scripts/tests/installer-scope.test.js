// 安装作用域护栏：Windows 安装包必须固定「仅当前用户」。
//   node desktop/scripts/tests/installer-scope.test.js
//
// 来历（2026-11-08）：应用内自动更新以 `/S` 静默运行安装包。只要安装目录在 Program Files
// （安装时选了「为所有用户安装」），每次静默升级都会走 installer.nsi 的 Silent 分支
// UAC_RunElevated，弹一次 UAC；而 Windows 不允许静默越过 UAC。因此安装器只提供当前用户
// 安装（%LOCALAPPDATA%\Programs\Engram），更新走 /currentuser /S，全程无需提权。
// 这里锁住三处配置，避免以后被改回「可安装到 Program Files」。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const nsis = pkg.build && pkg.build.nsis;
assert.ok(nsis, 'desktop/package.json 缺少 build.nsis 配置');

assert.equal(nsis.oneClick, false, '安装器必须保留向导（oneClick: false），双击安装包仍可选目录');
assert.equal(nsis.perMachine, false, 'perMachine 必须为 false：不允许「为所有用户安装」到 Program Files');
assert.equal(nsis.allowElevation, false, 'allowElevation 必须为 false：正常安装流程不请求提权');
assert.equal(nsis.allowToChangeInstallationDirectory, true, '安装向导仍应允许改安装目录');

const nsh = fs.readFileSync(path.join(desktopDir, 'build', 'installer.nsh'), 'utf8');
assert.match(nsh, /!macro customInstallMode/, 'installer.nsh 必须用 customInstallMode 跳过安装模式页');
assert.match(nsh, /StrCpy \$isForceCurrentInstall "1"/, 'customInstallMode 必须强制当前用户安装');
assert.match(nsh, /!macro customInit/, 'installer.nsh 必须用 customInit 处理旧版所有用户安装');
assert.match(nsh, /engr_skip_per_machine_guard/, '旧版所有用户安装的拦截必须跳过静默安装（保证旧版仍能自动升级）');

console.log('installer-scope: ok（固定当前用户安装，自动更新无需 UAC）');
