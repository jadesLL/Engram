// Engram 桌面端主进程（Electron）
// 双模式：
//  - 本地：fork 内嵌 server 子进程（ELECTRON_RUN_AS_NODE 纯 Node 模式）+ 探活后加载
//  - 远端：凭 desktop token 调 /api/auth/desktop-exchange 兑换 JWT，预置 cookie 后加载远端页面
// 启动页 index.html 供用户选择模式或切换连接。
const { app, BrowserWindow, ipcMain, shell, session, Menu, Tray, nativeImage, Notification, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { spawn } = require('node:child_process');
const net = require('node:net');

// 隔离/自定义数据目录：自动化测试与便携场景用；必须在单实例锁之前生效（锁文件位于 userData 内）
if (process.env.ENGRAM_USER_DATA) app.setPath('userData', path.resolve(process.env.ENGRAM_USER_DATA));

// 单实例锁：点 X 后应用驻留托盘，此时再次启动若开新实例，其 fork 的后端会撞 18180 端口、
// 探活又探测到旧实例的服务，出现双窗口共用单后端的混乱。故第二实例直接退出并唤起已有窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

// 产品更名（LLM Wiki → Engram）后 productName 变化会让 Electron 默认 userData 目录
// （%APPDATA%/<productName>）跟着变。旧目录里有本地模式全部数据与连接配置，
// 这里一次性迁移到新目录，之后不再回看旧路径。
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'LLM Wiki');
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
const HEALTH_TIMEOUT_MS = 30000;

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

// 模式切换会重置连接信息；自动更新开关是用户偏好，跨模式保留
function writeConnectionConfig(cfg) {
  writeConfig({ autoUpdate: readConfig().autoUpdate, ...cfg });
}

// 数据保存位置（类 Obsidian 仓库位置）：首次启动用默认位置，设置页可改到任意目录。
// 改目录自动迁移旧数据并重启内嵌 server（见 choose-data-dir IPC）。
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

function dataUrl(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

let win = null;
let serverChild = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

// 外部链接收口：window.open / target=_blank 的子窗口会继承 preload（window.wikiDesktop），
// 等于把含远端令牌的桥暴露给任意外部站点；页面内导航同理只允许应用自身来源。
// http(s) 链接一律交给系统浏览器打开，其余协议直接拒绝。
function isInternalNavUrl(target) {
  try {
    const u = new URL(target);
    if (u.protocol === 'data:' || u.protocol === 'file:') return true;
    const cur = win ? new URL(win.webContents.getURL()) : null;
    return Boolean(cur && cur.origin && cur.origin !== 'null' && cur.origin === u.origin);
  } catch {
    return false;
  }
}

function openExternally(url) {
  if (/^https?:/i.test(url)) void shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    title: 'Engram',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
  return win;
}

// ---------- 托盘 ----------
function trayIcon() {
  const packed = path.join(__dirname, 'icon.png'); // 打包后：pack-asar.js 把 build/icon.png 复制进 asar
  const dev = path.join(__dirname, 'build', 'icon.png'); // 源码运行（electron .）
  return nativeImage.createFromPath(fs.existsSync(packed) ? packed : dev);
}

function ensureTray() {
  if (tray) return;
  const icon = trayIcon();
  if (icon.isEmpty()) log('警告：托盘图标为空（asar 内缺少 icon.png），托盘将显示空白槽位');
  tray = new Tray(icon);
  tray.setToolTip('Engram');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Engram', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出 Engram', click: () => app.quit() },
  ]));
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

