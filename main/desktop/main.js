// Engram 桌面端主进程（Electron）
// fork 内嵌 server 子进程（ELECTRON_RUN_AS_NODE 纯 Node 模式），探活后加载本地页面。
const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, Notification, dialog, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const dataDirLib = require('./lib/data-dir');
// 局域网访问开关与监听地址（设置 → 多端同步 → 同步群组 里把本机当中枢时用）
const localAccess = require('./lib/local-access');
const { resolveBrainPath } = require('./lib/brain-path');
const inboxRender = require('./lib/inbox-render');
const { joinLinkFromArgs, protocolRegistration } = require('./lib/join-link');
// 启动分段计时与 app.log 轮转（纯本地小工具，单测见 desktop/scripts/tests/startup-log.test.js）：
// 前者给「首次打开很慢」留可对照的分段数据，后者避免 737MB 级 app.log 拖慢启动（见 lib/app-log.js 头注释）。
const startupTiming = require('./lib/startup-timing');
const appLog = require('./lib/app-log');
// t0 = 进程真实启动时刻（Electron 引导时间计入），不是本文件第一行开始执行的时刻
const startup = startupTiming.createStartupTimer();
let pendingJoinLink = joinLinkFromArgs(process.argv);
function receiveJoinLink(raw) {
  const link = joinLinkFromArgs([raw]);
  if (!link) return;
  pendingJoinLink = link;
  showMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('join-link-ready');
}
app.on('open-url', (event, url) => { event.preventDefault(); receiveJoinLink(url); });
// 注意：deps.js 在 desktop/scripts/lib/ 下（构建期脚本与主进程共用的判定），不是 desktop/lib/
const depsLib = require('./scripts/lib/deps');
// 桌面快捷方式与品牌化 exe（源码模式的 electron.exe 图标是 Electron 原子，见 lib/shortcut.js）
const shortcutLib = require('./scripts/lib/shortcut');
// 开机自启（Windows 登录项）的命令推导与状态整理；注册表读写在本文件里（见「开机自启」段）
const loginItemLib = require('./scripts/lib/login-item');
// 运行形态判定与 git 定位：**不要用 Electron 的 app.isPackaged** —— 它按可执行文件名判定，
// 品牌启动器 Engram.exe（electron.exe 的改名副本）会被判成打包形态，源码版因此丢掉提交号与
// 源码更新入口。详见 lib/runtime-mode.js 顶部注释。
const runtimeMode = require('./scripts/lib/runtime-mode');
// 自动检查更新的节奏（启动首查 + 自适应退避 + 回前台补查），与 web 端 main/web/src/lib/updateCadence.ts
// 同一套策略：没发现更新就 2→5→10→30→60 分钟逐级拉长；发现了（或有更新待处理）保持最短间隔。
const updateCadence = require('./scripts/lib/update-cadence');
// 更新链的纯逻辑（文件名净化 / sha256 校验 / 安装结果判定），单测在 scripts/tests/update-chain.test.js
const updateChain = require('./scripts/lib/update-chain');
// 下载进度的纯逻辑（百分比收敛 / 广播节流 / 进度事件来源标记），单测在 scripts/tests/update-progress.test.js
const updateProgress = require('./scripts/lib/update-progress');
// 自动更新失败暂停的纯逻辑（同版本失败过一次就不再自动重试，记录持久化到 config.json），
// 单测在 scripts/tests/update-failure.test.js
const updateFailure = require('./scripts/lib/update-failure');
// 卸载标记与交接状态（主进程与 uninstall-launcher.js 共用，单测见 desktop/scripts/tests/uninstall-guard.test.js）
const uninstallGuard = require('./scripts/lib/uninstall-guard');
// 整棵进程树的收尾（Windows taskkill /T + tasklist 轮询），单测见 scripts/tests/process-tree.test.js。
// 只 kill 直接子进程会留下内置 Agent 的 node.exe 孙进程，它们占着安装目录里的文件，
// 覆盖安装时旧版卸载器改名失败 → 用户看到 "Failed to uninstall old application files...: 2"。
const processTree = require('./scripts/lib/process-tree');

/** 是否安装包形态（打包产物 app.asar 存在）；源码模式（含品牌启动器）一律 false */
const PACKAGED = runtimeMode.isPackagedRuntime(process.resourcesPath);

// 本次启动是否来自开机自启（登录项命令里带 --silent-start）：是则只驻留托盘、不显示主窗。
// Windows 上 Electron 的 wasOpenedAtLogin / openAsHidden 只在 macOS 有效，只能靠显式标记判定。
const SILENT_START = loginItemLib.isSilentStart(process.argv);

// 主进程没有全局兜底时，任何未处理的 Promise 拒绝都会让整个应用静默退出
// （Node ≥15 语义；本应用多处后台任务不 await，必须自己接住）。
process.on('unhandledRejection', (reason) => log('[main] 未处理的 Promise 拒绝：' + describeError(reason)));
process.on('uncaughtException', (e) => log('[main] 未捕获异常：' + describeError(e)));

// 隔离/自定义数据目录：自动化测试与便携场景用；必须在单实例锁之前生效（锁文件位于 userData 内）
if (process.env.ENGRAM_USER_DATA) app.setPath('userData', path.resolve(process.env.ENGRAM_USER_DATA));

// 单实例锁：点 X 后应用驻留托盘，此时再次启动若开新实例，其 fork 的后端会撞 18180 端口、
// 探活又探测到旧实例的服务，出现双窗口共用单后端的混乱。故第二实例直接退出并唤起已有窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    receiveJoinLink(joinLinkFromArgs(argv));
  });
}

// productName 变化会让 Electron 默认 userData 目录
// （%APPDATA%/<productName>）跟着变。旧目录里有全部本地数据，
// 这里一次性迁移到新目录，之后不再回看旧路径。
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'Engram');
try {
  if (fs.existsSync(LEGACY_USER_DATA) && !fs.existsSync(app.getPath('userData'))) {
    fs.mkdirSync(path.dirname(app.getPath('userData')), { recursive: true });
    fs.renameSync(LEGACY_USER_DATA, app.getPath('userData'));
  }
} catch {
  /* 迁移失败不阻断启动：新目录为空时等价于首次使用 */
}

// 默认 18180 避开 Docker 版的 18080；用户本机若同时跑 Docker engram(18080) 与 desktop，
// 两者互不抢占端口、可共存。自定义端口存 config.json 的 localPort（设置页可改）；
// ENGRAM_LOCAL_PORT 环境变量优先级最高，供隔离测试等场景覆写。
const DEFAULT_LOCAL_PORT = 18180;
// 冷启动（Defender 实时扫描冷文件等）server 就绪可超 1 分钟，固定 30s 会先弹「启动失败」
// 而服务随后其实就绪；放宽到 5 分钟，子进程退出时 waitForHealth 会提前返回。
const HEALTH_TIMEOUT_MS = 5 * 60_000;

const configFile = () => path.join(app.getPath('userData'), 'config.json');
const logFile = () => path.join(app.getPath('userData'), 'app.log');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

function validPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function getLocalPort() {
  const env = Number(process.env.ENGRAM_LOCAL_PORT);
  if (validPort(env)) return env;
  const cfg = Number(readConfig().localPort);
  if (validPort(cfg)) return cfg;
  return DEFAULT_LOCAL_PORT;
}

/**
 * 局域网访问（设置 → 多端同步 → 同步群组：把本机当同步中枢时用）。
 *
 * 桌面版默认只监听 127.0.0.1：这是个装在个人电脑上的应用，没必要让整个局域网都能打开它。
 * 但要拿这台电脑当中枢，别的设备必须连得到——那时页面上的「成员绑定地址」才可能给出
 * 局域网 IP（否则只能给出 127.0.0.1，填到手机上永远连不上，就是用户报的那个 bug）。
 * 开启后内嵌服务以 0.0.0.0 重启（窗口自动重载，仍可用 127.0.0.1 打开），状态存 config.json。
 */
function getLanAccess() {
  return localAccess.lanAccessEnabled(readConfig());
}

/** 内嵌服务的监听地址：开了局域网访问就 0.0.0.0，否则回环专用 */
function localHost() {
  return localAccess.localHost(readConfig());
}

// 旧版本曾把远端连接信息写入 config.json；远端模式移除后一次性清理，避免令牌继续留在本机。
function pruneLegacyConnectionConfig() {
  const cfg = readConfig();
  if (!cfg || typeof cfg !== 'object') return;
  let changed = false;
  for (const key of ['mode', 'remoteUrl', 'remoteToken', 'directUrl']) {
    if (key in cfg) {
      delete cfg[key];
      changed = true;
    }
  }
  if (changed) writeConfig(cfg);
}

// 数据仓库位置（类 Obsidian 仓库）：首次启动用默认位置，设置页可切换到任意目录。
// 切换不迁移数据，目标空目录由内嵌 server 启动时初始化为新仓库（见 choose-data-dir IPC）。
function getDataDir() {
  const custom = readConfig().dataDir;
  return custom ? path.resolve(String(custom)) : path.join(app.getPath('userData'), 'data');
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    /* 日志不可写时忽略 */
  }
}

// ---------- 启动分段计时 / app.log 轮转 ----------
/** 记录并输出一个启动节点（`[startup] <label> +Nms`）；同名节点只写一次（second-instance/activate 会重走启动流程） */
function startupMark(label) {
  if (startup.has(label)) return;
  log(startupTiming.formatMark(startup.mark(label)));
}

let startupSummaryDone = false;
let startupSummaryTimer = null;

/** 输出一次总耗时摘要（主界面加载完成时；启动失败/超时的兜底也走这里）；重复调用无副作用 */
function startupSummary(note) {
  if (startupSummaryDone) return;
  startupSummaryDone = true;
  if (startupSummaryTimer) {
    clearTimeout(startupSummaryTimer);
    startupSummaryTimer = null;
  }
  log(startupTiming.formatSummary(startup.marks(), { totalMs: startup.elapsedMs(), note }));
}

/**
 * 启动日志轮转：超过 20MB 就把 app.log 改名成 app.log.1（覆盖上一次的 .1），新会话写全新文件。
 * 巨型文件上的同步 append 每次都要走文件系统 + Defender 扫描；启动阶段只是改名（元数据操作），
 * 失败静默、绝不因为日志问题拖慢或阻断启动。
 */
function rotateAppLogOnStartup() {
  try {
    // 首次安装时 userData 目录可能还不存在（Electron 会在 ready 前后创建）：先建好，
    // 否则本次启动第一行 [startup] 日志会静默丢掉，而首次启动正是最需要这段数据的场景。
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  } catch {
    /* 建不了就照旧静默：日志不是启动必需项 */
  }
  const result = appLog.rotateIfNeeded(logFile());
  if (result.rotated) {
    log(
      `[main] app.log 已轮转为 app.log.1（原 ${appLog.formatBytes(result.size)}，阈值 ${appLog.formatBytes(appLog.DEFAULT_MAX_BYTES)}）`,
    );
  }
}
rotateAppLogOnStartup();
startupMark('main-loaded');

// 兜底：60s 还没进主界面（启动失败/极慢）也输出一条部分摘要，日志里至少能看到卡在哪一段
startupSummaryTimer = setTimeout(() => startupSummary('兜底输出：60s 内未进入主界面'), 60_000);
if (startupSummaryTimer.unref) startupSummaryTimer.unref();

function dataUrl(html) {
  // 过渡/错误页无交互元素：整页可拖拽，标题栏隐藏后窗口仍可移动
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html + '<style>html,body{-webkit-app-region:drag}</style>');
}

// ---------- 启动页 / 错误页（品牌化深色主题，替代裸 <h2> 文案页） ----------
const SPLASH_BG = '#0d1424';

// 品牌图形不再内联：直接读生成器产出的 SVG 源码（本页是 data: URL，相对路径不可用）。
// 深色启动页固定用暗色版；读不到就退回纯文字标题，不影响启动。
function logoSvg(cls) {
  const packed = path.join(__dirname, 'mark-dark.svg'); // 打包后：staging 把 build/mark-dark.svg 复制进 asar 根
  const dev = path.join(__dirname, 'build', 'mark-dark.svg'); // 源码运行（electron .）
  try {
    const svg = fs.readFileSync(fs.existsSync(packed) ? packed : dev, 'utf8');
    return svg
      .replace('<svg ', `<svg class="${cls}" preserveAspectRatio="xMidYMid meet" `)
      .replace(/\s(?:width|height)="\d+"/g, '');
  } catch {
    return '';
  }
}

