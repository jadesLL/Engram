// 运行形态判定与 git 定位（主进程与单测共用；纯函数，不依赖 Electron，可在 node 下直接 require）。
//
// 为什么不直接用 app.isPackaged：Electron 是按「可执行文件名」判定的。源码模式为了让
// 资源管理器/任务栏显示 Engram 图标，会把 electron.exe 复制一份改名成 Engram.exe
// （desktop/scripts/ensure-branded-exe.js），而同一个文件只要改了名，app.isPackaged 就从
// false 变 true —— 2026-09-22 实测（同一目录、同一参数、除 exe 名外输入完全相同）：
//   electron.exe = false；Engram.exe / probe-renamed.exe / electron-dev.exe / electron2.exe = true
// 于是从桌面快捷方式（安装器创建的就是 Engram.exe）启动的源码版会把自己当成安装包形态：
// 版本号不显示提交号（用户看到「版本号只显示 1.2.7」）、设置里丢掉源码模式区块与卸载入口、
// 源码自动检查不跑、桌面自动更新反而被启用（配了更新源时会把源码版静默换成安装包）。
// 改看打包产物本身：resources/app.asar 存在才是安装包形态 —— electron-builder（asar: true）
// 与手工 desktop/scripts/pack-asar.js 都会产出它，而源码模式跑的是 node_modules/electron/dist，
// 那里只有 Electron 自带的 default_app.asar。
const fs = require('node:fs');
const path = require('node:path');

/** 打包产物相对 resources 目录的路径（存在即为安装包形态） */
const PACKAGED_ASAR = 'app.asar';

/**
 * 是否为「安装包形态」。
 * @param {string} resourcesPath Electron 的 process.resourcesPath
 * @param {(p: string) => boolean} [exists] 便于单测注入
 */
function isPackagedRuntime(resourcesPath, exists = fs.existsSync) {
  if (!resourcesPath) return false;
  try {
    return Boolean(exists(path.join(resourcesPath, PACKAGED_ASAR)));
  } catch {
    return false; // 探测失败按源码模式处理：源码模式的入口更多、退化更安全
  }
}

/** 便携 MinGit 相对 %LOCALAPPDATA% 的路径（install-engram.ps1 的默认安装根） */
const PORTABLE_GIT_REL = ['engram', 'MinGit', 'cmd', 'git.exe'];

/**
 * 解析 git 可执行文件路径。
 *
 * 全新机没有系统 Git 时，安装器把便携 MinGit 放在 %LOCALAPPDATA%\engram\MinGit，并且
 * **刻意不写系统环境变量**（install-engram.ps1：便携目录只存在于安装器进程的 PATH 里），
 * 而主进程是用户双击快捷方式启动的、继承不到那段 PATH。裸 spawn('git') 因此直接 ENOENT：
 * 提交号不显示、设置里的「检查更新」与「更新并重启」全报 git 不可用（2026-09-22 定位）。
 * 更新脚本（scripts/update-from-source.ps1）自己会前置便携目录，主进程照做即可。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(p: string) => boolean} [exists]
 */
function resolveGitCommand(env = process.env, exists = fs.existsSync) {
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || '';
  if (localAppData) {
    const portable = path.join(localAppData, ...PORTABLE_GIT_REL);
    try {
      if (exists(portable)) return portable;
    } catch {
      /* 探测失败退回系统 git */
    }
  }
  return 'git';
}

module.exports = { PACKAGED_ASAR, PORTABLE_GIT_REL, isPackagedRuntime, resolveGitCommand };