function startLocalMode() {
  const entry = serverEntryPath();
  if (!fs.existsSync(entry)) {
    win.loadURL(dataUrl('<h2>本地后端缺失</h2><p>未找到内置服务：' + entry + '</p>'));
    return;
  }
  win.loadURL(dataUrl('<h2>正在启动本地服务…</h2>'));
  const port = getLocalPort();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    TZ: 'Asia/Shanghai',
    DATA_DIR: getDataDir(),
    PORT: String(port),
    HOST: '127.0.0.1',
    OFFICE_EDITOR_ENABLED: 'false',
    ENGRAM_WEB_DIST: webDistPath(),
    ENGRAM_APP_VERSION: app.getVersion(),
  };
  // 命门：必须 fork（默认 execPath=electron.exe）+ ELECTRON_RUN_AS_NODE，子进程才以 Electron 纯
  // Node 模式运行、能读 app.asar 内的 node_modules；改 spawn('node') 会让 server 读不了 asar。
  serverChild = fork(entry, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  serverChild.stdout.on('data', (d) => log('[server] ' + d.toString().trim()));
  serverChild.stderr.on('data', (d) => log('[server!] ' + d.toString().trim()));
  serverChild.on('exit', (code) => log(`[server] exited code=${code}`));

  const base = `http://127.0.0.1:${port}`;
  waitForHealth(base, HEALTH_TIMEOUT_MS).then((ok) => {
    if (ok) win.loadURL(base);
    else win.loadURL(dataUrl('<h2>本地服务启动失败</h2><p>详见日志：' + logFile() + '</p>'));
  });
}

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return true;
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stopLocalChild() {
  if (!serverChild) return;
  try {
    serverChild.kill('SIGTERM');
    const c = serverChild;
    setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 5000);
  } catch {
    /* 忽略 */
  }
  serverChild = null;
}

// ---------- 远端模式 ----------
// 直连优先择优：服务器 /health 可能通告直连地址（DIRECT_ACCESS_URL，如 IPv6 DDNS 域名）。
// 候选顺序：缓存的直连地址（手填/上次发现）→ 服务器通告 → 主地址；直连探测 1.5s 超时 +
// 状态码校验，首个可达者用于 token 兑换与加载。直连不可达自动落回主地址（隧道）。
const DIRECT_PROBE_TIMEOUT_MS = 1500;

