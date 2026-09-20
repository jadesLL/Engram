// asar staging 复制清单：打包进 app.asar 的运行时文件。
//
// 为什么单独成模块：主进程 main.js 顶部有相对 require（./lib/data-dir、./scripts/lib/deps、
// ./scripts/lib/shortcut），任何一个文件没进 asar，安装版一启动就抛 MODULE_NOT_FOUND、桌面端
// 整个起不来——而源码模式跑的是真实目录、Docker verify 只跑 server/web 的 tsc 与 node 单测，
// 两边都碰不到这条路径（2026-09-17 客户实例与 relative-requires.test.js 记录的是同类事故）。
// 抽出来后单测能直接断言「main.js / preload.js 的每个相对 require 都在这份清单里」。
const path = require('node:path');

/** 返回 [{ from: 绝对源路径, to: staging 内相对路径, produced?: 由构建产出而非仓库自带 }] */
function stagingPlan(desktopRoot) {
  const at = (...p) => path.join(desktopRoot, ...p);
  return [
    { from: at('main.js'), to: 'main.js' },
    { from: at('preload.js'), to: 'preload.js' },
    // main.js 顶部用到的 lib/data-dir 与 scripts/lib/*（都在主进程模块图里，缺一个就起不来）
    { from: at('lib'), to: 'lib' },
    { from: at('scripts', 'lib'), to: path.join('scripts', 'lib') },
    // 内嵌后端与前端产物：由 prepare-desktop.js 生成，打包前必须先构建（worktree 里通常没有）
    { from: at('server'), to: 'server', produced: true },
    { from: at('web', 'dist'), to: path.join('web', 'dist'), produced: true },
    // 托盘图标：main.js 的 trayIcon() 在 asar 内找 __dirname/icon.png
    { from: at('build', 'icon.png'), to: 'icon.png' },
  ];
}

module.exports = { stagingPlan };
