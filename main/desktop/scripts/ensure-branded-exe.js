// 确保源码模式的 Electron 运行时目录里有带 Engram 图标的 Engram.exe。
//
// 用法（main/ 目录下）：node desktop/scripts/ensure-branded-exe.js [--quiet]
// 退出码：0 = 已就绪（含「本来就有、无需重建」）；1 = 未能生成（缺运行时/rcedit/写图标失败）。
//
// 调用方：scripts/install-engram.ps1（新装机器）与 scripts/update-from-source.ps1（更新重建后，
// Electron 运行时可能刚被换过）。设置页的「重建桌面快捷方式」按钮走同一份逻辑（main.js 注入
// Electron 的 shell API 直接重建快捷方式）。
const path = require('node:path');
const shortcutLib = require('./lib/shortcut');

const quiet = process.argv.includes('--quiet');
const appRoot = path.resolve(__dirname, '..', '..'); // main/
const desktopDir = path.join(appRoot, 'desktop');

function say(msg) {
  if (!quiet) console.log(`[brand-exe] ${msg}`);
}

async function main() {
  const distDir = shortcutLib.findElectronDist(desktopDir);
  if (!distDir) {
    console.error('[brand-exe] 未找到 Electron 运行时（node_modules/electron/dist 与 dist/win-unpacked 均缺失）');
    return 1;
  }
  const rcedit = shortcutLib.findRcedit(appRoot);
  const r = await shortcutLib.brandExe({
    distDir,
    iconPath: path.join(desktopDir, shortcutLib.ICON_REL),
    rcedit,
  });
  if (r.status === 'built') {
    say(`已生成 ${shortcutLib.BRANDED_EXE}（${r.reason === 'stale' ? '运行时已更新' : '首次生成'}）：${r.exe}`);
    return 0;
  }
  if (r.status === 'fresh') {
    say(`${shortcutLib.BRANDED_EXE} 已是最新，无需重建`);
    return 0;
  }
  // 失败不阻断安装/更新流程：图标退化成 Electron 默认图标，应用照常可用；设置页可重试
  console.error(`[brand-exe] ${r.error || r.status}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('[brand-exe] 异常：' + (e && e.message ? e.message : e));
    process.exit(1);
  },
);