const SPLASH_STYLE = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; align-items: center; justify-content: center;
    background: ${SPLASH_BG}; color: #e6e9f0; user-select: none;
    font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .wrap { display: flex; flex-direction: column; align-items: center; width: min(520px, 78vw); }
  .logo { width: 100px; height: 100px; margin-bottom: 30px; animation: breathe 2.4s ease-in-out infinite; }
  h1 { margin: 0 0 12px; font-size: 30px; font-weight: 700; letter-spacing: 2px; }
  .desc { margin: 0 0 40px; font-size: 14px; color: #8a93a6; text-align: center; }
  .bar { width: 100%; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.10); overflow: hidden; }
  .bar i {
    display: block; height: 100%; width: 42%; border-radius: 3px;
    background: linear-gradient(90deg, #22D3EE, #4D8AFF);
    animation: slide 1.4s ease-in-out infinite;
  }
  .status { margin-top: 16px; font-size: 12.5px; color: #67718a; min-height: 18px; text-align: center; }
  @keyframes slide { from { transform: translateX(-110%); } to { transform: translateX(340%); } }
  @keyframes breathe { 0%, 100% { transform: scale(1); opacity: .9; } 50% { transform: scale(1.06); opacity: 1; } }
  .err-icon {
    width: 72px; height: 72px; border-radius: 50%; margin-bottom: 26px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(248, 113, 113, 0.12); color: #f87171;
    font-size: 34px; font-weight: 700;
  }
  .detail { margin: 4px 0; font-size: 13px; color: #8a93a6; text-align: center; word-break: break-all; }
  .detail code { font-family: Consolas, monospace; font-size: 12px; color: #aab4c8; }
`;

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function splashPage(title, desc, status) {
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' +
    SPLASH_STYLE +
    '</style></head><body><div class="wrap">' +
    logoSvg('logo') +
    `<h1>${title}</h1><p class="desc">${desc}</p>` +
    '<div class="bar"><i></i></div>' +
    `<div class="status" id="status">${status}</div>` +
    '</div></body></html>'
  );
}

/** 错误页：与启动页同主题；lines 中的路径用 <code> 呈现 */
function errorPage(title, lines) {
  const body = lines
    .map(
      (l) =>
        `<p class="detail">${l.includes('\\') || l.includes('/') ? '<code>' + escHtml(l) + '</code>' : escHtml(l)}</p>`,
    )
    .join('');
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' +
    SPLASH_STYLE +
    '</style></head><body><div class="wrap">' +
    '<div class="err-icon">!</div>' +
    `<h1 style="font-size:24px;letter-spacing:1px;">${escHtml(title)}</h1>` +
    body +
    '</div></body></html>'
  );
}

/** 启动页状态文案原地更新；页面已切走（非 data: URL）时静默放弃 */
function setSplashStatus(text) {
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.getURL().startsWith('data:')) return;
  win.webContents
    .executeJavaScript(`const el=document.getElementById('status'); if (el) el.textContent=${JSON.stringify(text)}; true;`)
    .catch(() => {});
}

// 主进程侧页面底色跟随：窗口背景 + Windows 标题栏 overlay 一起切（进应用后由渲染进程经 IPC 接管）
function applyPageChrome(bg) {
  const dark = bg === SPLASH_BG;
  try {
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(bg);
      if (typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({ color: bg, symbolColor: dark ? '#e6e9f0' : '#37352f' });
      }
    }
  } catch {
    /* 非 Windows 或未启用 overlay 时忽略 */
  }
}

let win = null;
let serverChild = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
let currentIconAppearance = 'light';

// 外部链接收口：window.open / target=_blank 的子窗口会继承 preload（window.wikiDesktop），
// 等于把桌面端桥暴露给任意外部站点；页面内导航同理只允许应用自身来源。
// http(s) 链接一律交给系统浏览器打开，其余协议直接拒绝。
function isInternalNavUrl(target) {
  try {
    const u = new URL(target);
    // data:/file: 不算内部导航：主进程自己加载的启动页/错误页走 loadURL（不触发本判定，见
    // loadWin），这里拦的是渲染层发起的跳转——放过去等于让任意 data: 页面带着 preload 桥运行。
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const cur = win ? new URL(win.webContents.getURL()) : null;
    return Boolean(cur && cur.origin && cur.origin !== 'null' && cur.origin === u.origin);
  } catch {
    return false;
  }
}

function openExternally(url) {
  if (/^https?:/i.test(url)) void shell.openExternal(url);
}

function createWindow({ silent = false } = {}) {
  win = new BrowserWindow({
    // 开机自启：窗口照常创建并加载（托盘图标可直接唤起），但先不显示 —— 静默驻留托盘
    show: !silent,
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    title: 'Engram',
    autoHideMenuBar: true,
    // 源码模式窗口/任务栏图标（electron.exe 自带的是 Electron 默认图标）；打包版 exe 已内嵌图标
    icon: windowIcon(),
    // 标题栏融合进应用：系统标题栏隐藏，右上角最小化/最大化/关闭由 Windows WCO 原生绘制，
    // 颜色初值匹配启动页，进入应用后由渲染进程按主题经 set-title-bar-overlay 同步。
    // height 36 须与 web 端 main.css 的 --win-titlebar-h 一致。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f7f5', symbolColor: '#37352f', height: 36 },
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 启动计时：窗口首次可绘制 + 页面加载完成。did-finish-load 会对启动页（data:）和主界面（http:）
  // 各触发一次：启动页给 splash 标记；主界面（HTML + JS/CSS 资源全部就绪）即 `ui-loaded`，
  // 也是「用户终于看到界面」的终点，此时输出总耗时摘要。错误页同为 data:，不会误报 ui-loaded。
  win.once('ready-to-show', () => startupMark('window-painted'));
  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    if (!/^https?:/i.test(win.webContents.getURL())) {
      // data: 页：正常是启动页；启动失败时错误页也是 data:，此时摘要已输出，不再误记成 splash
      if (!startupSummaryDone) startupMark('splash');
      return;
    }
    startupMark('ui-loaded');
    startupSummary();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalNavUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  // 点 X 不退出：隐藏窗口驻留托盘，内嵌 server 继续运行；真正退出（托盘/菜单「退出」、升级安装）
  // 走 before-quit 先置 quitting，close 不再拦截。
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideToTray();
    }
  });
  // 从托盘/后台回到主窗就补查一次更新，不用等下一轮退避（内部去抖）
  win.on('focus', () => pokeUpdateChecks('window-focus'));
  return win;
}

// ---------- 托盘 ----------
function iconAsset(ext, appearance = currentIconAppearance) {
  const name = `icon-${appearance === 'dark' ? 'dark' : 'light'}.${ext}`;
  const packed = path.join(__dirname, 'web', 'dist', 'brand', name);
  const dev = path.join(__dirname, '..', 'web', 'public', 'brand', name);
  return fs.existsSync(packed) ? packed : dev;
}

function windowIcon() {
  const file = iconAsset('ico');
  return fs.existsSync(file) ? file : undefined;
}

function trayIcon() {
  return nativeImage.createFromPath(iconAsset('png'));
}

/** Windows 快捷方式的图标必须是磁盘上的真实文件，不能直接指向 app.asar 内的条目。 */
function shortcutIconPath() {
  const source = iconAsset('ico');
  if (!PACKAGED) return source;
  const target = path.join(app.getPath('userData'), 'brand-icons', path.basename(source));
  const bytes = fs.readFileSync(source);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return target;
}

function updateExistingShortcutIcons() {
  if (process.platform !== 'win32') return;
  const desktopDir = path.join(appRootDir, 'desktop');
  const icon = shortcutIconPath();
  for (const lnk of [shortcutLib.shortcutPath(app.getPath('desktop')), startMenuShortcutPath()]) {
    if (!fs.existsSync(lnk) || !startMenuShortcutOwned(lnk, desktopDir)) continue;
    const spec = shell.readShortcutLink(lnk);
    if (!shell.writeShortcutLink(lnk, 'update', { ...spec, icon, iconIndex: 0 })) {
      throw new Error(`更新快捷方式图标失败：${lnk}`);
    }
  }
}

ipcMain.handle('set-icon-appearance', (_event, appearance) => {
  if (appearance !== 'light' && appearance !== 'dark') return { ok: false, error: '图标外观参数无效' };
  currentIconAppearance = appearance;
  try {
    if (win && !win.isDestroyed() && typeof win.setIcon === 'function') win.setIcon(windowIcon());
    if (tray) tray.setImage(trayIcon());
    updateExistingShortcutIcons();
    return { ok: true };
  } catch (error) {
    log('[icon] 切换图标失败：' + describeError(error));
    return { ok: false, error: describeError(error) };
  }
});

/** 托盘右键菜单：开机自启做成勾选项，后台驻留时不用回主界面也能开关 */
function trayMenuTemplate() {
  const state = launchAtLoginCache;
  return [
    { label: '打开 Engram', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '开机自启（静默到托盘）',
      type: 'checkbox',
      checked: Boolean(state && state.enabled),
      // 便携版/非 Windows 不支持时置灰，避免点了没反应
      enabled: Boolean(state && state.supported),
      click: (item) => {
        void setLaunchAtLogin(item.checked);
      },
    },
    { type: 'separator' },
    { label: '退出 Engram', click: () => app.quit() },
  ];
}

function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  } catch (e) {
    log('[tray] 刷新托盘菜单失败：' + describeError(e));
  }
}

function ensureTray() {
  if (tray) return;
  const icon = trayIcon();
  if (icon.isEmpty()) log('警告：托盘图标为空（brand PNG 资源缺失），托盘将显示空白槽位');
  tray = new Tray(icon);
  tray.setToolTip('Engram');
  log('[tray] 托盘图标已就绪（随应用启动常驻，主窗前台时也在）');
  refreshTrayMenu();
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    launchByConfig();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  pokeUpdateChecks('show-main-window');
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  ensureTray();
  if (!trayHintShown) {
    trayHintShown = true;
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Engram 仍在后台运行',
        body: '已最小化到系统托盘，服务继续运行；双击托盘图标可重新打开。',
        icon: trayIcon(),
      });
      n.on('click', () => showMainWindow());
      n.show();
    }
  }
}

// ---------- 本地模式 ----------
function serverEntryPath() {
  return path.join(__dirname, 'server', 'dist', 'index.js');
}
function webDistPath() {
  return path.join(__dirname, 'web', 'dist');
}

async function startLocalMode(notice) {
  try {
    await startLocalModeInner(notice);
  } catch (e) {
    // 调用方都不 await，异常若逃逸即 unhandledRejection → 主进程静默退出
    log('[local] 启动本地服务异常：' + describeError(e));
    startupSummary('启动过程异常，未进入主界面');
    loadWin(dataUrl(errorPage('本地服务启动失败', failureLines(['启动过程出错：', describeError(e)]))));
  }
}

// 内嵌 server 最近输出（stdout/stderr 合并，只留尾部几行）。启动失败时把这几行直接显示在错误页上：
// 只写「详见日志」用户定位不了问题——%APPDATA% 下的 app.log 动辄几百 MB，报错行早被请求日志淹没
// （v1.3.0 就是这样：所有人只看到「启动超时或内嵌服务异常」，真正的 ERR_DLOPEN_FAILED 在日志里）。
const SERVER_TAIL_LINES = 6;
let serverTail = [];

function pushServerTail(chunk) {
  for (const raw of String(chunk).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    serverTail.push(line.length > 240 ? line.slice(0, 240) + '…' : line);
  }
  if (serverTail.length > SERVER_TAIL_LINES) serverTail = serverTail.slice(-SERVER_TAIL_LINES);
}

/** 启动失败页的内容：固定线索 + 内嵌服务最后输出（有就附带） */
function failureLines(lines) {
  return serverTail.length ? [...lines, '内嵌服务最后输出（排查线索）：', ...serverTail] : lines;
}

async function startLocalModeInner(notice) {
  const entry = serverEntryPath();
  if (!fs.existsSync(entry)) {
    applyPageChrome(SPLASH_BG);
    startupSummary('未找到内置服务，未进入主界面');
    loadWin(dataUrl(errorPage('本地后端缺失', ['未找到内置服务：', entry])));
    return;
  }
  // notice 作为启动页初始状态直接内联（setSplashStatus 要等 data: URL 就绪，紧跟 loadURL 会静默失效）
  const status = notice || '正在启动本地服务…';
  loadWin(
    dataUrl(
      splashPage(
        '环境准备中',
        '正在准备运行环境，请稍候，完成后自动进入主界面。',
        escHtml(status),
      ),
    ),
  );
  applyPageChrome(SPLASH_BG);
  const port = getLocalPort();
  // 提交身份一并交给内嵌 server（/api/update/state 返回），与渲染层经 IPC 拿到的是同一份
  const identity = await gitIdentity();
  startupMark('git-identity');
  // 内置 Agent（dsh）必须用真实 Node 拉起：server 跑在 Electron 的纯 Node 模式里，而 dsh 的
  // 原生模块不认 Electron 36 的 V8 指纹（详见 server/src/assistant/agentNode.ts）。
  // 安装包用 resources/node/node.exe；源码模式用系统 / 便携 Node（找不到就留空，server 会给明确提示）。
  const agentNode = runtimeMode.resolveNodeRuntime({ resourcesPath: process.resourcesPath });
  if (agentNode) {
    log(`[local] 内置 Agent 使用 Node 运行时：${agentNode.path}（${agentNode.source}）`);
  } else {
    log('[local] 未找到可用的 Node.js（内置 Agent 控制台/聊天将不可用）');
  }
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    TZ: 'Asia/Shanghai',
    DATA_DIR: getDataDir(),
    PORT: String(port),
    HOST: localHost(),
    OFFICE_EDITOR_ENABLED: 'false',
    ENGRAM_WEB_DIST: webDistPath(),
    ENGRAM_APP_VERSION: app.getVersion(),
    ENGRAM_GIT_SHA: identity.commit,
    // 仅「真实 Node」路径有意义：server 会把它探测校验（>=20）后覆盖 process.execPath 再拉起 dsh
    ...(agentNode ? { ENGRAM_NODE_BIN: agentNode.path } : {}),
  };
  // 命门：必须 fork（默认 execPath=electron.exe）+ ELECTRON_RUN_AS_NODE，子进程才以 Electron 纯
  // Node 模式运行、能读 app.asar 内的 node_modules；改 spawn('node') 会让 server 读不了 asar。
  serverChild = fork(entry, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  startupMark('server-fork');
  serverTail = []; // 新的一轮启动：清掉上一次的尾部输出，错误页只显示本次线索
  serverChild.stdout.on('data', (d) => {
    pushServerTail(d);
    log('[server] ' + d.toString().trim());
  });
  serverChild.stderr.on('data', (d) => {
    pushServerTail(d);
    log('[server!] ' + d.toString().trim());
  });
  serverChild.on('exit', (code) => {
    pushServerTail(`内嵌服务进程已退出（code=${code}）`);
    log(`[server] exited code=${code}`);
  });
  // 子进程 spawn 失败只发 'error' 事件；无监听者会变成 uncaughtException 直接带走主进程
  serverChild.on('error', (e) => log('[server] spawn 失败：' + describeError(e)));

  const base = `http://127.0.0.1:${port}`;
  // 探活超过 6 秒时补充说明：首次启动要初始化数据库，慢是正常的，避免被当成卡死
  const slowHint = setTimeout(() => setSplashStatus('仍在准备中，首次启动需要初始化数据库，会稍慢一些…'), 6000);
  waitForHealth(base, HEALTH_TIMEOUT_MS, () => serverChild && serverChild.exitCode === null)
    .then((ok) => {
      clearTimeout(slowHint);
      if (ok) {
        startupMark('health');
        setSplashStatus('启动完成，正在进入界面…');
        loadWin(base);
      } else {
        startupSummary('本地服务启动失败，未进入主界面');
        loadWin(dataUrl(errorPage('本地服务启动失败', failureLines(['启动超时或内嵌服务异常，详见日志：', logFile()]))));
      }
    })
    .catch((e) => {
      clearTimeout(slowHint);
      log('[local] 探活异常：' + describeError(e));
      startupSummary('探活异常，未进入主界面');
      loadWin(dataUrl(errorPage('本地服务启动失败', failureLines(['探活过程出错：', describeError(e)]))));
    });
}

/** 窗口可能已被销毁（退出流程中）；loadURL 对已销毁窗口会同步抛错 */
function loadWin(url) {
  if (!win || win.isDestroyed()) return;
  Promise.resolve(win.loadURL(url)).catch((e) => log('[local] 页面加载失败：' + describeError(e)));
}

async function waitForHealth(base, timeoutMs, isAlive = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return true;
    } catch {
      /* 尚未就绪 */
    }
    if (!isAlive()) return false; // 子进程已退出，不必等满超时
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 停掉内嵌 server 并等待其真正退出：不等就重启会撞端口，切换仓库还会撞上未关闭的数据库 */
function stopLocalChild() {
  const c = serverChild;
  serverChild = null;
  if (!c || c.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      // 超时不再只杀直接子进程：内置 Agent 的 node.exe 孙进程会活下来并占着安装目录文件
      void killChildTree(c);
    }, 5000);
    c.once('exit', finish);
    c.once('error', finish);
    try {
      c.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

/**
 * 按 PID 结束整棵进程树并等到它真的消失。
 * Windows 上 child.kill()/SIGKILL 只结束直接子进程；内置 Agent 的 dsh（resources\node\node.exe）
 * 是 server 的孙进程、还会再拉子代理，必须 taskkill /T 一起收掉，否则它们握着 app.asar.unpacked
 * 里的文件句柄，安装器的旧卸载器改名失败会直接中止升级（见 scripts/lib/process-tree.js 头注释）。
 * 返回 Promise<boolean>：是否在预算内确认整棵已退出（查询失败按已退出处理，不卡住安装）。
 */
function killChildTree(child, timeoutMs = processTree.KILL_GRACE_MS) {
  const pid = child && child.pid;
  if (!pid) return Promise.resolve(true);
  if (processTree.isWindows()) {
    try {
      execFile('taskkill', processTree.killTreeArgs(pid), { windowsHide: true }, () => {});
    } catch {
      /* 已退出 */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  return treeGone(pid, timeoutMs);
}

/** 轮询 tasklist 直到该 PID 消失（文件句柄释放）或超出预算 */
function treeGone(pid, timeoutMs) {
  if (!processTree.isWindows()) return Promise.resolve(true);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      execFile('tasklist', processTree.tasklistArgs(pid), { windowsHide: true }, (err, stdout) => {
        const alive = !err && processTree.pidAliveFromTasklist(String(stdout || ''), pid);
        if (!alive) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, processTree.POLL_INTERVAL_MS);
      });
    };
    tick();
  });
}

/**
 * 升级/退出前把内嵌 server 整棵子树清干净：先撤锁、撤端口、撤文件占用，
 * 之后安装器的旧卸载器才有机会改名旧安装目录。returns 是否确认清干净。
 */
async function stopLocalTree() {
  const c = serverChild;
  serverChild = null;
  if (!c || !c.pid) return true;
  const ok = await killChildTree(c);
  if (!ok) log('[local] 进程树在预算内未完全退出（可能仍有孙进程占文件）：pid=' + c.pid);
  return ok;
}

// ---------- 启动调度 ----------
function launchByConfig({ silent = false } = {}) {
  pruneLegacyConnectionConfig();
  createWindow({ silent });
  startupMark('window');
  startLocalMode();
  // 托盘图标随应用启动常驻：主窗在**前台开着**的时候系统托盘里也要有 Engram，
  // 不用等关窗/最小化到托盘之后才出现（之前只有静默自启与 hideToTray 才建托盘，
  // 正常启动全程托盘是空的，托盘入口（打开 / 开机自启 / 退出）也跟着没有，
  // 用户只能靠关窗「变出」图标）。ensureTray 幂等，重复调用无副作用。
  ensureTray();
  if (silent) {
    // 开机自启：主窗不显示，点托盘图标（或再双击桌面快捷方式）才出主界面
    log('[main] 开机自启：已静默启动，主窗隐藏，驻留系统托盘');
  }
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Engram',
      submenu: [
        { role: 'quit', label: '退出 Engram' },
      ],
    },
    {
      label: '编辑',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: '视图',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
  ]);
}

