// LLM Wiki 桌面端主进程（Electron）
// 职责：启动页配置服务器地址 → 加载远程 Web 应用 → 提供"系统程序打开文件"能力
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
}

let win = null;

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

  const serverUrl = readConfig().serverUrl;
  if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadFile('index.html');
  }
}

// 启动页：保存服务器地址并进入
ipcMain.handle('set-server', (_e, url) => {
  writeConfig({ serverUrl: url });
  win.loadURL(url);
  return true;
});

ipcMain.handle('get-server', () => readConfig().serverUrl || '');

// 清除服务器配置（返回启动页）
ipcMain.handle('reset-server', () => {
  writeConfig({});
  win.loadFile('index.html');
  return true;
});

// 远程文件"用系统程序打开"：渲染进程把文件字节传过来，写临时目录后调系统默认程序
ipcMain.handle('open-file-bytes', (_e, name, bytes) => {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '-');
  const dir = path.join(app.getPath('temp'), 'example-wiki');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe);
  fs.writeFileSync(file, Buffer.from(bytes));
  return shell.openPath(file); // 空串=成功
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
