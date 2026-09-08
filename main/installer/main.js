// Engram 源码版安装器 GUI：驱动 install-engram.ps1 部署引擎。
// 进度采集：部署脚本逐行写进度日志文件（PS5.1 管道输出块缓冲，stdout 不可靠），此处轮询解析。
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let win = null;
let child = null;
let pollTimer = null;
let processed = 0; // 已消费的日志字符数

function scriptPath() {
  // 打包后 ps1 在 resources 根（extraResources 不进 asar）；开发态直接用仓库脚本
  return app.isPackaged
    ? path.join(process.resourcesPath, 'install-engram.ps1')
    : path.join(__dirname, '..', 'scripts', 'install-engram.ps1');
}

function send(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

function handleLine(line) {
  line = line.replace(/^[\uFEFF\r]+/, '').replace(/\r$/, '');
  if (!line.trim()) return;
  if (line.startsWith('##STEPS:')) {
    const steps = line.slice(8).split(';').filter(Boolean).map((p) => {
      const [id, label] = p.split('=');
      return { id, label };
    });
    send('steps', steps);
  } else if (line.startsWith('##STEP:')) {
    send('step', { id: line.slice(7) });
  } else if (line.startsWith('##DONE:')) {
    send('done', { id: line.slice(7) });
  } else if (line.startsWith('##FAIL:')) {
    const idx = line.indexOf('|');
    send('fail', { msg: idx >= 0 ? line.slice(idx + 1) : '部署失败' });
  } else if (line.startsWith('##ALLDONE')) {
    send('alldone', {});
  } else {
    send('log', { line: line.trim() });
  }
}

function pollLog(logFile) {
  fs.readFile(logFile, 'utf8', (err, text) => {
    if (err || !text || text.length <= processed) return;
    // 只消费完整行；Add-Content 按行追加，正常以 \n 结尾（正在写入的半行留待下次）
    let usable = text;
    if (!usable.endsWith('\n')) usable = usable.slice(0, usable.lastIndexOf('\n') + 1);
    if (usable.length <= processed) return;
    const fresh = usable.slice(processed);
    processed = usable.length;
    for (const line of fresh.split('\n')) handleLine(line);
  });
}

function startInstall(creds) {
  if (child) return;
  const env = { ...process.env };
  if (creds && creds.user) env.ENGRAM_GITEA_USER = creds.user;
  if (creds && creds.pass) env.ENGRAM_GITEA_PASS = creds.pass;
  const logFile = path.join(app.getPath('temp'), 'engram-install.log');
  try {
    fs.writeFileSync(logFile, '');
  } catch {
    /* 忽略：ps1 会自行创建 */
  }
  env.ENGRAM_INSTALL_LOG = logFile;
  processed = 0;

  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()],
    { env, windowsHide: true },
  );
  child = ps;
  pollTimer = setInterval(() => pollLog(logFile), 400);

  ps.on('exit', (code) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    pollLog(logFile); // 兜底消费缓冲期内的剩余行
    child = null;
    send('exit', { code });
  });
}

function cancelInstall() {
  if (pollTimer) clearInterval(pollTimer);
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    child = null;
  }
  if (win && !win.isDestroyed()) win.close();
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 460,
    height: 680,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e3a8a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('ui.html');
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[installer] load fail ${code} ${desc} ${url}`);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    console.error(`[ui] ${message}`);
  });

  ipcMain.on('start-install', (_e, creds) => startInstall(creds));
  ipcMain.on('cancel-install', () => cancelInstall());
  ipcMain.handle('has-repo', () => {
    return Boolean(fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'engram', 'Engram', '.git')));
  });
});

app.on('window-all-closed', () => {
  cancelInstall();
  app.quit();
});