app.whenReady().then(() => {
  startupMark('whenReady');
  // 卸载进行中守卫：设置页点「卸载」后应用会退出、卸载脚本在后台删安装目录。这期间用户若再点图标，
  // 新实例会从正在被删的目录里起来并锁住文件，脚本就删不动——表现就是「点了卸载、退出了，但再点图标又打开了」。
  // 过期的标记（脚本早已死掉）清掉后放行，避免一次失败的卸载把应用永久锁死。
  if (uninstallInProgress()) {
    log('[uninstall] 正在卸载 Engram，本次启动直接退出：' + sourceInstallRoot());
    if (!SILENT_START) {
      try {
        dialog.showMessageBoxSync({
          type: 'info',
          title: 'Engram 正在卸载',
          message: '正在删除安装文件，请稍候…',
          detail: '卸载完成后图标会失效。如果长时间没有变化，可重启电脑后再试一次。',
        });
      } catch {
        /* 弹窗失败不影响退出 */
      }
    }
    app.quit();
    return;
  }
  // 隔离验收实例不能接管用户已安装应用的协议关联。
  if (!process.env.ENGRAM_USER_DATA) {
    app.setAsDefaultProtocolClient(...protocolRegistration(process.execPath, app.getAppPath(), !PACKAGED));
  }
  // 常开渲染进程辅助功能：读屏器/自动化可直接访问页面 DOM 树（须在 ready 后调用）
  app.setAccessibilitySupportEnabled(true);
  Menu.setApplicationMenu(buildAppMenu());
  launchByConfig({ silent: SILENT_START });
  // 上一次「退出安装」结算：版本没前进就把原因挂到 autoState.installError、写入失败暂停并弹通知，
  // 界面启动后能直接看到
  reportPendingUpdateResult();
  // 已有的失败暂停记录先灌进状态：设置页在首轮自动检查（启动 4 秒后）之前就能显示暂停横幅
  {
    const recordedFailure = readAutoUpdateFailure();
    if (recordedFailure) {
      autoState.blockedVersion = recordedFailure.version;
      autoState.blockedReason = recordedFailure.reason;
    }
  }
  // 登录项与当前安装形态对齐（换过安装目录、旧版没写静默标记时改写命令），并把状态读进托盘菜单缓存；
  // 不 await：注册表读取失败也不能挡住启动
  if (!process.env.ENGRAM_USER_DATA) void reconcileLaunchAtLogin();
  // 自动更新：启动 4 秒首查，之后自适应退避复查（2→5→10→30→60 分钟封顶，见 updateCadence）。
  // 打包形态自动下载并静默安装；源码模式只自动检查，落后时在标题栏留一枚绿色更新图标（不弹系统通知、
  // 不自动展开面板），一键更新由用户扫到图标后点面板主按钮触发。
  if (process.platform === 'win32') {
    if (PACKAGED) {
      autoState.enabled = readConfig().autoUpdate !== false;
      scheduleAutoUpdateCheck(updateCadence.STARTUP_DELAY_MS);
    } else {
      const unavailable = sourceUpdateUnavailableReason();
      if (unavailable) {
        // 预构建安装 / 非 git 检出：源码更新根本无法执行，别让自动检查每轮都报 git 错误
        sourceAutoState.enabled = false;
        setSourceAutoState({ phase: 'unsupported', error: unavailable, checkedAt: null });
        log('[source] 应用内源码更新不可用：' + unavailable);
      } else {
        sourceAutoState.enabled = readConfig().autoUpdate !== false;
        scheduleSourceCheck(updateCadence.STARTUP_DELAY_MS);
      }
    }
    // 休眠唤醒、解锁屏后立刻补查一次（内部 20 秒去抖）
    try {
      powerMonitor.on('resume', () => pokeUpdateChecks('resume'));
      powerMonitor.on('unlock-screen', () => pokeUpdateChecks('unlock-screen'));
    } catch {
      /* 个别平台不支持这些事件时忽略 */
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) launchByConfig();
});

app.on('before-quit', () => {
  quitting = true; // 真退出：放行窗口 close，不再隐藏进托盘
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* 忽略 */
    }
    tray = null;
  }
  // 退出前也要收整棵子树：只 kill 直接子进程会留下内置 Agent 的 node.exe 孙进程，
  // 它们握着安装目录里的文件，下一次覆盖安装会卡在「卸载旧版本」（见 process-tree 注释）
  if (serverChild) {
    void stopLocalTree();
  }
});

// ---------- 开机自启（Windows 登录时静默启动到系统托盘） ----------
// 注册表 Run 项是唯一事实来源：Electron 的 getLoginItemSettings 读不回带显式 name 的项
// （36.x 的 options 只有 path/args，没有 name），所以这里自己用 reg.exe 读命令行 ——
// 顺带能发现「项还在、但命令已经过期」（换过安装目录 / 旧版没写静默标记），
// 这是 get 的 openAtLogin 布尔量给不出的信息。
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/** 最近一次读到的开机自启状态：托盘菜单勾选项与设置页共用这一份 */
let launchAtLoginCache = null;

/** 读注册表某个值（REG_SZ 返回原串，REG_BINARY 返回 reg.exe 打印的十六进制串）；不存在返回空串 */
function queryRegistryValue(name, key = RUN_KEY) {
  return new Promise((resolve) => {
    // reg.exe 是普通控制台程序：同 runGit 的 spawn 方式，windowsHide 不弹黑框
    execFile('reg.exe', ['query', key, '/v', name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve('');
      const line = String(stdout || '').split(/\r?\n/).find((l) => /REG_(SZ|EXPAND_SZ|BINARY)/i.test(l));
      const m = line && line.match(/REG_(?:SZ|EXPAND_SZ|BINARY)\s+(.*)$/i);
      resolve(m ? m[1].trim() : '');
    });
  });
}

/** 登录项命令：安装包形态指自身 exe；源码模式指品牌 Engram.exe（没生成过就回退 electron.exe） */
function loginItemSpec() {
  const desktopDir = __dirname;
  let distDir = '';
  let useBranded = false;
  if (!PACKAGED) {
    distDir = shortcutLib.findElectronDist(desktopDir);
    // 品牌 exe 还没生成过就不能写进注册表：指向不存在的文件，开机之后什么都不会发生
    useBranded = Boolean(distDir && fs.existsSync(path.join(distDir, shortcutLib.BRANDED_EXE)));
  }
  return loginItemLib.loginItemSpec({
    packaged: PACKAGED,
    execPath: process.execPath,
    desktopDir,
    distDir,
    useBranded,
  });
}

function launchAtLoginSupported() {
  return loginItemLib.loginSupported({ portableDir: process.env.PORTABLE_EXECUTABLE_DIR || '' });
}

async function readLaunchAtLogin() {
  const spec = loginItemSpec();
  if (!launchAtLoginSupported()) return loginItemLib.loginState({ supported: false, spec });
  const [stored, approved] = await Promise.all([
    queryRegistryValue(spec.name),
    queryRegistryValue(spec.name, STARTUP_APPROVED_KEY),
  ]);
  return loginItemLib.loginState({
    supported: true,
    storedCommand: stored,
    disabled: loginItemLib.startupApprovedDisabled(approved),
    spec,
  });
}

/** 开关开机自启（设置页与托盘菜单共用）：写/删注册表 Run 项，广播新状态并刷新托盘菜单 */
async function setLaunchAtLogin(enabled) {
  if (!launchAtLoginSupported()) {
    return { ok: false, error: '便携版不支持开机自启（运行目录每次启动都会变）' };
  }
  const spec = loginItemSpec();
  try {
    // enabled: true 显式传：用户曾在「任务管理器 → 启动」里禁用过这一项时，这里要一并恢复启用
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      enabled: true,
      name: spec.name,
      path: spec.path,
      args: spec.args,
    });
  } catch (e) {
    log('[login-item] 写入开机自启失败：' + describeError(e));
    return { ok: false, error: describeError(e) };
  }
  log(`[login-item] 开机自启已${enabled ? '开启' : '关闭'}：${loginItemLib.loginCommandLine(spec)}`);
  const state = await readLaunchAtLogin();
  launchAtLoginCache = state;
  refreshTrayMenu();
  broadcast('desktop-launch-at-login', state);
  return { ok: true, ...state };
}

/** 启动时对齐登录项：项在、但命令与当前形态不一致就改写成当前命令（换过安装目录 / 旧版没写静默标记），
 *  否则开机要么起不来、要么弹主窗而不是静默进托盘。项不存在（用户没开自启）时一律不碰注册表。 */
async function reconcileLaunchAtLogin() {
  try {
    const state = await readLaunchAtLogin();
    launchAtLoginCache = state;
    refreshTrayMenu();
    if (!state.enabled || !state.stale) return;
    const spec = loginItemSpec();
    app.setLoginItemSettings({
      openAtLogin: true,
      // 保持用户在任务管理器里的禁用选择，不擅自恢复
      enabled: !state.blocked,
      name: spec.name,
      path: spec.path,
      args: spec.args,
    });
    log('[login-item] 登录项命令已更新为当前形态：' + loginItemLib.loginCommandLine(spec));
    launchAtLoginCache = await readLaunchAtLogin();
    refreshTrayMenu();
  } catch (e) {
    log('[login-item] 启动时对齐登录项失败（不影响使用）：' + describeError(e));
  }
}

ipcMain.handle('get-launch-at-login', async () => {
  const state = await readLaunchAtLogin();
  launchAtLoginCache = state;
  refreshTrayMenu();
  return state;
});

ipcMain.handle('set-launch-at-login', (_e, enabled) => setLaunchAtLogin(enabled));

// ---------- IPC ----------
// 主题切换时同步窗口控制按钮（WCO）配色；未启用 overlay 或平台不支持时静默忽略
ipcMain.handle('set-title-bar-overlay', (_e, opts) => {
  try {
    if (win && !win.isDestroyed() && typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({ color: String(opts?.color), symbolColor: String(opts?.symbolColor) });
    }
  } catch (e) {
    log('set-title-bar-overlay failed: ' + (e && e.message ? e.message : e));
  }
  return true;
});

// 数据保存位置查询与更改
ipcMain.handle('get-data-dir', () => {
  const cfg = readConfig();
  return { dataDir: getDataDir(), isDefault: !cfg.dataDir };
});

// 恢复备份暂存后重启内嵌 server 使其生效（applyStagedRestore 在 server 启动早期执行）
ipcMain.handle('restart-server', async () => {
  await stopLocalChild();
  startLocalMode();
  return true;
});

// 切换数据仓库（类 Obsidian）：只切位置并重启内嵌 server，不迁移数据。
// 目标已有 wiki.db 则打开它；没有则由 server 启动时自动初始化出新仓库（ensureDirs + 建表）。
ipcMain.handle('choose-data-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择数据仓库位置',
    message: '选择 Engram 数据仓库目录（已有仓库则打开，空目录则新建）',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const target = path.resolve(r.filePaths[0]);
  const current = getDataDir();
  const invalid = dataDirLib.validateSwitch(current, target);
  if (invalid) return invalid;
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    return { error: '该目录不可写，请换一个位置' };
  }
  const isNew = !dataDirLib.hasRepo(target);
  writeConfig({ ...readConfig(), dataDir: target });
  await stopLocalChild(); // 等旧服务真正退出，避免新旧进程抢端口
  startLocalMode(
    isNew ? `已在 ${target} 新建数据仓库，正在启动本地服务…` : `已切换到 ${target}，正在启动本地服务…`,
  );
  return { dir: target, isNew };
});

// 本地服务端口查询（仅本地模式有意义；isDefault=未自定义，envOverridden=环境变量覆写中）
ipcMain.handle('get-local-port', () => {
  const cfg = readConfig();
  return {
    port: getLocalPort(),
    isDefault: !cfg.localPort,
    envOverridden: Boolean(process.env.ENGRAM_LOCAL_PORT),
  };
});

