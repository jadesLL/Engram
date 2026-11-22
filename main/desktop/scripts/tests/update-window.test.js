// 更新进度小窗能力与外观护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/update-window.test.js
//
// 背景：更新进度窗是无边框窗口（frame: false），没有系统标题栏按钮，用户此前无法最小化——
// 再加上它始终置顶（screen-saver 级），更新构建期间会挡住全屏。修法是页面右上角自绘最小化按钮，
// 经专用 preload 发 IPC。窗口后来改成紧凑深色卡片（应用图标 + Engram + 当前步骤 + 细进度线），
// 卡片整块是拖拽区，最小化按钮必须显式 no-drag。这些契约分散在 lib/update-card.js 的 HTML 字符串、
// main.js 的窗口选项与 preload 文件里，单靠运行验证容易漏，故做结构性断言：
//   1) 小窗必须挂 update-preload.js，且不挂主窗 preload.js（data: 页面不能拿到完整 wikiDesktop 桥）；
//   2) 主进程必须注册最小化通道，且只对更新小窗自己的 webContents 生效；
//   3) 页面按钮必须在拖拽区之外（-webkit-app-region: no-drag），否则点击会被窗口拖拽吃掉；
//   4) 卡片保持「图标 + 应用名 + 步骤」的紧凑结构，窗口透明且居中（圆角与投影由页面画）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..', '..'); // main/desktop
const mainJs = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(DESKTOP, 'update-preload.js'), 'utf8');
const card = fs.readFileSync(path.join(DESKTOP, 'lib', 'update-card.js'), 'utf8');

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
assert.ok(card.includes('class="win-min" id="win-min"'), '更新进度页必须渲染最小化按钮');
assert.ok(/\.win-min \{[^}]*-webkit-app-region: no-drag/.test(card), '最小化按钮必须声明 -webkit-app-region: no-drag');
assert.ok(card.includes('window.engramUpdateWindow.minimize()'), '按钮点击必须调用 preload 暴露的 minimize()');

// 4. 紧凑卡片：图标 + 应用名 + 步骤 + 细进度线；窗口透明居中，圆角与投影由页面自己画
assert.ok(card.includes('class="app-icon"'), '卡片必须渲染应用图标');
assert.ok(card.includes('class="app-name">Engram'), '卡片标题必须是 Engram');
assert.ok(card.includes('id="step"'), '卡片必须有可原地更新的步骤行');
assert.ok(card.includes('class="bar"'), '卡片必须保留细进度线');
assert.ok(mainJs.includes('transparent: true'), '卡片窗口必须透明（否则圆角外是系统直角底色）');
assert.ok(mainJs.includes('center: true'), '卡片窗口必须居中显示');
assert.ok(mainJs.includes('updateCard.WINDOW.height'), '窗口尺寸必须取自卡片模块，避免两处漂移');

console.log('  ✓ 更新小窗：专用 preload + 最小化 IPC + no-drag 按钮 + 紧凑卡片结构完整');
