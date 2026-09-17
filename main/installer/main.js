// Engram 源码版安装器 GUI：驱动 install-engram.ps1 部署引擎。
// 进度采集：部署脚本逐行写进度日志文件（PS5.1 管道输出块缓冲，stdout 不可靠），此处轮询解析。
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { probeRepo } = require('./scripts/lib/repo-probe.js');

let win = null;
let child = null;
let pollTimer = null;
let processed = 0; // 已消费的日志字符数

/** 安装目录：%LOCALAPPDATA%\engram\Engram（便携环境与克隆都在这儿） */
function installRoot() {
  return path.resolve(process.env.LOCALAPPDATA || '', 'engram', 'Engram');
}

/** 取安装目录内的固定相对路径；LOCALAPPDATA 来自环境，这里再挡一道越界 */
function insideInstallRoot(...segments) {
  const root = installRoot();
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`拒绝访问安装目录之外的路径：${target}`);
  }
  return target;
}

function scriptPath() {
  // 已装过的机器优先用克隆里的引擎脚本：它随 git pull 更新，引擎侧的修复（如日志编码）
  // 因此不必重打安装器 exe 就能到客户机——2026-09-18 就因为 exe 里是打包时的旧脚本，
  // 客户机的 GUI 日志一直是乱码。
  try {
    const cloned = insideInstallRoot('main', 'scripts', 'install-engram.ps1');
    if (fs.existsSync(cloned)) return cloned;
  } catch {
    /* 路径异常就继续往下找 */
  }
  // 打包后 ps1 在 resources 根（extraResources 不进 asar）；文件不在就退回仓库脚本，
  // 免得开发态（或被改名的 electron 让 isPackaged=true）拿着不存在的路径去 -File 报错
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'install-engram.ps1');
    if (fs.existsSync(bundled)) return bundled;
  }
  return path.join(__dirname, '..', 'scripts', 'install-engram.ps1');
}

/** 便携 Git 优先（安装器自己装的），其次 PATH 上的 git */
function resolveGitExe() {
  const portable = path.resolve(process.env.LOCALAPPDATA || '', 'engram', 'MinGit', 'cmd', 'git.exe');
  return fs.existsSync(portable) ? portable : 'git';
}

/**
 * 探测仓库是否需要凭据（两步流程的第二步）：实现见 scripts/lib/repo-probe.js。
 *   public / private / unreachable / unknown（本机还没有 git，跳过预检照常开始安装）
 */
function probe(rawUrl) {
  return probeRepo(rawUrl, { gitExe: resolveGitExe() });
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
  } else if (line.startsWith('##AUTH:')) {
    // 引擎侧发现需要凭据（预检说公开、实际克隆时才要，或本机没有 git 没法预检）
    send('need-creds', { step: line.slice(7) });
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

function startInstall({ user, pass, repoUrl } = {}) {
  if (child) return;
  const env = { ...process.env };
  // 通用名（GitHub 也走这套：令牌当密码用）；引擎同时认旧的 ENGRAM_GITEA_* 名字
  if (user) env.ENGRAM_REPO_USER = user;
  if (pass) env.ENGRAM_REPO_PASS = pass;
  const logFile = path.join(app.getPath('temp'), 'engram-install.log');
  try {
    fs.writeFileSync(logFile, '');
  } catch {
    /* 忽略：ps1 会自行创建 */
  }
  env.ENGRAM_INSTALL_LOG = logFile;
  processed = 0;

  // -NoPrompt：GUI 场景没有可交互控制台，引擎不要 Read-Host 等输入，缺凭据时发 ##AUTH 让界面再问。
  // 克隆里的引擎可能还是旧版（新 exe + 没 pull 过的克隆），旧版没有这个开关，传了会直接报
  // 「无法识别的参数」——按脚本里有没有该开关决定传不传。
  const engine = scriptPath();
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', engine];
  try {
    if (fs.readFileSync(engine, 'utf8').includes('$NoPrompt')) args.push('-NoPrompt');
  } catch {
    /* 读不到就按旧版处理 */
  }
  if (repoUrl) args.push('-RepoUrl', repoUrl);
  const ps = spawn('powershell.exe', args, { env, windowsHide: true });
  child = ps;
  pollTimer = setInterval(() => pollLog(logFile), 400);

  // 引擎正常时一切都写日志文件；stderr 只在它自己都没起来时才用得上，转发进界面便于定位
  ps.on('error', (e) => {
    send('fail', { msg: '启动部署脚本失败：' + (e && e.message ? e.message : e) });
  });
  ps.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.trim()) send('log', { line: line.trim() });
    }
  });

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

  ipcMain.on('start-install', (_e, payload) => startInstall(payload));
  ipcMain.on('cancel-install', () => cancelInstall());
  ipcMain.handle('has-repo', () => {
    try {
      return fs.existsSync(insideInstallRoot('.git'));
    } catch {
      return false;
    }
  });
  ipcMain.handle('probe-repo', (_e, url) => probe(url));
});

app.on('window-all-closed', () => {
  cancelInstall();
  app.quit();
});
