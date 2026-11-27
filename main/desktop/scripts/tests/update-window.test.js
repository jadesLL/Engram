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

// 1. 专用 preload：只暴露最小化与关闭，不复用主窗桥
assert.ok(
  preload.includes("exposeInMainWorld('engramUpdateWindow'"),
  'update-preload.js 必须用 contextBridge 暴露 window.engramUpdateWindow',
);
assert.ok(
  preload.includes("minimize: () => ipcRenderer.send('desktop-update-window-minimize')"),
  '最小化必须走 ipcRenderer.send(desktop-update-window-minimize)',
);
assert.ok(
  preload.includes("close: () => ipcRenderer.send('desktop-update-window-close')"),
  '关闭按钮必须走 ipcRenderer.send(desktop-update-window-close)',
);
assert.ok(
  !preload.includes("exposeInMainWorld('wikiDesktop'"),
  '更新小窗不能复用主窗 preload（会把完整桌面桥暴露给 data: 页面）',
);
assert.ok(!preload.includes('invoke('), '小窗只需要单向发送，不开放 invoke 通道');

// 2. 窗口挂专用 preload（而非主窗 preload.js），且正常更新期间不可关闭、报错后才开放关闭
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
assert.ok(
  /ipcMain\.on\('desktop-update-window-close', \(event\) => \{[\s\S]*?event\.sender !== updateWin\.webContents[\s\S]*?!updateWin\.isClosable\(\)[\s\S]*?updateWin\.close\(\)/.test(
    mainJs,
  ),
  '主进程必须注册关闭通道，校验来源且只在可关闭（报错）时允许关闭',
);
assert.ok(mainJs.includes('closable: false'), '更新小窗创建时必须设为不可关闭（报错前无关闭能力）');
assert.ok(
  /function failUpdateProgress[\s\S]*?setClosable\(true\)/.test(mainJs),
  '报错进入 failUpdateProgress 时必须放开窗口关闭',
);

// 3. 页面按钮存在、可点击（no-drag）、点击调用 preload 桥；关闭按钮仅报错态显示
assert.ok(card.includes('class="win-min" id="win-min"'), '更新进度页必须渲染最小化按钮');
assert.ok(card.includes('class="win-close" id="win-close"'), '更新进度页必须渲染右上角关闭按钮');
assert.ok(/\.win-min \{[^}]*-webkit-app-region: no-drag/.test(card), '最小化按钮必须声明 -webkit-app-region: no-drag');
assert.ok(/\.win-close \{[^}]*display:\s*none[^}]*-webkit-app-region: no-drag/.test(card), '关闭按钮默认必须隐藏且声明 no-drag');
assert.ok(/\.failed \.win-close \{[^}]*display:\s*flex/.test(card), '仅在 failed 状态才显示右上角关闭按钮');
assert.ok(card.includes('window.engramUpdateWindow.minimize()'), '最小化按钮点击必须调用 preload 暴露的 minimize()');
assert.ok(card.includes('window.engramUpdateWindow.close()'), '关闭按钮点击必须调用 preload 暴露的 close()');

// 4. 紧凑卡片：图标 + 应用名 + 步骤 + 细进度线；窗口透明居中，圆角与投影由页面自己画
assert.ok(card.includes('class="app-icon"'), '卡片必须渲染应用图标');
assert.ok(card.includes('class="app-name">Engram'), '卡片标题必须是 Engram');
assert.ok(card.includes('id="step"'), '卡片必须有可原地更新的步骤行');
assert.ok(card.includes('class="bar"'), '卡片必须保留细进度线');
assert.ok(mainJs.includes('transparent: true'), '卡片窗口必须透明（否则圆角外是系统直角底色）');
assert.ok(mainJs.includes('center: true'), '卡片窗口必须居中显示');
assert.ok(mainJs.includes('updateCard.WINDOW.height'), '窗口尺寸必须取自卡片模块，避免两处漂移');

// 5. 源码更新时序：弹窗出现即关闭主软件，更新完重启，报错时只留弹窗报错、不弹回主窗
const runIdx = mainJs.indexOf('async function runSourceUpdate()');
const runBody = mainJs.slice(runIdx, mainJs.indexOf('// ---------- 应用内卸载', runIdx));
const showAt = runBody.indexOf('showUpdateProgress()');
const closeMainAt = runBody.indexOf('closeMainAppForUpdate()');
const pullAt = runBody.indexOf("runGit(['pull'");
assert.ok(showAt >= 0 && closeMainAt > showAt && pullAt > closeMainAt, 'runSourceUpdate 必须先弹进度窗、立即关掉主软件，再开始 git pull');
assert.equal(runBody.includes('showMainWindow('), false, 'runSourceUpdate 报错或失败时不得弹回主窗，只留在弹窗报错');

console.log('  ✓ 更新小窗：专用 preload + 最小化/仅报错可关 + no-drag + 弹窗即关主软件流程完整');