// 改前临时 bind 探测占用，避免改到被占端口后内嵌服务起不来只剩失败页
function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

ipcMain.handle('set-local-port', async (_e, raw) => {
  const port = Number(raw);
  if (!validPort(port)) return { error: '端口需为 1-65535 的整数' };
  if (process.env.ENGRAM_LOCAL_PORT) return { error: 'ENGRAM_LOCAL_PORT 环境变量已指定端口，本次修改不生效' };
  if (port === getLocalPort()) return { port, same: true };
  if (await portBusy(port)) return { error: `端口 ${port} 已被其他程序占用，请换一个` };
  const cfg = readConfig();
  if (port === DEFAULT_LOCAL_PORT) delete cfg.localPort; // 改回默认值即清除自定义记录
  else cfg.localPort = port;
  writeConfig(cfg);
  await stopLocalChild();
  startLocalMode(); // 健康检查通过后窗口自动加载新端口的 server
  return { port };
});

// 局域网访问查询（设置页「同步群组」里把本机当同步中枢时要用；enabled=内嵌服务监听 0.0.0.0）
ipcMain.handle('get-lan-access', () => ({ enabled: getLanAccess() }));

/**
 * 开关局域网访问：写 config.json 后以新监听地址重启内嵌服务（窗口会重新加载）。
 * 关掉时回到 127.0.0.1——电脑不再对局域网暴露，作为中枢时成员也就连不上（同步面板会提示）。
 */
ipcMain.handle('set-lan-access', async (_e, enabled) => {
  const next = Boolean(enabled);
  if (next === getLanAccess()) return { enabled: next, same: true };
  writeConfig({ ...readConfig(), lanAccess: next });
  await stopLocalChild();
  startLocalMode(next
    ? '已开启局域网访问，正在以新监听地址重启本地服务…'
    : '已关闭局域网访问，正在以回环地址重启本地服务…');
  return { enabled: next };
});

// 远程文件「用系统程序打开」：渲染进程把文件字节传过来，写临时目录后调系统默认程序
ipcMain.handle('open-file-bytes', (_e, name, bytes) => {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '-');
  const dir = path.join(app.getPath('temp'), 'engram');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe);
  fs.writeFileSync(file, Buffer.from(bytes));
  return shell.openPath(file); // 空串=成功
});

/*
 * 收集箱原文件「用系统默认应用打开」。
 *
 * 这里只收 vault 相对路径、不收字节：收集箱接的是几百 MB 到 GB 级的录屏与压缩包，
 * 走 open-file-bytes 那条链路（渲染进程 fetch → Array.from(buf) → IPC）会把内存和
 * IPC 通道打爆。本地模式下主进程与服务端同一台机器、同一份数据目录，直接按路径打开即可。
 *
 * 安全：只允许 <数据目录>/brain/收集箱 内的文件，不接受任意绝对路径。
 * 前缀比较不够——收集箱内容会随同步写入，里面放一个指向系统文件的符号链接就能越界，
 * 而 openPath 是用系统默认程序打开（等于执行）。所以解出真实路径后再确认一次在界内。
 */
function resolveInboxPath(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel.startsWith('收集箱/')) throw new Error('只能打开收集箱内的文件');
  const root = fs.realpathSync(path.join(getDataDir(), 'brain', '收集箱'));
  const abs = path.resolve(root, rel.slice('收集箱/'.length));
  const within = (target) => target === root || target.startsWith(root + path.sep);
  if (!within(abs)) throw new Error('路径越界');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  const real = fs.realpathSync(abs);
  if (!within(real)) throw new Error('路径越界');
  return real;
}

