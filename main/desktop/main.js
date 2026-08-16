// LLM Wiki 桌面端主进程（Electron）
// 双模式：
//  - 本地：fork 内嵌 server 子进程（ELECTRON_RUN_AS_NODE 纯 Node 模式）+ 探活后加载
//  - 远端：凭 desktop token 调 /api/auth/desktop-exchange 兑换 JWT，预置 cookie 后加载远端页面
// 启动页 index.html 供用户选择模式或切换连接。
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');

const LOCAL_PORT = 18080;
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    title: 'LLM Wiki',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  return win;
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
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    TZ: 'Asia/Shanghai',
    DATA_DIR: path.join(app.getPath('userData'), 'data'),
    PORT: String(LOCAL_PORT),
    HOST: '127.0.0.1',
    OFFICE_EDITOR_ENABLED: 'false',
    WIKILLM_WEB_DIST: webDistPath(),
  };
  // 命门：必须 fork（默认 execPath=electron.exe）+ ELECTRON_RUN_AS_NODE，子进程才以 Electron 纯
  // Node 模式运行、能读 app.asar 内的 node_modules；改 spawn('node') 会让 server 读不了 asar。
  serverChild = fork(entry, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  serverChild.stdout.on('data', (d) => log('[server] ' + d.toString().trim()));
  serverChild.stderr.on('data', (d) => log('[server!] ' + d.toString().trim()));
  serverChild.on('exit', (code) => log(`[server] exited code=${code}`));

  const base = `http://127.0.0.1:${LOCAL_PORT}`;
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
async function startRemoteMode(remoteUrl, token) {
  const origin = remoteUrl.replace(/\/+$/, '');
  try {
    const r = await fetch(origin + '/api/auth/desktop-exchange', {
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
      url: origin,
      name: 'token',
      value: jwt,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
    win.loadURL(origin);
  } catch (e) {
    win.loadURL(
      dataUrl(
        '<h2>无法连接远端服务器</h2><p>' +
          (e && e.message ? e.message : String(e)) +
          '</p><p>地址：' + origin + '</p>'
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

app.whenReady().then(launchByConfig);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) launchByConfig();
});

app.on('before-quit', () => {
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
  return { mode: c.mode || '', remoteUrl: c.remoteUrl || '', remoteToken: c.remoteToken || '' };
});

ipcMain.handle('set-local-mode', () => {
  writeConfig({ mode: 'local' });
  stopLocalChild();
  startLocalMode();
  return true;
});

ipcMain.handle('set-remote-mode', (_e, url, token) => {
  writeConfig({ mode: 'remote', remoteUrl: url, remoteToken: token });
  stopLocalChild();
  startRemoteMode(url, token);
  return true;
});

ipcMain.handle('open-connection-settings', () => {
  stopLocalChild();
  writeConfig({});
  win.loadFile('index.html');
  return true;
});

// 远程文件「用系统程序打开」：渲染进程把文件字节传过来，写临时目录后调系统默认程序
ipcMain.handle('open-file-bytes', (_e, name, bytes) => {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '-');
  const dir = path.join(app.getPath('temp'), 'example-wiki');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe);
  fs.writeFileSync(file, Buffer.from(bytes));
  return shell.openPath(file); // 空串=成功
});
