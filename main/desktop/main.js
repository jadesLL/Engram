// LLM Wiki 桌面端主进程（Electron）
// 双模式：
//  - 本地：fork 内嵌 server 子进程（ELECTRON_RUN_AS_NODE 纯 Node 模式）+ 探活后加载
//  - 远端：凭 desktop token 调 /api/auth/desktop-exchange 兑换 JWT，预置 cookie 后加载远端页面
// 启动页 index.html 供用户选择模式或切换连接。
const { app, BrowserWindow, ipcMain, shell, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { spawn } = require('node:child_process');

// 默认 18180 避开 Docker 版的 18080；用户本机若同时跑 Docker example-wiki(18080) 与 desktop，
// 两者互不抢占端口、可共存。
const LOCAL_PORT = 18180;
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
    WIKILLM_APP_VERSION: app.getVersion(),
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

/**
 * 应用菜单：进入本地模式后启动页被内嵌 Web 应用替换，且下次启动会直接跳过启动页，
 * 用户无处切换回远端。菜单「返回启动页 / 切换模式」是该场景下唯一稳定的切换入口
 * （快捷键 CmdOrCtrl+Shift+L），复用 open-connection-settings IPC 的逻辑。
 */
function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'LLM Wiki',
      submenu: [
        {
          label: '返回启动页 / 切换模式',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            stopLocalChild();
            writeConfig({});
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
  Menu.setApplicationMenu(buildAppMenu());
  launchByConfig();
});

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

// ---------- 桌面端自更新（Gitea Releases 拉安装包） ----------
// 更新配置与服务器端共用 userData/data/.env（本地模式 server 的 DATA_DIR），
// 由内嵌 server 的 /api/update/config 端点读写，桌面端主进程只读同一文件。
const UPDATE_KEYS = {
  giteaUrl: 'UPDATE_GITEA_URL',
  giteaRepo: 'UPDATE_GITEA_REPO',
  giteaToken: 'UPDATE_GITEA_TOKEN',
};

function desktopUpdateEnvFile() {
  return path.join(app.getPath('userData'), 'data', '.env');
}

function readDesktopUpdateEnv() {
  try {
    const text = fs.readFileSync(desktopUpdateEnvFile(), 'utf8');
    const out = { giteaUrl: '', giteaRepo: '', giteaToken: '' };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === UPDATE_KEYS.giteaUrl) out.giteaUrl = value.replace(/\/+$/, '');
      else if (key === UPDATE_KEYS.giteaRepo) out.giteaRepo = value;
      else if (key === UPDATE_KEYS.giteaToken) out.giteaToken = value;
    }
    return out;
  } catch {
    return { giteaUrl: '', giteaRepo: '', giteaToken: '' };
  }
}

function cmpVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((s) => Number(s.match(/\d+/)?.[0] || 0));
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((s) => Number(s.match(/\d+/)?.[0] || 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function giteaLatestRelease(cfg) {
  const res = await fetch(`${cfg.giteaUrl}/api/v1/repos/${cfg.giteaRepo}/releases/latest`, {
    headers: cfg.giteaToken ? { Authorization: `token ${cfg.giteaToken}` } : {},
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gitea API ${res.status}`);
  const data = await res.json();
  const tag = data.tag_name || '';
  const version = (tag.match(/v?(\d+(\.\d+)*)/i) || [])[1] || null;
  const assets = (data.assets || [])
    .filter((a) => a.browser_download_url)
    .map((a) => ({ name: a.name || '', url: a.browser_download_url, size: a.size || 0 }));
  return { tag, version, assets };
}

ipcMain.handle('desktop-update-check', async () => {
  const cfg = readDesktopUpdateEnv();
  if (!cfg.giteaUrl || !cfg.giteaRepo) {
    return { ok: false, error: 'not-configured' };
  }
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
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// 下载安装包到 userData/downloads/，进度经 webContents.send 推给渲染进程
ipcMain.handle('desktop-update-download', async (e, url) => {
  const target = String(url);
  // 只允许从配置的 Gitea 下载（防注入任意 URL）
  const cfg = readDesktopUpdateEnv();
  if (!cfg.giteaUrl || !target.startsWith(cfg.giteaUrl + '/')) {
    throw new Error('下载地址不在配置的 Gitea 源内');
  }
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const name = target.split('/').pop().split('?')[0] || 'LLM Wiki Setup.exe';
  const file = path.join(dir, name);
  const headers = cfg.giteaToken ? { Authorization: `token ${cfg.giteaToken}` } : {};
  const res = await fetch(target, { headers, redirect: 'follow' });
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
    if (e.sender && !e.sender.isDestroyed()) {
      e.sender.send('desktop-update-progress', { received, total, percent: total ? Math.floor((received / total) * 100) : null });
    }
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(() => resolve());
  });
  log(`update installer downloaded: ${file} (${received} bytes)`);
  return { path: file, size: received };
});

// 运行安装包并退出当前应用（NSIS 覆盖安装，安装器自身处理旧进程）
ipcMain.handle('desktop-update-run-installer', (_e, filePath) => {
  const file = path.resolve(String(filePath));
  const dir = path.resolve(path.join(app.getPath('userData'), 'downloads'));
  if (!file.startsWith(dir + path.sep)) {
    throw new Error('只允许运行 downloads 目录内的安装包');
  }
  if (!fs.existsSync(file)) throw new Error('安装包不存在');
  const child = spawn('cmd.exe', ['/c', 'start', '', '/wait', file], { detached: true, stdio: 'ignore' });
  child.unref();
  log(`update installer launched: ${file}`);
  setTimeout(() => app.quit(), 500);
  return true;
});
