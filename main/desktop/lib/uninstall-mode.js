// 应用内「卸载 Engram」的目标解析（主进程与单测共用；纯函数，不依赖 Electron，可在 node 下直接 require）。
//
// 为什么单独一份：两种安装形态的卸载方式完全不同，也决定设置页要不要显示「卸载 Engram」——
//   源码模式：安装根 %LOCALAPPDATA%\engram 由 install-engram.ps1 铺出来，卸载走随源码带的
//             uninstall-engram.ps1（停内嵌 server、删快捷方式、可选连数据一起删）；
//   安装包模式：NSIS 安装，目录里有 electron-builder 生成的「Uninstall Engram.exe」——
//             它就是「设置 → 应用 → 已安装的应用」里那个卸载器。应用内直接用同一个，
//             不再各写一套删除逻辑（NSIS 已经处理了快捷方式、开始菜单、注册表与卸载时的进程收尾）。
//
// 2026-11-26 用户报「这什么玩意，卸载消失了」：旧实现只认源码安装根，安装包形态
// `desktop-source-uninstall-state` 返回 available=false，设置页整组连同导航项一起消失。
// 安装版用户于是只能自己想「去系统设置里找」——那条路径既没在界面上说过，也不在「本机应用」里。
const fs = require('node:fs');
const path = require('node:path');

/** electron-builder 的 UNINSTALL_FILENAME = "Uninstall ${PRODUCT_FILENAME}.exe"（两种安装作用域同名） */
const UNINSTALLER_NAME = 'Uninstall Engram.exe';

/** 安装目录里的卸载器路径（空目录返回空串，调用方据此判定「没有」） */
function uninstallerPath(installDir) {
  return installDir ? path.join(installDir, UNINSTALLER_NAME) : '';
}

function safeExists(file, exists) {
  try {
    return Boolean(exists(file));
  } catch {
    return false;
  }
}

/**
 * 解析本次运行的卸载目标。
 * @param {{sourceRoot?: string, installDir?: string, exists?: (p: string) => boolean}} input
 *   sourceRoot 源码版安装根（%LOCALAPPDATA%\engram），installDir 安装包形态的安装目录（exe 所在目录）
 * @returns {{mode: 'source'|'packaged'|'none', installDir: string, uninstaller: string}}
 */
function resolveTarget(input = {}) {
  const exists = input.exists || fs.existsSync;
  const sourceRoot = String(input.sourceRoot || '');
  if (sourceRoot) return { mode: 'source', installDir: sourceRoot, uninstaller: '' };
  const installDir = String(input.installDir || '');
  const uninstaller = uninstallerPath(installDir);
  if (uninstaller && safeExists(uninstaller, exists)) {
    return { mode: 'packaged', installDir, uninstaller };
  }
  // 便携版（每次解压到新临时目录）、win-unpacked 开发目录都没有卸载器：不提供入口，
  // 也不留一个点了只会报错的死按钮（设置页按 mode==='none' 隐藏整组并同步收起导航项）。
  return { mode: 'none', installDir, uninstaller: '' };
}

/**
 * NSIS 卸载器参数。
 * `--delete-app-data` 是 electron-builder 卸载模板认的开关（删 $APPDATA\@engram\desktop 等
 * 用户数据目录），与源码模式勾选「同时删除本机知识库数据」是同一条语义。
 * 刻意不给 `_?=<安装目录>`：那是静默升级时的原地模式；真卸载要让卸载器把自己复制到临时目录
 * 再跑，$INSTDIR 才会被整个删掉（含卸载器自身）。
 */
function packagedUninstallArgs(opts = {}) {
  return opts.deleteData ? ['--delete-app-data'] : [];
}

module.exports = {
  UNINSTALLER_NAME,
  uninstallerPath,
  resolveTarget,
  packagedUninstallArgs,
};