function normalizeOrigin(raw) {
  let v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** 从服务器 /health 读取通告的直连地址；主地址走隧道时须带上会话 cookie 才能过 Cloudflare Access */
async function discoverDirectFromServer(origin) {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    const header = cookies
      .filter((c) => c.name === 'token' || c.name.startsWith('CF_Authorization'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const res = await fetch(origin + '/health', {
      headers: header ? { Cookie: header } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const h = await res.json().catch(() => null);
    return (h && h.direct && normalizeOrigin(h.direct)) || null;
  } catch {
    return null;
  }
}

async function probeOrigin(origin) {
  try {
    const res = await fetch(origin + '/health', { signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function pickRemoteOrigin(cfg) {
  const primary = normalizeOrigin(cfg.remoteUrl) || String(cfg.remoteUrl || '').replace(/\/+$/, '');
  const cached = normalizeOrigin(cfg.directUrl);
  const candidates = [];
  if (cached && cached !== primary) candidates.push(cached);
  const announced = await discoverDirectFromServer(primary);
  if (announced && announced !== primary && !candidates.includes(announced)) candidates.push(announced);
  for (const cand of candidates) {
    if (await probeOrigin(cand)) {
      if (cand !== cached) {
        const c = readConfig();
        c.directUrl = cand;
        writeConfig(c);
      }
      return cand;
    }
  }
  return primary;
}

async function startRemoteMode(remoteUrl, token) {
  win.loadURL(dataUrl('<h2>正在连接远端服务器…</h2>'));
  const actualOrigin = await pickRemoteOrigin(readConfig());
  try {
    const r = await fetch(actualOrigin + '/api/auth/desktop-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(t || `HTTP ${r.status}`);
    }
    const { jwt } = await r.json();
    await session.defaultSession.cookies.set({
      url: actualOrigin,
      name: 'token',
      value: jwt,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
    win.loadURL(actualOrigin);
  } catch (e) {
    win.loadURL(
      dataUrl(
        '<h2>无法连接远端服务器</h2><p>' +
          (e && e.message ? e.message : String(e)) +
          '</p><p>地址：' + actualOrigin + '</p>'
      )
    );
  }
}

// ---------- 启动调度 ----------
function launchByConfig() {
  createWindow();
  const cfg = readConfig();
  if (cfg.mode === 'local') {
    startLocalMode();
  } else if (cfg.mode === 'remote' && cfg.remoteUrl && cfg.remoteToken) {
    startRemoteMode(cfg.remoteUrl, cfg.remoteToken);
  } else {
    win.loadFile('index.html');
  }
}

/**
 * 应用菜单：进入本地模式后启动页被内嵌 Web 应用替换，且下次启动会直接跳过启动页，
 * 用户无处切换回远端。菜单「返回启动页 / 切换模式」是该场景下唯一稳定的切换入口
 * （快捷键 CmdOrCtrl+Shift+L），复用 open-connection-settings IPC 的逻辑。
 */
function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Engram',
      submenu: [
        {
          label: '返回启动页 / 切换模式',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            stopLocalChild();
            writeConnectionConfig({});
            if (win) win.loadFile('index.html');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
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
  // 常开渲染进程辅助功能：读屏器/自动化可直接访问页面 DOM 树（须在 ready 后调用）
  app.setAccessibilitySupportEnabled(true);
  Menu.setApplicationMenu(buildAppMenu());
  launchByConfig();
  // 自动更新：启动延迟首查 + 每 8 小时复查（仅 Windows 安装形态）
  if (process.platform === 'win32') {
    autoState.enabled = readConfig().autoUpdate !== false;
    setTimeout(autoUpdateTick, AUTO_UPDATE_STARTUP_DELAY_MS);
    setInterval(autoUpdateTick, AUTO_UPDATE_INTERVAL_MS);
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
  if (serverChild) {
    try {
      serverChild.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    serverChild = null;
  }
});

// ---------- IPC ----------
ipcMain.handle('get-connection', () => {
  const c = readConfig();
  return { mode: c.mode || '', remoteUrl: c.remoteUrl || '', remoteToken: c.remoteToken || '', directUrl: c.directUrl || '' };
});

ipcMain.handle('set-local-mode', () => {
  writeConnectionConfig({ mode: 'local' });
  stopLocalChild();
  startLocalMode();
  return true;
});

// 数据保存位置查询与更改（仅本地模式有意义；远端模式数据在服务端）
ipcMain.handle('get-data-dir', () => {
  const cfg = readConfig();
  return { dataDir: getDataDir(), isDefault: !cfg.dataDir };
});

// 恢复备份暂存后重启内嵌 server 使其生效（applyStagedRestore 在 server 启动早期执行）
ipcMain.handle('restart-server', () => {
  stopLocalChild();
  startLocalMode();
  return true;
});

ipcMain.handle('choose-data-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择数据保存位置',
    message: '选择 Engram 数据的保存目录（可选已有数据目录或空目录）',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const target = path.resolve(r.filePaths[0]);
  const current = getDataDir();
  if (target === current) return { dir: target, same: true };
  // 新位置在当前数据目录内部：迁移会把正在用的数据挪进自己，直接拒绝
  if (target.startsWith(current + path.sep)) {
    return { error: '新位置不能在当前数据目录内部' };
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    return { error: '该目录不可写，请换一个位置' };
  }
  const hadExisting = fs.existsSync(path.join(target, 'wiki.db')) || fs.existsSync(path.join(target, 'brain'));
  const result = { dir: target, copied: false, hadExisting };
  if (!hadExisting) {
    stopLocalChild(); // 迁移前先停 server，避免边写边拷
    const hasOldData = fs.existsSync(path.join(current, 'wiki.db')) || fs.existsSync(path.join(current, 'brain'));
    if (hasOldData) {
      try {
        fs.cpSync(current, target, { recursive: true });
        result.copied = true;
      } catch (e) {
        startLocalMode(); // 迁移失败：配置未变，用旧目录拉起，数据不受影响
        return { error: '迁移旧数据失败：' + e.message };
      }
    }
  } else {
    stopLocalChild();
  }
  writeConfig({ ...readConfig(), dataDir: target });
  startLocalMode(); // 健康检查通过后窗口自动加载新 server
  return result;
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
  stopLocalChild();
  startLocalMode(); // 健康检查通过后窗口自动加载新端口的 server
  return { port };
});

ipcMain.handle('set-remote-mode', (_e, url, token, directUrl) => {
  writeConnectionConfig({ mode: 'remote', remoteUrl: url, remoteToken: token, directUrl: normalizeOrigin(directUrl) });
  stopLocalChild();
  startRemoteMode(url, token);
  return true;
});

ipcMain.handle('open-connection-settings', () => {
  stopLocalChild();
  writeConnectionConfig({});
  win.loadFile('index.html');
  return true;
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

// ---------- 桌面端自更新（远端仓库 Releases 拉安装包） ----------
// 更新源配置按优先级解析：
//  1) 渲染进程传入——设置页「更新源配置」所见即所得（本地模式=本地 .env，远端模式=所连服务器配置）
//  2) 远端模式下主进程向所连服务器拉取（渲染进程为旧版前端、不传参时的兜底）
//  3) 本地 userData/data/.env（本地模式主路径，与内嵌 server 的 /api/update/config 读写同一文件）
const UPDATE_KEYS = {
  giteaUrl: 'UPDATE_GITEA_URL',
  giteaRepo: 'UPDATE_GITEA_REPO',
  giteaAuthType: 'UPDATE_GITEA_AUTH_TYPE',
  giteaToken: 'UPDATE_GITEA_TOKEN',
  giteaUsername: 'UPDATE_GITEA_USERNAME',
  giteaPassword: 'UPDATE_GITEA_PASSWORD',
};

function desktopUpdateEnvFile() {
  return path.join(app.getPath('userData'), 'data', '.env');
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

/** 远端模式下从所连服务器读取更新源配置；非远端模式或读取失败返回 null */
async function fetchRemoteUpdateEnv() {
  const c = readConfig();
  if (c.mode !== 'remote' || !c.remoteUrl) return null;
  const origin = String(c.remoteUrl).replace(/\/+$/, '');
  try {
    // 主进程 fetch 不带渲染进程会话的 cookie，须从会话取出 JWT 手动附上
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    const token = cookies.find((ck) => ck.name === 'token');
    const res = await fetch(origin + '/api/update/config', {
      headers: token ? { Cookie: `token=${token.value}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.giteaUrl || !data.giteaRepo) return null;
    return {
      giteaUrl: String(data.giteaUrl).replace(/\/+$/, ''),
      giteaRepo: String(data.giteaRepo),
      giteaAuthType: data.giteaAuthType === 'password' ? 'password' : 'token',
      giteaToken: String(data.giteaToken || ''),
      giteaUsername: String(data.giteaUsername || ''),
      giteaPassword: String(data.giteaPassword || ''),
    };
  } catch {
    return null;
  }
}

/** 解析本次更新检查/下载使用的配置（优先级见文件顶部注释） */
async function resolveUpdateCfg(passed) {
  if (passed && typeof passed === 'object' && passed.giteaUrl && passed.giteaRepo) {
    return passed;
  }
  const remote = await fetchRemoteUpdateEnv();
  if (remote) return remote;
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

// 下载安装包到 userData/downloads/；进度经 send 回调推送（手动=发起窗口，自动=广播所有窗口）
async function downloadUpdateFile(cfg, url, send, signal) {
  const target = String(url);
  // 只允许从配置的远端仓库下载（防注入任意 URL）
  if (!cfg || !cfg.giteaUrl || !target.startsWith(cfg.giteaUrl + '/')) {
    throw new Error('下载地址不在配置的远端仓库源内');
  }
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const name = decodeURIComponent(target.split('/').pop().split('?')[0]) || 'Engram Setup.exe';
  const file = path.join(dir, name);
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
    if (send) send('desktop-update-progress', { received, total, percent: total ? Math.floor((received / total) * 100) : null });
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(() => resolve());
  });
  log(`update installer downloaded: ${file} (${received} bytes)`);
  return { path: file, size: received };
}

ipcMain.handle('desktop-update-download', async (e, url, passedCfg) => {
  // 优先渲染进程传入与最近检查所用的配置，确保与资产 URL 同源
  const cfg = (passedCfg && typeof passedCfg === 'object' && passedCfg.giteaUrl && passedCfg.giteaRepo)
    ? passedCfg
    : (lastCheckCfg || (await resolveUpdateCfg(null)));
  const sender = e.sender;
  return downloadUpdateFile(cfg, url, (ch, data) => {
    if (sender && !sender.isDestroyed()) sender.send(ch, data);
  });
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
    beginSilentInstall(file, autoState.latestVersion, 'manual update');
  }, INSTALL_NOTICE_MS);
  return true;
});

// ---------- 自动更新（默认开启） ----------
// 启动延迟首查 + 每 8 小时复查；发现新版本 → 后台下载 → 全屏「正在更新」提示 → /S 静默安装 →
// 装完自动重启。应用内更新（自动与手动「下载并安装」）均走静默链，无安装向导；
// 仅双击安装包本身保留向导（可选目录）。便携版（PORTABLE_EXECUTABLE_DIR）不参与自动更新。
const AUTO_UPDATE_STARTUP_DELAY_MS = 30_000;
const AUTO_UPDATE_INTERVAL_MS = 8 * 3600 * 1000;
const INSTALL_NOTICE_MS = 3500; // 「正在更新」提示层展示时长，随后退出并静默安装

const autoState = {
  enabled: true,
  phase: 'idle', // idle | unconfigured | checking | downloading | up-to-date | installing | failed
  latestVersion: null,
  percent: null,
  error: '',
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
  broadcast('desktop-update-state', { ...autoState });
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
 *  安装记住的模式，可能与本次实际位置不符导致静默参数失效。 */
function installerScopeFlag() {
  const exe = app.getPath('exe').toLowerCase();
  const pf = (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase();
  const pf86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
  if (exe.startsWith(pf + path.sep) || exe.startsWith(pf86 + path.sep)) return '/allusers';
  return '/currentuser';
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

/** 静默安装 + 自动重启：cmd 链等待 /S 安装完成后无条件拉起新版（不依赖 NSIS 静默模式是否
 *  自动启动，也不依赖任何脚本解释器）；PS 进度窗为尽力而为的装饰层。
 *  spawn 后主进程随即退出——先撤锁、撤端口、撤文件占用，NSIS 无需强杀旧进程即可覆盖安装。 */
function beginSilentInstall(file, version, source = 'auto update') {
  const target = installedAppExe();
  const scopeFlag = installerScopeFlag();
  const cmd = `start "" /wait "${file}" /S ${scopeFlag} & start "" "${target}"`;
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

async function autoUpdateTick() {
  if (process.platform !== 'win32' || autoBusy) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return; // 便携版不自动更新
  autoState.enabled = readConfig().autoUpdate !== false;
  if (!autoState.enabled) {
    setAutoPhase('idle');
    return;
  }
  autoBusy = true;
  autoAbort = new AbortController();
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
    autoState.latestVersion = release.version;
    setAutoPhase('downloading');
    const { path: file } = await downloadUpdateFile(cfg, exe.url, (ch, data) => {
      if (ch === 'desktop-update-progress') autoState.percent = data.percent ?? null;
      broadcast(ch, data);
    }, autoAbort.signal);
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
      beginSilentInstall(file, autoState.latestVersion);
    }, INSTALL_NOTICE_MS);
  } catch (e) {
    if (autoAbort && autoAbort.signal.aborted) {
      setAutoPhase('idle'); // 手动中止（如关闭开关），不算失败
    } else {
      autoState.error = describeError(e);
      setAutoPhase('failed');
      log('auto update failed: ' + autoState.error);
    }
  } finally {
    autoBusy = false;
    autoAbort = null;
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
  if (c.autoUpdate) setTimeout(autoUpdateTick, 1000); // 开启后立即触发一次检查
  return { ...autoState };
});
