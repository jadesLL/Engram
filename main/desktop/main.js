// Engram 桌面端主进程（Electron）
// 双模式：
//  - 本地：fork 内嵌 server 子进程（ELECTRON_RUN_AS_NODE 纯 Node 模式）+ 探活后加载
//  - 远端：凭 desktop token 调 /api/auth/desktop-exchange 兑换 JWT，预置 cookie 后加载远端页面
// 启动页 index.html 供用户选择模式或切换连接。
const { app, BrowserWindow, ipcMain, shell, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { spawn } = require('node:child_process');

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
    title: 'Engram',
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
    ENGRAM_WEB_DIST: webDistPath(),
    ENGRAM_APP_VERSION: app.getVersion(),
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
  const actualOrigin = remoteUrl.replace(/\/+$/, '');
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

ipcMain.handle('desktop-update-check', async (_e, passedCfg) => {
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
});

// 下载安装包到 userData/downloads/，进度经 webContents.send 推给渲染进程
ipcMain.handle('desktop-update-download', async (e, url, passedCfg) => {
  const target = String(url);
  // 只允许从配置的远端仓库下载（防注入任意 URL）；优先渲染进程传入与最近检查所用的配置
  const cfg = (passedCfg && typeof passedCfg === 'object' && passedCfg.giteaUrl && passedCfg.giteaRepo)
    ? passedCfg
    : (lastCheckCfg || (await resolveUpdateCfg(null)));
  if (!cfg.giteaUrl || !target.startsWith(cfg.giteaUrl + '/')) {
    throw new Error('下载地址不在配置的远端仓库源内');
  }
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const name = target.split('/').pop().split('?')[0] || 'Engram Setup.exe';
  const file = path.join(dir, name);
  let res;
  try {
    res = await fetch(target, { headers: repoAuthHeaders(cfg), redirect: 'follow' });
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
