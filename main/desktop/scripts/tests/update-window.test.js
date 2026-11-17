// 更新进度小窗最小化能力护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/update-window.test.js
//
// 背景：更新进度窗是无边框窗口（frame: false），没有系统标题栏按钮，用户此前无法最小化——
// 再加上它始终置顶（screen-saver 级），更新构建期间会挡住全屏。修法是页面右上角自绘最小化按钮，
// 经专用 preload 发 IPC。这三处契约分散在 main.js 的 HTML 字符串、窗口选项与 preload 文件里，
// 单靠运行验证容易漏，故做结构性断言：
//   1) 小窗必须挂 update-preload.js，且不挂主窗 preload.js（data: 页面不能拿到完整 wikiDesktop 桥）；
//   2) 主进程必须注册最小化通道，且只对更新小窗自己的 webContents 生效；
//   3) 页面按钮必须在拖拽区之外（-webkit-app-region: no-drag），否则点击会被窗口拖拽吃掉。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..', '..'); // main/desktop
const mainJs = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(DESKTOP, 'update-preload.js'), 'utf8');

// 1. 专用 preload：只暴露最小化，不复用主窗桥
assert.ok(
  preload.includes("exposeInMainWorld('engramUpdateWindow'"),
  'update-preload.js 必须用 contextBridge 暴露 window.engramUpdateWindow',
);
assert.ok(
  preload.includes("minimize: () => ipcRenderer.send('desktop-update-window-minimize')"),
  '最小化必须走 ipcRenderer.send(desktop-update-window-minimize)',
);
assert.ok(
  !preload.includes("exposeInMainWorld('wikiDesktop'"),
  '更新小窗不能复用主窗 preload（会把完整桌面桥暴露给 data: 页面）',
);
assert.ok(!preload.includes('invoke('), '小窗只需要单向发送，不开放 invoke 通道');

// 2. 窗口挂专用 preload（而非主窗 preload.js）
assert.ok(
  mainJs.includes("preload: path.join(__dirname, 'update-preload.js')"),
  'showUpdateProgress 必须给更新小窗挂 update-preload.js',
);
assert.ok(
  /ipcMain\.on\('desktop-update-window-minimize', \(event\) => \{[\s\S]*?event\.sender !== updateWin\.webContents[\s\S]*?updateWin\.minimize\(\)/.test(
    mainJs,
  ),
  '主进程必须注册最小化通道，并校验来源是更新小窗自己',
);

// 3. 页面按钮存在、可点击（no-drag）、点击调用 preload 桥
assert.ok(mainJs.includes('class="win-min" id="win-min"'), '更新进度页必须渲染最小化按钮');
assert.ok(/\.win-min \{[^}]*-webkit-app-region: no-drag/.test(mainJs), '最小化按钮必须声明 -webkit-app-region: no-drag');
assert.ok(mainJs.includes('window.engramUpdateWindow.minimize()'), '按钮点击必须调用 preload 暴露的 minimize()');

console.log('  ✓ 更新小窗最小化：专用 preload + IPC 通道 + no-drag 按钮契约完整');