// 用系统默认应用打开收集箱原文件（返回 { ok } 或 { ok:false, error }；空串错误=成功）
ipcMain.handle('inbox-open-path', async (_e, relPath) => {
  let abs;
  try {
    abs = resolveInboxPath(relPath);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const message = await shell.openPath(abs);
  return message ? { ok: false, error: message } : { ok: true };
});

// 在资源管理器中定位收集箱原文件
ipcMain.handle('inbox-reveal-path', (_e, relPath) => {
  try {
    shell.showItemInFolder(resolveInboxPath(relPath));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/**
 * 收集箱「渲染后抓取」用的隐藏窗口：渲染的是别人的页面，所以
 *  - 用**独立持久化分区**（persist:）：会话留在自己的档案里，不共享主窗口的登录态；
 *    持久化是必须的——有些站点首次访问只给壳（要等会话建立后第二次访问才给正文，
 *    见 lib/inbox-render.js 的重载一轮）；
 *  - 不许弹新窗口、不许申请任何系统权限（摄像头/定位/通知全部拒绝）。
 */
function createInboxRenderWindow() {
  const created = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:engram-inbox-render',
    },
  });
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  return created;
}

// 收集箱「渲染后抓取」：服务端抓到 JS 空壳页（needs-render）时，用隐藏窗口把这页真正渲染出来，
// 渲染后的 HTML 交回网页端存进收集箱（与浏览器「另存为」等价，仍是原件）；失败时 reject，网页端退回原提示。
ipcMain.handle('inbox-render-url', async (_e, url) =>
  inboxRender.renderInboxUrl({ createWindow: createInboxRenderWindow, url }),
);

ipcMain.handle('take-join-link', () => {
  const link = pendingJoinLink;
  pendingJoinLink = '';
  return link;
});

// 文件定位到选中项，目录直接打开；Docker/Android 没有此本机 IPC 桥。
ipcMain.handle('brain-reveal-path', async (_e, relative) => {
  try {
    const abs = resolveBrainPath(getDataDir(), relative);
    if (fs.statSync(abs).isDirectory()) {
      const error = await shell.openPath(abs);
      return error ? { ok: false, error } : { ok: true };
    }
    shell.showItemInFolder(abs);
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

// ---------- 桌面端自更新（远端仓库 Releases 拉安装包） ----------
// 更新源配置按优先级解析：
//  1) 渲染进程传入——设置页「更新源配置」所见即所得
//  2) 本地 userData/data/.env（与内嵌 server 的 /api/update/config 读写同一文件）
const UPDATE_KEYS = {
  giteaUrl: 'UPDATE_GITEA_URL',
  giteaRepo: 'UPDATE_GITEA_REPO',
  giteaAuthType: 'UPDATE_GITEA_AUTH_TYPE',
  giteaToken: 'UPDATE_GITEA_TOKEN',
  giteaUsername: 'UPDATE_GITEA_USERNAME',
  giteaPassword: 'UPDATE_GITEA_PASSWORD',
};

function desktopUpdateEnvFile() {
  // 与内嵌 server 的 DATA_DIR/.env 同一份；写死默认目录会在切换仓库后读到旧位置
  return path.join(getDataDir(), '.env');
}

function readDesktopUpdateEnv() {
  const empty = { giteaUrl: '', giteaRepo: '', giteaAuthType: 'token', giteaToken: '', giteaUsername: '', giteaPassword: '' };
  try {
    const text = fs.readFileSync(desktopUpdateEnvFile(), 'utf8');
    const out = { ...empty };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === UPDATE_KEYS.giteaUrl) out.giteaUrl = value.replace(/\/+$/, '');
      else if (key === UPDATE_KEYS.giteaRepo) out.giteaRepo = value;
      else if (key === UPDATE_KEYS.giteaAuthType) out.giteaAuthType = value;
      else if (key === UPDATE_KEYS.giteaToken) out.giteaToken = value;
      else if (key === UPDATE_KEYS.giteaUsername) out.giteaUsername = value;
      else if (key === UPDATE_KEYS.giteaPassword) out.giteaPassword = value;
    }
    return out;
  } catch {
    return empty;
  }
}

/** 按凭据方式生成 Authorization 头（token / Basic 二选一），与 server 端 repoAuthHeaders 一致 */
function repoAuthHeaders(cfg) {
  if (cfg.giteaAuthType === 'password' && cfg.giteaUsername && cfg.giteaPassword) {
    return { Authorization: `Basic ${Buffer.from(`${cfg.giteaUsername}:${cfg.giteaPassword}`).toString('base64')}` };
  }
  if (cfg.giteaToken) return { Authorization: `token ${cfg.giteaToken}` };
  return {};
}

/** 解析本次更新检查/下载使用的配置（优先级见文件顶部注释） */
async function resolveUpdateCfg(passed) {
  if (passed && typeof passed === 'object' && passed.giteaUrl && passed.giteaRepo) {
    return passed;
  }
  return readDesktopUpdateEnv();
}

/** 最近一次检查成功解析的更新源配置：下载校验复用，确保与资产 URL 同源 */
let lastCheckCfg = null;

function cmpVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((s) => Number(s.match(/\d+/)?.[0] || 0));
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((s) => Number(s.match(/\d+/)?.[0] || 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 逐层展开 cause 链：Electron/Node 的 fetch 失败时 message 只剩 "fetch failed"，根因在 cause
function describeError(e) {
  const parts = [];
  const seen = new Set();
  const walk = (cur) => {
    if (cur === null || cur === undefined || seen.has(cur)) return;
    seen.add(cur);
    if (typeof cur === 'string') {
      if (cur.trim() && !parts.includes(cur.trim())) parts.push(cur.trim());
      return;
    }
    if (typeof cur !== 'object') return;
    if (typeof cur.message === 'string' && cur.message && !parts.includes(cur.message)) parts.push(cur.message);
    if (Array.isArray(cur.errors)) cur.errors.forEach(walk);
    if ('cause' in cur) walk(cur.cause);
  };
  walk(e);
  if (!parts.length) return String(e);
  const joined = parts.join(' ← ');
  return joined.length > 400 ? joined.slice(0, 400) + '…' : joined;
}

async function giteaLatestRelease(cfg) {
  const res = await fetch(`${cfg.giteaUrl}/api/v1/repos/${cfg.giteaRepo}/releases/latest`, {
    headers: repoAuthHeaders(cfg),
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`仓库 API ${res.status}`);
  const data = await res.json();
  const tag = data.tag_name || '';
  const version = (tag.match(/v?(\d+(\.\d+)*)/i) || [])[1] || null;
  const assets = (data.assets || [])
    .filter((a) => a.browser_download_url)
    .map((a) => ({ name: a.name || '', url: a.browser_download_url, size: a.size || 0 }));
  return { tag, version, assets };
}

/**
 * 取某个资产在本次 Release 里声明的 sha256：发布流水线会把产物目录整体
 * `sha256sum ./* > sha256-<版本>.txt` 作为同名资产发出（见 .gitea/workflows/release.yml）。
 * 取不到校验值就返回 null——调用方据此拒绝安装，绝不执行未校验的安装包。
 */
async function fetchSha256ForAsset(cfg, release, asset, signal) {
  const shaAsset = updateChain.findSha256Asset(release.assets, release.version);
  if (!shaAsset) return null;
  const res = await fetch(shaAsset.url, {
    headers: repoAuthHeaders(cfg),
    redirect: 'follow',
    signal: signal || AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`校验文件下载失败 HTTP ${res.status}`);
  return updateChain.parseSha256File(await res.text(), asset.name);
}

/** 检查更新（手动 IPC 与自动轮询共用）：passedCfg 未传时按优先级自动解析更新源 */
async function checkForUpdate(passedCfg) {
  const cfg = await resolveUpdateCfg(passedCfg);
  if (!cfg.giteaUrl || !cfg.giteaRepo) {
    return { ok: false, error: 'not-configured' };
  }
  lastCheckCfg = cfg;
  try {
    const release = await giteaLatestRelease(cfg);
    if (!release) return { ok: true, latestVersion: null, hasUpdate: false, exe: null };
    const current = app.getVersion();
    const exe = release.assets.find((a) => a.name.endsWith('.exe')) || null;
    return {
      ok: true,
      currentVersion: current,
      latestVersion: release.version,
      hasUpdate: Boolean(release.version && cmpVersions(current, release.version) < 0),
      exe,
      releaseUrl: `${cfg.giteaUrl}/${cfg.giteaRepo}/releases/tag/${release.tag}`,
    };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

ipcMain.handle('desktop-update-check', (_e, passedCfg) => checkForUpdate(passedCfg));

// 下载安装包到 userData/downloads/；进度经 send 回调推送，负载带 source 标明来源
// （手动下载=发起窗口收 desktop-update-progress；自动更新=只进 autoState 并经 desktop-update-state 节流广播）
// 文件名只取 URL 末段并净化（防路径穿越），落盘后必须与 Release 的 sha256 一致才留着——
// expectedSha256 为空表示这次发布没提供校验文件，同样删除并拒绝安装（宁可更不了，不装没校验的包）。
async function downloadUpdateFile(cfg, url, send, signal, expectedSha256, progressSource = 'manual') {
  const target = String(url);
  // 只允许从配置的远端仓库下载（防注入任意 URL）
  if (!cfg || !cfg.giteaUrl || !target.startsWith(cfg.giteaUrl + '/')) {
    throw new Error('下载地址不在配置的远端仓库源内');
  }
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const file = updateChain.resolveInsideDir(dir, updateChain.installerFileName(target));
  let res;
  try {
    res = await fetch(target, { headers: repoAuthHeaders(cfg), redirect: 'follow', signal });
  } catch (e) {
    throw new Error(describeError(e));
  }
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out.write(Buffer.from(value));
    // source 让渲染层分清「手动下载」与「自动更新」：两者落盘路径相同，进度混用会让进度条来回跳
    if (send) send('desktop-update-progress', updateProgress.progressPayload({ received, total, percent: total ? Math.floor((received / total) * 100) : null }, progressSource));
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(() => resolve());
  });
  let actual = '';
  try {
    actual = await updateChain.sha256File(file);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw new Error(`安装包校验读取失败：${describeError(e)}`);
  }
  if (!expectedSha256) {
    fs.rmSync(file, { force: true });
    throw new Error('更新源未提供 sha256 校验文件（sha256-<版本>.txt），为避免执行未经校验的安装包已中止更新');
  }
  if (actual !== expectedSha256) {
    fs.rmSync(file, { force: true });
    log(`update installer hash mismatch: expected ${expectedSha256} got ${actual}`);
    throw new Error('安装包校验失败（sha256 与发布记录不一致），已删除下载文件并中止更新');
  }
  log(`update installer downloaded: ${file} (${received} bytes, sha256 ok)`);
  return { path: file, size: received, sha256: actual };
}

// 手动下载与自动更新落盘到同一个文件名（downloads/<安装包名>）：同时跑会互相覆盖，
// 进度也会在设置页来回跳（2026-11-08 用户报障）。两边都设忙标记，绝不允许并发。
let manualDownloadBusy = false;

ipcMain.handle('desktop-update-download', async (e, url) => {
  // 下载源只认主进程持有的配置（.env），渲染进程传来的任何配置一律不采信：那条路径曾能
  // 任意指定 giteaUrl，把「只从配置源下载」的校验变成空转。资产还必须真在本次 Release 里。
  const cfg = await resolveUpdateCfg(null);
  if (!cfg.giteaUrl || !cfg.giteaRepo) throw new Error('尚未配置更新源');
  if (autoState.phase === 'downloading' || autoState.phase === 'installing') {
    throw new Error('自动更新正在后台下载/安装安装包，请等它完成，或先关闭「自动更新」再手动下载');
  }
  if (manualDownloadBusy) throw new Error('安装包正在下载中，请稍候');
  manualDownloadBusy = true;
  try {
    lastCheckCfg = cfg;
    autoState.installError = ''; // 新一轮安装开始：清掉上一次的结算提示
    const release = await giteaLatestRelease(cfg);
    if (!release) throw new Error('更新源上没有可用的 Release');
    const asset = release.assets.find((a) => a.url === String(url));
    if (!asset) throw new Error('下载地址不是当前更新源最新 Release 的资产，请保存更新源设置后重试');
    const expected = await fetchSha256ForAsset(cfg, release, asset);
    const sender = e.sender;
    return await downloadUpdateFile(cfg, asset.url, (ch, data) => {
      if (sender && !sender.isDestroyed()) sender.send(ch, data);
    }, undefined, expected, 'manual');
  } finally {
    manualDownloadBusy = false;
  }
});

function validateInstallerFile(filePath) {
  const file = path.resolve(String(filePath));
  const dir = path.resolve(path.join(app.getPath('userData'), 'downloads'));
  if (!file.startsWith(dir + path.sep)) {
    throw new Error('只允许运行 downloads 目录内的安装包');
  }
  if (!fs.existsSync(file)) throw new Error('安装包不存在');
  return file;
}

// 运行安装包并退出当前应用：与自动更新共用同一条静默链（/S 静默 + 独立安装进度窗 + 自动重启），
// 不再弹安装向导。version 用于进度窗文案（可空）。
ipcMain.handle('desktop-update-run-installer', (_e, filePath, version) => {
  const file = validateInstallerFile(filePath);
  const v = sanitizeVersion(version);
  if (v) autoState.latestVersion = v;
  setAutoPhase('installing');
  setTimeout(() => {
    try {
      cleanupOldInstallers(file);
    } catch {
      /* 忽略 */
    }
    void beginSilentInstall(file, autoState.latestVersion, 'manual update');
  }, INSTALL_NOTICE_MS);
  return true;
});

// ---------- 自动更新（默认开启） ----------
// 启动 4 秒首查，之后按 updateCadence 的自适应退避复查（2→5→10→30→60 分钟封顶；这一轮发现
// 新版本就立刻回到最短间隔），休眠唤醒/解锁/窗口回到前台再补一次。发现新版本 → 后台下载 →
// 全屏「正在更新」提示 → /S 静默安装 → 装完自动重启。应用内更新（自动与手动「下载并安装」）均走
// 静默链，无安装向导；仅双击安装包本身保留向导（可选目录）。便携版（PORTABLE_EXECUTABLE_DIR）不参与自动更新。
const INSTALL_NOTICE_MS = 3500; // 「正在更新」提示层展示时长，随后退出并静默安装

const autoState = {
  enabled: true,
  // paused = 该目标版本自动更新失败过一次，本版本不再自动重试（等新版本或用户手动重试）
  phase: 'idle', // idle | unconfigured | checking | downloading | up-to-date | installing | failed | paused
  latestVersion: null,
  percent: null,
  error: '',
  // 上一次「退出安装」的结果（重启后比对版本号得出）：装失败时留在这里给界面提示，
  // 与 phase/error 分开是因为自动检查每 4 秒就会把 phase 推着走一遍，message 会被冲掉。
  installError: '',
  // 自动更新失败后暂停的目标版本与原因（config.json 的 autoUpdateFailure，见 lib/update-failure.js）；
  // 有值时 主进程不再对这个版本自动下载/安装，界面显示暂停横幅并提供「重试自动更新」。
  blockedVersion: null,
  blockedReason: '',
};
let autoBusy = false;
let autoAbort = null;

function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function setAutoPhase(phase) {
  autoState.phase = phase;
  if (phase !== 'failed') autoState.error = '';
  // 离开下载/安装态就把百分比清掉：否则下一轮下载一开场就顶着上一轮的 100%（截图里
  // 「正在后台下载 100%」配一个刚起步的进度条就是这个陈旧值）
  if (phase !== 'downloading' && phase !== 'installing') autoState.percent = null;
  broadcast('desktop-update-state', { ...autoState });
}

// 自动下载进度：只更新 autoState 并经 desktop-update-state 节流广播（见 lib/update-progress.js）。
// 不再往 desktop-update-progress 广播——那条通道归手动下载，两条一起刷会让设置页百分比乱跳。
let autoPercentPublished = null; // { percent, at } | null

/**
 * 把自动下载的最新百分比并进 autoState，按节流规则决定是否广播给渲染层。
 * 设置页的「自动更新」进度条只认 autoState.percent，与手动进度彻底分开。
 */
function publishAutoProgress(percent) {
  const result = updateProgress.nextProgressPublish(autoPercentPublished, percent, Date.now());
  autoPercentPublished = result.previous;
  autoState.percent = updateProgress.clampPercent(percent);
  if (!result.publish) return;
  broadcast('desktop-update-state', { ...autoState });
}

/** 读取已持久化的「自动更新失败暂停」记录（损坏/旧格式按没有处理，不能靠脏数据永久停掉更新） */
function readAutoUpdateFailure() {
  try {
    return updateFailure.normalizeFailure(readConfig().autoUpdateFailure);
  } catch (e) {
    log('read auto update failure failed (non-fatal): ' + describeError(e));
    return null;
  }
}

/** 把失败记录写进 config.json，并同步到主进程状态（界面横幅/重试按钮据此渲染） */
function saveAutoUpdateFailure(version, reason) {
  const record = updateFailure.recordFailure(readAutoUpdateFailure(), version, reason);
  if (!record) return null;
  try {
    const cfg = readConfig();
    cfg.autoUpdateFailure = record;
    writeConfig(cfg);
  } catch (e) {
    log('save auto update failure failed (non-fatal): ' + describeError(e));
  }
  autoState.blockedVersion = record.version;
  autoState.blockedReason = record.reason;
  return record;
}

/** 清除失败暂停记录（版本不匹配时不动）；返回是否真的清掉了 */
function clearAutoUpdateFailure(version) {
  try {
    const cfg = readConfig();
    const current = updateFailure.normalizeFailure(cfg.autoUpdateFailure);
    if (!current) return false;
    if (version && !updateFailure.appliesTo(current, version)) return false;
    delete cfg.autoUpdateFailure;
    writeConfig(cfg);
  } catch (e) {
    log('clear auto update failure failed (non-fatal): ' + describeError(e));
    return false;
  }
  autoState.blockedVersion = null;
  autoState.blockedReason = '';
  return true;
}

/**
 * 失败后主动提示用户：应用可能已缩到托盘、用户也不会主动翻设置页，只把原因写进状态等于没提示。
 * 系统通知点击直达主窗口（窗口还没建好时忽略点击，启动流程随后会正常显示主窗）。
 */
function notifyAutoUpdateFailure(version, reason) {
  if (!Notification.isSupported()) return;
  const record = updateFailure.recordFailure(null, version, reason);
  if (!record) return;
  const text = updateFailure.describeFailure(record);
  try {
    const n = new Notification({
      title: `Engram v${record.version} 自动更新失败`,
      body: text.length > 260 ? text.slice(0, 260) + '…' : text,
      icon: trayIcon(),
    });
    n.on('click', () => {
      if (win && !win.isDestroyed()) showMainWindow();
    });
    n.show();
  } catch (e) {
    log('auto update failure notification failed (non-fatal): ' + describeError(e));
  }
}

/** 已安装应用的 exe 路径：静默安装完成后由安装编排脚本拉起新版 */
function installedAppExe() {
  const exe = app.getPath('exe');
  if (path.basename(exe).toLowerCase() === 'engram.exe' && fs.existsSync(exe)) return exe;
  const fallback = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Engram', 'Engram.exe');
  return fs.existsSync(fallback) ? fallback : exe;
}

/** 版本号白名单化（仅数字与点），用于拼进安装进度窗文案 */
function sanitizeVersion(v) {
  const m = String(v || '').match(/\d+(\.\d+)*/);
  return m ? m[0] : null;
}

/** 清理 downloads 目录中除本次安装包外的旧 exe，避免版本残留累积 */
function cleanupOldInstallers(keepPath) {
  const dir = path.join(app.getPath('userData'), 'downloads');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.exe')) continue;
    const p = path.join(dir, name);
    if (path.resolve(p) === path.resolve(keepPath)) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      /* 被占用时忽略，下次更新再清 */
    }
  }
}

/** 推断当前安装作用域：Program Files 下视为所有用户安装（NSIS /allusers，静默时会触发 UAC），
 *  其余（用户目录）为当前用户安装（/currentuser，无提权）。不传模式参数时 NSIS 会继承上次
 *  安装记住的模式，可能与本次实际位置不符导致静默参数失效。
 *  新版安装器已固定「仅当前用户」（build/installer.nsh 的 customInstallMode），/allusers 只用于
 *  兼容旧版装在 Program Files 的机器——它们必须先卸载重装才能摆脱每次更新的 UAC。 */
function installerScopeFlag() {
  const exe = app.getPath('exe').toLowerCase();
  const pf = (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase();
  const pf86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
  if (exe.startsWith(pf + path.sep) || exe.startsWith(pf86 + path.sep)) return '/allusers';
  return '/currentuser';
}

/** PowerShell 单引号字符串字面量：内部单引号翻倍（进度窗标题拼进 -EncodedCommand 的脚本） */
function psq(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/** 生成安装进度窗（powershell WinForms 无边框置顶窗，经 -EncodedCommand 启动，无临时脚本文件）。
 *  窗口纯装饰：按安装包进程名轮询，安装器退出即自动关窗；被安全软件拦截也不影响安装——
 *  安装与重启由下方独立的 cmd 链执行，不依赖任何脚本解释器。 */
function spawnInstallUiForm(version, scopeFlag) {
  const v = sanitizeVersion(version);
  const title = v ? `正在安装更新 Engram v${v}` : '正在安装更新 Engram';
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    '$form = New-Object System.Windows.Forms.Form',
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$form.TopMost = $true',
    '$form.Size = New-Object System.Drawing.Size(420, 150)',
    '$form.BackColor = [System.Drawing.Color]::White',
    '$title = New-Object System.Windows.Forms.Label',
    '$title.Dock = [System.Windows.Forms.DockStyle]::Top',
    '$title.Height = 64',
    '$title.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    `$title.Text = ${psq(title)}`,
    "$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12)",
    '$form.Controls.Add($title)',
    '$sub = New-Object System.Windows.Forms.Label',
    '$sub.Dock = [System.Windows.Forms.DockStyle]::Fill',
    '$sub.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    "$sub.Text = '安装完成后应用将自动重启，请稍候，请勿关机'",
    "$sub.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)",
    '$form.Controls.Add($sub)',
    '$form.Show()',
    '$deadline = (Get-Date).AddMinutes(3)',
    'while ((Get-Date) -lt $deadline) {',
    '  [System.Windows.Forms.Application]::DoEvents()',
    "  if (-not (Get-Process -Name 'Engram Setup*' -ErrorAction SilentlyContinue)) { break }",
    '  Start-Sleep -Milliseconds 500',
    '}',
    '$form.Close()',
    '',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** 退出安装前记下目标版本：下次启动比对实际版本号，才能知道这次安装到底成没成 */
function markPendingUpdate(version) {
  const v = sanitizeVersion(version);
  if (!v) return;
  try {
    const cfg = readConfig();
    cfg.pendingUpdate = { version: v, at: Date.now() };
    writeConfig(cfg);
    autoState.installError = ''; // 新一轮安装开始：清掉上一次的结算提示
  } catch (e) {
    log('record pending update failed (non-fatal): ' + describeError(e));
  }
}

/** 启动时结算上一次退出安装的结果：版本没前进就如实报出来（UAC 被拒、被杀软拦下、半装都会这样） */
function reportPendingUpdateResult() {
  let pending = null;
  try {
    const cfg = readConfig();
    pending = cfg.pendingUpdate || null;
    if (pending) {
      delete cfg.pendingUpdate;
      writeConfig(cfg);
    }
  } catch (e) {
    log('read pending update failed (non-fatal): ' + describeError(e));
    return;
  }
  const outcome = updateChain.installOutcome({ pendingVersion: pending?.version, currentVersion: app.getVersion() });
  if (outcome.status === 'none') return;
  if (outcome.status === 'ok') {
    // 这次安装真的生效了：清掉该版本的失败暂停（手动重试成功后也恢复自动更新）
    clearAutoUpdateFailure(outcome.pendingVersion);
    log('pending update result: installed v' + outcome.pendingVersion);
    return;
  }
  if (outcome.status === 'failed') {
    autoState.installError = `上次更新到 v${outcome.pendingVersion} 未生效（当前仍是 v${outcome.currentVersion}）：可能安装被系统拦截、UAC 被取消或安装中断，可再试一次或手动下载安装包。`;
    // 安装没生效也算「本版本自动更新失败」：否则下一轮自动检查又会下载同一个包再装一次，
    // 形成永远失败、永远重启的循环。暂停本版本并主动提示用户（用户原话 2026-11-08）。
    saveAutoUpdateFailure(outcome.pendingVersion, '安装未生效：可能安装被系统拦截、UAC 被取消或安装中断');
    notifyAutoUpdateFailure(outcome.pendingVersion, autoState.installError);
  } else {
    autoState.installError = `上次更新到 v${outcome.pendingVersion} 的结果无法确认，请检查当前版本。`;
  }
  log('pending update result: ' + autoState.installError);
}

/** 静默安装 + 自动重启：cmd 链等待 /S 安装完成后无条件拉起新版（不依赖 NSIS 静默模式是否
 *  自动启动，也不依赖任何脚本解释器）；PS 进度窗为尽力而为的装饰层。
 *  **先 await stopLocalTree() 把 server 与内置 Agent 整棵子树收干净再启动安装器**：
 *  NSIS 升级的第一步是跑旧版卸载器把旧安装目录原子改名，孙进程（dsh 的 node.exe、子代理）
 *  还占着文件时这一步必失败，用户看到的就是 "Failed to uninstall old application files...: 2"。
 *  顺序不能反：先 spawn 安装器再退出是旧实现的写法，正是本次事故来源。 */
async function beginSilentInstall(file, version, source = 'auto update') {
  const treeFreed = await stopLocalTree();
  if (!treeFreed) log('[update] 安装前进程树未完全退出，继续安装（安装器兜底会清旧目录）');
  const target = installedAppExe();
  const scopeFlag = installerScopeFlag();
  const cmd = `start "" /wait "${file}" /S ${scopeFlag} & start "" "${target}"`;
  markPendingUpdate(version);
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  child.unref();
  try {
    spawnInstallUiForm(version);
  } catch (e) {
    log('install ui form failed (non-fatal): ' + describeError(e));
  }
  log(`${source}: silent installer launched (scope ${scopeFlag}): ${file} (relaunch -> ${target})`);
  setTimeout(() => app.quit(), 500);
}

// 自动检查的调度：单一定时器 + 自适应退避档位（不用 setInterval——固定间隔会把节奏写死，
// 也没法按「这一轮有没有发现更新」调整）
let autoTimer = null;
let autoBackoffIndex = 0;

function scheduleAutoUpdateCheck(delayMs) {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void autoUpdateTick();
  }, delayMs);
}

/** 一轮结束后排下一轮：这轮发现新版本 → 回到最短间隔，否则逐级拉长；关掉开关就停表 */
function scheduleNextAutoUpdateTick(hasUpdate) {
  if (process.platform !== 'win32' || !PACKAGED) return;
  if (readConfig().autoUpdate === false) return;
  autoBackoffIndex = updateCadence.nextBackoffIndex(autoBackoffIndex, hasUpdate);
  scheduleAutoUpdateCheck(updateCadence.backoffDelay(autoBackoffIndex));
}

/** 回到前台/唤醒/解锁：立刻补查一次（20 秒去抖，连续事件不会打满网络），并把节奏拉回最灵敏档 */
let updatePokedAt = 0;
function pokeUpdateChecks(reason) {
  const now = Date.now();
  if (now - updatePokedAt < updateCadence.POKE_DEBOUNCE_MS) return;
  updatePokedAt = now;
  if (process.platform !== 'win32') return;
  if (readConfig().autoUpdate === false) return;
  log('update poke: ' + reason);
  if (PACKAGED) {
    if (autoBusy || autoState.phase === 'installing') return;
    // 本版本已因失败暂停自动更新：回前台不必立刻再查一遍（周期性检查会负责发现更新的新版本）
    if (autoState.blockedVersion) return;
    autoBackoffIndex = 0;
    scheduleAutoUpdateCheck(600);
  } else {
    if (sourceUpdateUnavailableReason()) return; // 预构建安装 / 非 git 检出：没有可检查的更新
    if (sourceAutoBusy || sourceUpdating) return;
    sourceBackoffIndex = 0;
    scheduleSourceCheck(600);
  }
}

async function autoUpdateTick() {
  if (process.platform !== 'win32' || autoBusy || !PACKAGED) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return; // 便携版不自动更新
  autoState.enabled = readConfig().autoUpdate !== false;
  if (!autoState.enabled) {
    setAutoPhase('idle');
    return;
  }
  // 手动下载正在跑：别和它抢同一个安装包文件（会互相覆盖、进度互相串），一分钟后再看
  if (manualDownloadBusy) {
    scheduleAutoUpdateCheck(60_000);
    return;
  }
  autoBusy = true;
  autoAbort = new AbortController();
  let foundUpdate = false;
  // 只有「已经确定目标版本、开始处理这个版本」之后的失败才写暂停记录；检查请求本身失败
  // （网络抖动/仓库 5xx）不写，避免一次查不通就把自动更新永久停掉
  let autoAttemptVersion = null;
  try {
    setAutoPhase('checking');
    const cfg = await resolveUpdateCfg(null);
    if (!cfg.giteaUrl || !cfg.giteaRepo) {
      setAutoPhase('unconfigured');
      return;
    }
    lastCheckCfg = cfg;
    const release = await giteaLatestRelease(cfg);
    const current = app.getVersion();
    const exe = (release && release.assets.find((a) => a.name.endsWith('.exe'))) || null;
    const hasUpdate = Boolean(release && release.version && exe && cmpVersions(current, release.version) < 0);
    if (!hasUpdate) {
      setAutoPhase('up-to-date');
      return;
    }
    // 这个版本此前自动更新失败过：本版本不再自动下载/安装（用户 2026-11-08 要求），
    // 只把状态摆给界面与系统通知；发现更新的新版本时上面 appliesTo 不成立，自动恢复。
    const recordedFailure = readAutoUpdateFailure();
    if (recordedFailure && updateFailure.appliesTo(recordedFailure, release.version)) {
      autoState.latestVersion = release.version;
      autoState.blockedVersion = recordedFailure.version;
      autoState.blockedReason = recordedFailure.reason;
      setAutoPhase('paused');
      log(`auto update paused for v${recordedFailure.version} (上次失败：${recordedFailure.reason || '原因未记录'})`);
      return;
    }
    if (recordedFailure) clearAutoUpdateFailure(); // 新版本已发布：旧的失败记录不再拦自动更新
    // 这轮检查期间用户点了手动下载：让路，别和它抢同一个安装包文件（本轮就此结束）
    if (manualDownloadBusy) {
      setAutoPhase('idle');
      return;
    }
    autoAttemptVersion = release.version;
    foundUpdate = true;
    autoState.latestVersion = release.version;
    autoState.installError = '';
    autoPercentPublished = null;
    autoState.percent = null; // 新一轮下载从 0 开始，不继承上一轮的 100%
    setAutoPhase('downloading');
    const expected = await fetchSha256ForAsset(cfg, release, exe, autoAbort.signal);
    const { path: file } = await downloadUpdateFile(cfg, exe.url, (ch, data) => {
      if (ch === 'desktop-update-progress') publishAutoProgress(data.percent);
    }, autoAbort.signal, expected, 'auto');
    if (readConfig().autoUpdate === false) {
      setAutoPhase('idle'); // 下载期间开关被关掉：放弃本次安装
      return;
    }
    autoState.percent = 100;
    setAutoPhase('installing');
    // 留出全屏提示层展示时间，再退出并静默安装（独立进度窗衔接，装完自动拉起新版）
    setTimeout(() => {
      try {
        cleanupOldInstallers(file);
      } catch {
        /* 忽略 */
      }
      void beginSilentInstall(file, autoState.latestVersion);
    }, INSTALL_NOTICE_MS);
  } catch (e) {
    if (autoAbort && autoAbort.signal.aborted) {
      setAutoPhase('idle'); // 手动中止（如关闭开关），不算失败
    } else {
      autoState.error = describeError(e);
      // 目标版本已知才记录暂停（下载/校验/安装链路失败都属于「这个版本更新失败」）；
      // 记录后本进程与重启后的自动检查都不再对这个版本重试，并弹系统通知提示用户。
      if (autoAttemptVersion) {
        saveAutoUpdateFailure(autoAttemptVersion, autoState.error);
        notifyAutoUpdateFailure(autoAttemptVersion, autoState.error);
        foundUpdate = false; // 已暂停本版本：下一轮回到普通退避，不再按「有更新待处理」每分钟重查
      }
      setAutoPhase('failed');
      log('auto update failed: ' + autoState.error);
    }
  } finally {
    autoBusy = false;
    autoAbort = null;
    scheduleNextAutoUpdateTick(foundUpdate);
  }
}

ipcMain.handle('desktop-update-get-state', () => ({ ...autoState }));

ipcMain.handle('desktop-update-set-auto', (_e, enabled) => {
  const c = readConfig();
  c.autoUpdate = Boolean(enabled);
  writeConfig(c);
  autoState.enabled = c.autoUpdate;
  if (!c.autoUpdate && autoAbort) autoAbort.abort(); // 中断进行中的自动下载
  setAutoPhase('idle');
  if (c.autoUpdate) {
    // 用户重新打开开关 = 明确表示再试一次：清掉失败暂停记录并立即检查
    clearAutoUpdateFailure();
    autoBackoffIndex = 0;
    scheduleAutoUpdateCheck(1000); // 开启后立即触发一次检查
  }
  return { ...autoState };
});

// 设置页「重试自动更新」：清掉暂停记录并立即重新检查（开关关着时只清记录，不擅自打开开关）
ipcMain.handle('desktop-update-retry-auto', () => {
  clearAutoUpdateFailure();
  setAutoPhase('idle');
  if (readConfig().autoUpdate !== false) {
    autoBackoffIndex = 0;
    scheduleAutoUpdateCheck(1000);
  }
  return { ...autoState };
});

// ---------- 源码模式自更新（非打包形态：应用内增量拉源码并重建） ----------
// 源码模式跑在 git 检出目录上，更新 = git pull 增量拉取 → 同步依赖 → 重建 server/web →
// 组装 → 同步运行时依赖 → 重启。全程由主进程编排：弹置顶进度小窗，fork 各步骤（输出实时
// 回显小窗），构建期间应用照常可用，到组装前才停内嵌 server、主窗藏进托盘；完成后
// app.relaunch 重启，新实例接管。
// 依赖同步统一交给 desktop/scripts/sync-deps.js（与 scripts/update-from-source.ps1 同一实现）：
// 用依赖指纹判断是否真的需要 pnpm install，只在依赖变化时装，并补齐 desktop/server 运行时
// 依赖与 better-sqlite3 的 Electron ABI binding。仍不走 powershell（GUI 进程 spawn powershell
// 行为不可控：句柄为 null 静默秒退、管道场景构建拖慢几十倍，均实测），但 pnpm 本身是 Node CLI，
// 可以用 Electron 自带的 node 模式直接 fork，不需要任何 shell。
// 例外：本次更新要换 Electron 运行时时改走「交接」路径（见 runtimeSwapPending）——换运行时
// 必须先退出应用，否则 pnpm 删旧版 store 目录只能删一半，留下残骸把后续启动打挂。
const appRootDir = path.join(__dirname, '..');
const syncDepsEntry = () => path.join(appRootDir, 'desktop', 'scripts', 'sync-deps.js');
/** 更新进行中标志：防止重复点击触发两次 pull/构建 */
let sourceUpdating = false;

/**
 * 预构建环境包安装（安装器 bundle 模式）：安装目录里没有 .git、也不带 Git，
 * 应用内「检查更新 / 更新并重启」根本无法工作，更新方式是重跑新版安装器覆盖安装。
 * 标记由 pack-prebuilt-bundle.ps1 打进包里、install-engram.ps1 覆盖安装时也会写一份
 * （见 desktop/scripts/lib/runtime-mode.js 的 readPrebuiltManifest）。
 * 缓存一次：安装形态在一次进程生命周期内不会变。
 */
let prebuiltManifestCache;
function prebuiltInstall() {
  if (prebuiltManifestCache === undefined) {
    prebuiltManifestCache = runtimeMode.readPrebuiltManifest(appRootDir);
  }
  return prebuiltManifestCache;
}

/** 预构建安装的更新说明：设置页直接展示，避免用户对着一句 spawn git ENOENT 无从下手 */
const PREBUILT_UPDATE_HINT =
  '当前为预构建安装（安装包不含 Git 与 .git）：应用内更新不可用，请用新版安装器覆盖安装（数据保留），或改用打包版 exe。';

/**
 * 应用内源码更新不可用的原因（空串 = 可用）。两类安装注定无法 git 更新：
 *  - 预构建环境包安装：安装器删掉了 .git、也不装 Git（见 installer/resources/prebuilt/README.md）；
 *  - 非 git 检出（只拷了 main/ 或手工删了 .git）：本机可能装了 Git，但没有仓库可比对远端。
 * 这类安装不该按「失败」反复重试，而应明确告诉用户更新方式。
 */
function sourceUpdateUnavailableReason() {
  if (prebuiltInstall()) return PREBUILT_UPDATE_HINT;
  if (!runtimeMode.isGitCheckout(appRootDir)) {
    return '当前安装不是 git 检出（缺少 .git）：应用内源码更新不可用，请用安装器覆盖安装，或重跑安装器修复安装。';
  }
  return '';
}

/**
 * 本次更新是否需要更换正在运行的 Electron 运行时。换版本时 pnpm 会剪枝掉旧版的 store 目录，
 * 而 Windows 不允许删应用正在使用的 electron.exe 与被映射的 dll，只能删一半（package.json 没了、
 * 只剩 dist），残骸不是可加载的应用 —— 之后任何解析到该目录的启动方式都会弹
 * 「Unable to find Electron app」并退出（2026-09-17 客户实例实测）。判定见 lib/deps.js。
 */
function runtimeSwapPending() {
  return depsLib.electronRuntimeSwapPending(appRootDir);
}

/**
 * 把更新交接给 source-root 里的更新脚本：fork 一个中转进程（app.exit 后仍存活），由它新开控制台
 * 窗口跑 scripts/update-from-source.ps1（同步依赖 → 构建 → 启动），本进程随即退出把文件让出来。
 * 与卸载走 uninstall-launcher 同理：GUI 进程直接 spawn powershell 会空句柄秒退，必须经 Node 中转。
 */
function handOffSourceUpdate() {
  return new Promise((resolve) => {
    const root = sourceInstallRoot();
    if (!root) return resolve(false);
    const child = fork(path.join(__dirname, 'scripts', 'update-handoff-launcher.js'), ['--root', root], {
      detached: true,
      stdio: 'ignore',
    });
    // 等中转进程自己退出：它退出码为 0 才算更新脚本已交出去（非零=脚本缺失/起不来，不能关应用）
    child.once('exit', (code) => resolve(code === 0));
    child.once('error', () => resolve(false));
    setTimeout(() => resolve(false), 8000);
  });
}

function gitArgs(args) {
  // 每次解析（而非模块加载时定死）：全新机先装应用、后补 Git 的场景也能自愈；
  // 便携 MinGit 不在系统 PATH 里，必须显式定位（见 lib/runtime-mode.js）。
  return { cmd: runtimeMode.resolveGitCommand(), args: ['-C', appRootDir, ...args] };
}

/**
 * git 进程起不来时的中文说明。Windows 上没有 Git 时 spawn 只回 ENOENT，日志与界面上就是
 * 一句「spawn git ENOENT」——用户既看不出这代表「本机没有 Git」，也不知道该做什么
 * （2026-11-06 客户端实例：预构建安装连 .git 都没有，永远报这一句）。
 */
function explainGitSpawnError(error) {
  if (!error || error.code !== 'ENOENT') return error;
  let searched = [];
  try {
    searched = runtimeMode.resolveGit(process.env, fs.existsSync).searched || [];
  } catch {
    /* 诊断信息取不到不影响主错误 */
  }
  const hint = searched.length ? `（已查找：${searched.slice(0, 4).join('；')}）` : '';
  return new Error(
    `未找到 Git：源码模式更新需要 Git${hint}。请重跑安装器修复环境；如果没有 Git，也可安装 Git for Windows 后重启应用。`,
  );
}

function runGit(args, timeoutMs = 120_000) {
  const { cmd, args: full } = gitArgs(args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(explainGitSpawnError(e));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args[0]} 失败(code ${code})：${err.trim().split('\n')[0] || out.trim()}`));
    });
  });
}

// 构建身份：版本号只在发版时 bump，源码模式日常 pull 重建后版本号不变，光看版本号
// 判断不出更新是否落地。这里读 git 短提交号 + 提交日期 + 工作区是否脏，供设置页显示
// （对齐 DSH 侧栏「本地构建」徽标与 hermes-agent `hermes_cli/build_info.py`）。
// 进程内缓存：代码身份在进程运行期间不会变，更新后需重启才生效——这正是判断一次更新
// 是否真的落地的依据，也避免设置页每次打开都多跑两条 git（并行 spawn，见下方实现）。
let gitIdentityCache = null;

async function gitIdentity() {
  if (gitIdentityCache) return gitIdentityCache;
  const unknown = { commit: '', commitDate: '', dirty: false };
  if (PACKAGED) {
    gitIdentityCache = unknown; // 安装包形态没有 .git，显示退回纯版本号
    return gitIdentityCache;
  }
  // 预构建安装没有 .git（安装器故意删掉）也不带 Git：提交身份取自包清单 .engram-prebuilt.json，
  // 版本行仍能显示「装的是哪次打包」，而不是一句「未读到提交号（Git 不可用）」。
  const prebuilt = prebuiltInstall();
  if (prebuilt) {
    gitIdentityCache = {
      commit: (prebuilt.commit || '').slice(0, 7),
      commitDate: (prebuilt.builtAt || '').slice(0, 10),
      dirty: false,
      prebuilt: true,
    };
    log(
      '[identity] 预构建安装（' +
        (prebuilt.bundle || '.engram-prebuilt.json') +
        '）：不使用 git，更新请重跑新版安装器',
    );
    return gitIdentityCache;
  }
  try {
    // 冷盘上每启动一条 git 进程就要几百 ms，旧实现三条串行（rev-parse/log/status）会直接推迟
    // 下面 fork server 的时刻——它发生在启动页只显示「环境准备中」的时候，用户能感知到。
    // 这里合并成两条并并行跑：`git log` 一次给出短提交号（-c core.abbrev=7 等价于原 --short=7）
    // 与提交日期，`git status` 单独给脏标记；返回结构与失败降级语义与旧实现一致。
    const [logOut, statusOut] = await Promise.all([
      runGit(['-c', 'core.abbrev=7', 'log', '-1', '--format=%h%n%cs'], 15_000),
      runGit(['status', '--porcelain'], 15_000),
    ]);
    const [commit = '', commitDate = ''] = logOut.split(/\r?\n/);
    gitIdentityCache = { commit: commit.trim(), commitDate: commitDate.trim(), dirty: Boolean(statusOut.trim()) };
  } catch (e) {
    // git 不可用（未装 git / 非检出目录）不阻断应用：退回纯版本号显示。
    // 但必须留痕——2026-09-22 用户报「版本号只显示 1.2.7」时 app.log 里什么都没有，
    // 只能靠猜（真实原因之一：品牌启动器被判成安装包形态；之二：便携 MinGit 不在 PATH）。
    log('[identity] 读取 git 身份失败，版本行将只显示版本号：' + describeError(e));
    gitIdentityCache = unknown;
  }
  return gitIdentityCache;
}

ipcMain.handle('desktop-get-env', async () => ({
  packaged: PACKAGED,
  // 预构建环境包安装（无 .git / 无 Git）：Web 侧据此隐藏 git 更新入口并显示「用安装器更新」说明
  prebuilt: Boolean(prebuiltInstall()),
  platform: process.platform,
  version: app.getVersion(),
  ...(PACKAGED ? {} : await gitIdentity()),
}));

// 源码模式自动检查：启动 4 秒首查 + 自适应退避复查（节奏见 updateCadence）。检查本身走两级探测：
// 先用一次 ls-remote 问远端分支 SHA，只有它和本地 origin/<branch> 不一致才真的 fetch 增量对象
// （见 sourceCheckCore）。落后时只提示（标题栏绿色更新图标 + 设置页状态），不弹系统通知、不自动弹面板，
// 一键「立即更新并重启」由用户扫到图标后点面板主按钮触发——源码模式重建会重启应用，不自动执行。
const sourceAutoState = {
  enabled: true,
  phase: 'idle', // idle | checking | up-to-date | behind | failed
  behind: 0,
  localCommit: '',
  remoteCommit: '',
  changes: [],
  error: '',
  checkedAt: null,
};
let sourceAutoBusy = false;

let sourceTimer = null;
let sourceBackoffIndex = 0;

function scheduleSourceCheck(delayMs) {
  if (sourceTimer) clearTimeout(sourceTimer);
  sourceTimer = setTimeout(() => {
    sourceTimer = null;
    void sourceAutoTick();
  }, delayMs);
}

/** 一轮结束后排下一轮：这轮发现落后 → 保持最短间隔（用户可能正在等这次更新），否则逐级拉长 */
function scheduleNextSourceCheck(hasUpdate) {
  if (PACKAGED || sourceUpdateUnavailableReason() || process.platform !== 'win32') return;
  if (readConfig().autoUpdate === false) return;
  sourceBackoffIndex = updateCadence.nextBackoffIndex(sourceBackoffIndex, hasUpdate);
  scheduleSourceCheck(updateCadence.backoffDelay(sourceBackoffIndex));
}

function setSourceAutoState(patch) {
  Object.assign(sourceAutoState, patch);
  broadcast('desktop-source-state', { ...sourceAutoState });
}

/** 比对远端与本地（手动「检查更新」与自动检查共用）。两级探测，日常只花一次网络往返：
 *  1) ls-remote 问远端分支 SHA（轻量，同时验证网络与凭据是否还通）；
 *  2) 只有它和本地 origin/<branch> 不一致才 fetch 增量对象；behind / 提交列表全在本地算。 */
async function sourceCheckCore() {
  if (PACKAGED) return { ok: false, error: '安装包形态不使用源码更新' };
  const unavailable = sourceUpdateUnavailableReason();
  if (unavailable) return { ok: false, prebuilt: Boolean(prebuiltInstall()), error: unavailable };
  try {
    // branch --show-current 而非 rev-parse --abbrev-ref：仓库里有与分支同名的 tag（如游离 tag main）时
    // abbrev-ref 会消歧成 heads/main，拼 origin/heads/main 直接报 128
    const branch = await runGit(['branch', '--show-current']);
    if (!branch) return { ok: false, error: '当前不在任何分支上（游离 HEAD），无法比对远端' };
    const lsRemote = await runGit(['ls-remote', 'origin', `refs/heads/${branch}`], 20_000);
    const remoteSha = ((lsRemote.split(/\r?\n/)[0] || '').trim().split(/\s+/)[0] || '');
    if (!remoteSha) return { ok: false, error: `远端没有分支 ${branch}` };
    let localRemoteSha = '';
    try {
      localRemoteSha = await runGit(['rev-parse', `refs/remotes/origin/${branch}`]);
    } catch {
      /* 本地还没有该远端跟踪引用（新克隆/新分支）：下面照常 fetch */
    }
    // 远端真的动了才 fetch：绝大多数轮次到此为止，只有一次 ls-remote 的网络开销
    const fetched = localRemoteSha !== remoteSha;
    if (fetched) await runGit(['fetch', 'origin', '--prune']);
    const behind = Number((await runGit(['rev-list', '--count', `HEAD..origin/${branch}`])) || 0);
    // 本地/远端提交号：让「已是最新」有可核对的依据（版本号日常不变，只有提交号会变）
    const local = await gitIdentity();
    let remoteCommit = remoteSha.slice(0, 7);
    let remoteDate = '';
    let changes = [];
    try {
      remoteCommit = await runGit(['rev-parse', '--short=7', `origin/${branch}`], 15_000);
      remoteDate = await runGit(['log', '-1', '--format=%cs', `origin/${branch}`], 15_000);
      if (behind > 0) {
        changes = (await runGit(['log', '-5', '--format=%s', `HEAD..origin/${branch}`], 15_000))
          .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }
    } catch {
      /* 远端分支刚建或无引用时留空，前端退回分支文案 */
    }
    return {
      ok: true,
      branch,
      behind,
      upToDate: behind === 0,
      localCommit: local.commit,
      localDate: local.commitDate,
      dirty: local.dirty,
      remoteCommit,
      remoteDate,
      changes,
      fetched, // 这一轮是否真的做过 fetch（否则只花了一次 ls-remote）
    };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

/** 把一次检查结果同步进自动检查状态（手动检查也走这里，设置页文案与自动检查一致） */
function applySourceCheckResult(r) {
  if (!r || !r.ok) {
    setSourceAutoState({ phase: 'failed', error: (r && r.error) || '检查失败', checkedAt: Date.now() });
    return;
  }
  setSourceAutoState({
    phase: r.upToDate ? 'up-to-date' : 'behind',
    behind: r.behind,
    localCommit: r.localCommit,
    remoteCommit: r.remoteCommit,
    changes: r.changes,
    error: '',
    checkedAt: Date.now(),
  });
}

async function sourceAutoTick() {
  if (PACKAGED) return;
  const unavailable = sourceUpdateUnavailableReason();
  if (unavailable) {
    // 没有 git / 不是检出：检查永远不可能成功，只标状态、不再排下一轮
    setSourceAutoState({ phase: 'unsupported', enabled: false, error: unavailable, checkedAt: null });
    return;
  }
  if (PACKAGED || sourceAutoBusy || sourceUpdating) {
    // 检查/更新正忙：一分钟后重试，别把自动检查这条线彻底停掉
    if (!PACKAGED && process.platform === 'win32') scheduleSourceCheck(updateCadence.BACKOFF_MS[0]);
    return;
  }
  sourceAutoState.enabled = readConfig().autoUpdate !== false;
  if (!sourceAutoState.enabled) {
    setSourceAutoState({ phase: 'idle', error: '' });
    return;
  }
  sourceAutoBusy = true;
  setSourceAutoState({ phase: 'checking', error: '' });
  let hasUpdate = false;
  try {
    const r = await sourceCheckCore();
    applySourceCheckResult(r);
    hasUpdate = Boolean(r.ok && !r.upToDate);
  } finally {
    sourceAutoBusy = false;
    scheduleNextSourceCheck(hasUpdate);
  }
}

ipcMain.handle('desktop-source-update-check', async () => {
  const r = await sourceCheckCore();
  applySourceCheckResult(r);
  return r;
});

ipcMain.handle('desktop-source-auto-state', () => ({ ...sourceAutoState }));

ipcMain.handle('desktop-source-set-auto', (_e, enabled) => {
  const unavailable = sourceUpdateUnavailableReason();
  if (unavailable) {
    // 预构建安装 / 非检出没有自动检查可言：保持「不支持」状态，也别把开关写进配置
    setSourceAutoState({ phase: 'unsupported', enabled: false, error: unavailable });
    return { ...sourceAutoState };
  }
  const c = readConfig();
  c.autoUpdate = Boolean(enabled);
  writeConfig(c);
  sourceAutoState.enabled = c.autoUpdate;
  setSourceAutoState({ phase: 'idle', error: '' });
  if (c.autoUpdate) {
    sourceBackoffIndex = 0;
    scheduleSourceCheck(1000); // 开启后立即触发一次检查
  }
  return { ...sourceAutoState };
});

// 进度小窗：更新期间唯一的可见窗口（主窗藏进托盘）。复用启动页深色主题，
// 主进程经 executeJavaScript 原地更新步骤文字与日志，不开 nodeIntegration、无 IPC 桥。
function updateProgressPage() {
  const extra = `
    body { align-items: flex-start; padding-top: 40px; }
    .wrap { width: min(500px, 82vw); }
    .logo { width: 54px; height: 54px; margin-bottom: 16px; }
    h1 { font-size: 20px; letter-spacing: 1px; margin: 0 0 8px; }
    .step { font-size: 14px; color: #c6cddc; margin: 0 0 18px; min-height: 20px; text-align: left; }
    .bar { margin-bottom: 14px; }
    #log {
      margin: 0; height: 116px; overflow: hidden; font-size: 11px; line-height: 1.55;
      color: #566078; font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-all;
    }
    .failed .bar i { animation: none; background: #f87171; }
    .failed .step { color: #f87171; }
  `;
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' +
    SPLASH_STYLE +
    extra +
    '</style></head><body><div class="wrap">' +
    logoSvg('logo') +
    '<h1>正在更新 Engram</h1>' +
    '<p class="step" id="step">准备中…</p>' +
    '<div class="bar"><i></i></div>' +
    '<pre id="log"></pre>' +
    '</div></body></html>'
  );
}

let updateWin = null;

function showUpdateProgress() {
  if (updateWin && !updateWin.isDestroyed()) return updateWin;
  updateWin = new BrowserWindow({
    width: 560,
    height: 430,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    title: 'Engram 更新',
    backgroundColor: SPLASH_BG,
    icon: windowIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  updateWin.setAlwaysOnTop(true, 'screen-saver');
  updateWin.once('ready-to-show', () => updateWin.show());
  updateWin.loadURL(dataUrl(updateProgressPage()));
  return updateWin;
}

function updateProgressExec(script) {
  if (!updateWin || updateWin.isDestroyed()) return;
  updateWin.webContents.executeJavaScript(script).catch(() => { /* 页面已切走或窗口已关 */ });
}

function setUpdateStep(text) {
  // IIFE 包裹：executeJavaScript 与页面共享全局作用域，裸 const 二次执行会重复声明报错
  updateProgressExec(`(function(){const el=document.getElementById('step'); if (el) el.textContent=${JSON.stringify(text)};})()`);
}

function appendUpdateLog(line) {
  updateProgressExec(
    '(function(){const el=document.getElementById("log");if(!el)return;' +
      `el.textContent=(el.textContent?el.textContent+"\\n":"")+${JSON.stringify(line)};` +
      'const ls=el.textContent.split("\\n");if(ls.length>120)el.textContent=ls.slice(-120).join("\\n");' +
      'el.scrollTop=el.scrollHeight;})()',
  );
}

function failUpdateProgress(message) {
  updateProgressExec(
    `document.body.classList.add('failed');` +
      `const el=document.getElementById('step'); if (el) el.textContent=${JSON.stringify(message)};`,
  );
}

// fork 一个 Node 侧构建子进程（tsc/vite/prepare-desktop），输出按行实时回显到进度小窗。
// 全程同为 Node 生态：stdio 管道行为正常，与被 GUI 进程 spawn 的 powershell（静默秒退、
// 管道场景把构建拖慢几十倍，均实测）不同。
// 超时兜底：pnpm/tsc 卡住（锁文件、被杀软拦）时进度窗会永远停在当前步骤，且 sourceUpdating
// 会让后续更新全被拒——超时后连孙进程一起杀（pnpm 会 fork 出 node/tar，只杀直接子进程留不住）。
function forkStep(entry, args, cwd, onLine, timeoutMs = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = fork(entry, args, { cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const tail = [];
    let settled = false;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        } catch {
          /* taskkill 不可用时退回 kill */
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish(reject)(new Error(`${path.basename(entry)} 超过 ${Math.round(timeoutMs / 60000)} 分钟未结束，已中止`));
    }, timeoutMs);
    const collect = (d) => {
      for (const line of d.toString().replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
        onLine(line);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', finish(reject));
    child.on('exit', finish((code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(entry)} 退出码 ${code}：${tail.slice(-4).join(' | ')}`));
    }));
  });
}

// 构建工具入口按候选路径探测：pnpm 布局下 typescript/vite 位于各自包的 node_modules，
// 其他布局（hoisted）兜底到工作区根
function resolveToolEntry(relCandidates) {
  for (const rel of relCandidates) {
    const p = path.join(appRootDir, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`未找到构建工具：${relCandidates[0]}`);
}

ipcMain.handle('desktop-source-update', async () => {
  if (PACKAGED) return { ok: false, error: '安装包形态不使用源码更新' };
  const unavailable = sourceUpdateUnavailableReason();
  if (unavailable) return { ok: false, prebuilt: Boolean(prebuiltInstall()), error: unavailable };
  if (sourceUpdating) return { ok: false, error: '更新已在进行中，请等待当前更新完成' };
  sourceUpdating = true;
  try {
    return await runSourceUpdate();
  } finally {
    // 成功路径已 app.exit 重启；这里兜住失败/中断，避免卡住后续更新
    sourceUpdating = false;
  }
});

async function runSourceUpdate() {
  showUpdateProgress();
  setUpdateStep('正在拉取最新代码（git pull）…');
  try {
    const branch = await runGit(['branch', '--show-current']);
    // refspec 必须全限定到 refs/heads/：仓库远端存在与分支同名的 tag（main）时，
    // 裸分支名会被解析成 tag —— pull 等于拿 tag 合并当前 HEAD，静默假成功且版本不变
    await runGit(['pull', '--ff-only', 'origin', `refs/heads/${branch}`], 180_000);
  } catch (e) {
    // 拉取失败：小窗没有可展示的过程，关掉回主窗，由设置页展示错误
    if (updateWin && !updateWin.isDestroyed()) updateWin.close();
    updateWin = null;
    showMainWindow();
    return { ok: false, error: describeError(e) + '（本地有未提交改动时请先提交/暂存）' };
  }
  // 换 Electron 运行时不能在应用运行时做：交接给更新脚本，退出后由它同步依赖、构建并启动
  if (runtimeSwapPending()) {
    const scriptRel = path.join('main', 'scripts', 'update-from-source.ps1');
    setUpdateStep('本次更新包含 Electron 运行时升级，正在交接给更新脚本…');
    appendUpdateLog('> 运行时升级要先退出应用：将打开「Engram 更新」窗口完成，完成后自动启动');
    if (!(await handOffSourceUpdate())) {
      failUpdateProgress('无法启动更新脚本，请手动运行 ' + scriptRel);
      showMainWindow();
      return { ok: false, error: `运行时升级需要退出应用后完成：请手动运行 ${scriptRel}` };
    }
    await new Promise((r) => setTimeout(r, 2500)); // 让进度小窗把提示显示完整
    await stopLocalChild(); // 优雅停内嵌 server（数据库落盘），其余进程由更新脚本清理
    app.exit(0);
    return { ok: true, restarting: true };
  }
  try {
    // 依赖同步交给 sync-deps.js：按依赖指纹判断，真变了才 pnpm install（联网），
    // appId 之类元信息改动不再误报，也不再需要用户去终端跑脚本
    setUpdateStep('同步依赖（依赖变化时 pnpm install）…');
    await forkStep(syncDepsEntry(), ['workspace', '--app-root', appRootDir], appRootDir, appendUpdateLog, 20 * 60_000);
    setUpdateStep('构建 server（tsc）…');
    await forkStep(resolveToolEntry([
      path.join('server', 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join('node_modules', 'typescript', 'bin', 'tsc'),
      // 构建走 tsconfig.build.json：排除 src/**/*.test.ts，测试文件不进入 dist
      // （发布产物不携带测试与其中的内网地址 fixture；typecheck 仍用 tsconfig.json 覆盖测试）
    ]), ['-p', 'tsconfig.build.json'], path.join(appRootDir, 'server'), appendUpdateLog);
    setUpdateStep('构建 web（vite）…');
    await forkStep(resolveToolEntry([
      path.join('web', 'node_modules', 'vite', 'bin', 'vite.js'),
      path.join('node_modules', 'vite', 'bin', 'vite.js'),
    ]), ['build'], path.join(appRootDir, 'web'), appendUpdateLog);
  } catch (e) {
    const msg = describeError(e);
    failUpdateProgress('更新失败：' + msg);
    appendUpdateLog('> 可再次点击「更新并重启」重试；仍失败时在终端运行 scripts\\update-from-source.ps1');
    showMainWindow();
    return { ok: false, error: msg };
  }
  // 组装会覆盖正在运行的 desktop/server 产物副本，先停内嵌 server、主窗藏进托盘
  setUpdateStep('组装桌面运行目录…');
  await stopLocalChild();
  if (win && !win.isDestroyed()) {
    ensureTray();
    win.hide();
  }
  try {
    await forkStep(path.join(appRootDir, 'desktop', 'scripts', 'prepare-desktop.js'),
      [], appRootDir, appendUpdateLog);
    // 组装后 desktop/server/package.json 才是最新的，再同步运行时依赖与原生 binding
    setUpdateStep('同步桌面运行依赖（desktop/server）…');
    await forkStep(syncDepsEntry(), ['server', '--app-root', appRootDir], appRootDir, appendUpdateLog, 20 * 60_000);
  } catch (e) {
    const msg = describeError(e);
    failUpdateProgress('更新失败：' + msg);
    appendUpdateLog('> 可再次点击「更新并重启」重试；仍失败时在终端运行 scripts\\update-from-source.ps1');
    showMainWindow();
    return { ok: false, error: msg };
  }
  setUpdateStep('完成，正在启动新版本…');
  appendUpdateLog('> 更新完成');
  app.relaunch({ args: process.argv.slice(1) });
  app.exit(0);
  return { ok: true, restarting: true };
}

// ---------- 源码模式卸载：设置页「卸载」→ uninstall-engram.ps1 → 应用退出 ----------
// 仅源码安装形态可用：进程可执行文件位于源码版安装根（%LOCALAPPDATA%\engram）下；
// ENGRAM_INSTALL_DIR 供隔离测试/自定义安装位置显式指定。安装包形态走 NSIS 卸载器，不显示该功能。
function sourceInstallRoot() {
  if (process.env.ENGRAM_INSTALL_DIR) return process.env.ENGRAM_INSTALL_DIR;
  const local = process.env.LOCALAPPDATA || '';
  if (!local) return '';
  const root = path.join(local, 'engram');
  const prefix = root.toLowerCase() + path.sep;
  return process.execPath.toLowerCase().startsWith(prefix) ? root : '';
}

// 交接等待上限：launcher 起来、校验脚本、拉起 PowerShell 正常在 1 秒内完成；8 秒还没见到
// 「running」说明它自己也起不来（被杀软拦、fork 失败等），此时不能再退出应用，要把原因回给界面。
const UNINSTALL_START_TIMEOUT_MS = 8000;

function uninstallLogFile() {
  return path.join(app.getPath('temp'), 'engram-uninstall.log');
}

/** 卸载是否正在进行：安装根里有「新鲜」的 .uninstalling 标记（启动守卫用，见 whenReady） */
function uninstallInProgress() {
  const root = sourceInstallRoot();
  if (!root) return false;
  const flag = uninstallGuard.readFlag(root);
  if (!flag) return false;
  if (!uninstallGuard.flagIsFresh(flag)) {
    uninstallGuard.removeFlag(root);
    log('[uninstall] 清理过期的卸载标记（上次卸载没有正常结束）：' + root);
    return false;
  }
  return true;
}

/**
 * 等 launcher 把「卸载脚本已拉起」写进状态文件。
 * 只有确认脚本真的跑起来了才让主进程退出；否则清标记、返回错误给设置页——
 * 旧实现不看结果一律 app.exit(0)，脚本起不来时就是「退出了但什么都没卸」（2026-11-06 用户报）。
 */
async function waitUninstallStarted(statusFile) {
  const deadline = Date.now() + UNINSTALL_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = uninstallGuard.readStatus(statusFile);
    if (s && s.phase === 'running') return { ok: true };
    if (s && s.phase === 'error') return { ok: false, error: '卸载进程启动失败：' + (s.error || '未知原因') };
    if (s && s.phase === 'done' && s.code !== 0) {
      return { ok: false, error: '卸载脚本立即退出（code=' + s.code + '），详见日志：' + uninstallLogFile() };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, error: '卸载进程 ' + Math.round(UNINSTALL_START_TIMEOUT_MS / 1000) + ' 秒内没有启动，详见日志：' + uninstallLogFile() };
}

ipcMain.handle('desktop-source-uninstall-state', () => ({ available: Boolean(sourceInstallRoot()) }));

ipcMain.handle('desktop-source-uninstall', async (_e, deleteData) => {
  const root = sourceInstallRoot();
  if (!root) return { ok: false, error: '未识别出源码版安装目录；安装包形态请在系统「添加或删除程序」中卸载' };
  const script = path.join(root, 'Engram', 'main', 'scripts', 'uninstall-engram.ps1');
  if (!fs.existsSync(script)) return { ok: false, error: '未找到卸载脚本：' + script };
  // 先写卸载标记：期间用户再点图标会被启动守卫挡下，避免新实例锁住正在被删的安装目录。
  uninstallGuard.writeFlag(root, { deleteData: Boolean(deleteData) });
  const statusFile = uninstallGuard.statusPath(app.getPath('temp'));
  uninstallGuard.writeStatus(statusFile, { phase: 'launching' });
  // 先优雅停掉内嵌 server（数据库落盘），再拉起独立卸载进程。
  // 不能直接 spawn powershell：GUI 进程 spawn 的 powershell 会空句柄静默秒退（实测），
  // 必须经 fork 出的 Node 中转（uninstall-launcher.js），fork 的子进程在 app.exit 后存活。
  await stopLocalChild();
  const child = fork(
    path.join(__dirname, 'scripts', 'uninstall-launcher.js'),
    ['--root', root, ...(deleteData ? ['--delete-data'] : []), '--status', statusFile],
    { detached: true, stdio: 'ignore' },
  );
  // 没有 error 监听时 spawn 失败会变成 uncaughtException 带走主进程；失败原因由状态文件给出
  child.on('error', () => {});
  const started = await waitUninstallStarted(statusFile);
  if (!started.ok) {
    uninstallGuard.removeFlag(root);
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    log('[uninstall] 卸载未能启动：' + started.error);
    return { ok: false, error: started.error };
  }
  log('[uninstall] 卸载脚本已拉起，应用退出；进度日志：' + uninstallLogFile());
  app.exit(0);
  return { ok: true };
});

// ---------- 桌面快捷方式：设置页「重建桌面快捷方式」 ----------
// 桌面图标丢失、或安装目录里的启动 exe 显示 Electron 原子图标时用这里重建：
// 源码模式先生成/刷新品牌化 Engram.exe（与 electron.exe 同目录，图标 = build/icon.ico），
// 再把桌面快捷方式指向它；开始菜单里属于本安装的 Engram.lnk 一并同步。
// 全程走 Electron 自带 API（shell.readShortcutLink / writeShortcutLink），不 spawn powershell：
// GUI 进程 spawn 的 powershell 会空句柄静默秒退（实测），而 rcedit 是普通 exe，管道 stdio 可直接 spawn。
function startMenuShortcutPath() {
  return shortcutLib.shortcutPath(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
}

/** 开始菜单里的 Engram.lnk 是否属于本安装（指向本安装的 electron.exe/Engram.exe 才动它，不碰安装包形态的项） */
function startMenuShortcutOwned(lnkPath, desktopDir) {
  try {
    const target = String(shell.readShortcutLink(lnkPath)?.target || '').toLowerCase();
    if (!target) return false;
    if (target === process.execPath.toLowerCase()) return true;
    return target.startsWith(desktopDir.toLowerCase() + path.sep);
  } catch {
    return false;
  }
}

async function rebuildDesktopShortcut() {
  if (process.platform !== 'win32') return { ok: false, error: '桌面快捷方式仅 Windows 支持' };
  const desktopDir = path.join(appRootDir, 'desktop');
  const iconPath = path.join(desktopDir, shortcutLib.ICON_REL);
  let distDir = '';
  let exe = 'packaged';
  let exeWarning = '';
  if (!PACKAGED) {
    distDir = shortcutLib.findElectronDist(desktopDir);
    if (!distDir) return { ok: false, error: '未找到 Electron 运行时（node_modules/electron/dist 缺失），请先同步依赖' };
    const r = await shortcutLib.brandExe({ distDir, iconPath, rcedit: shortcutLib.findRcedit(appRootDir) });
    exe = r.status;
    exeWarning = r.error || '';
    // 运行中的 Engram.exe 被 Windows 锁住：覆盖不了就别写半成品，让用户退出后重试（更新脚本会自动完成）
    if (exe === 'locked') return { ok: false, error: r.error };
  }
  const useBranded = !PACKAGED && (exe === 'built' || exe === 'fresh');
  const spec = shortcutLib.shortcutSpec({
    packaged: PACKAGED,
    desktopDir,
    execPath: process.execPath,
    distDir,
    useBranded,
  });
  spec.icon = shortcutIconPath();
  const lnk = shortcutLib.shortcutPath(app.getPath('desktop'));
  let created = false;
  try {
    // 已有快捷方式走 update（保留系统附加属性），没有才 create
    created = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', spec);
  } catch (e) {
    return { ok: false, error: `写入桌面快捷方式失败：${describeError(e)}` };
  }
  if (!created) return { ok: false, error: `写入桌面快捷方式失败：${lnk}` };

  let startMenu = 'absent';
  const smLnk = startMenuShortcutPath();
  if (fs.existsSync(smLnk)) {
    if (!startMenuShortcutOwned(smLnk, desktopDir)) {
      startMenu = 'skipped';
    } else {
      try {
        shell.writeShortcutLink(smLnk, 'update', spec);
        startMenu = 'updated';
      } catch {
        startMenu = 'failed';
      }
    }
  }
  const result = { ok: true, shortcut: lnk, target: spec.target, exe, exeWarning, startMenu };
  result.message = shortcutLib.describeShortcutResult(result);
  log(`[shortcut] 桌面快捷方式已重建：${lnk} → ${spec.target}（exe=${exe}，开始菜单=${startMenu}）`);
  return result;
}

ipcMain.handle('desktop-rebuild-shortcut', () => rebuildDesktopShortcut());
