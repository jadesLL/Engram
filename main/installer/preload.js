// 安装器渲染进程的唯一能力入口（contextBridge 桥）。
// 摘要窗口关掉了 nodeIntegration、打开了 contextIsolation：ui.html 不能再 require('electron')，
// 需要的 IPC（事件订阅、启动/取消安装、仓库探测、剪贴板）全部在这里按白名单转发。
// 单测：installer/scripts/tests/installer-hardening.test.js
const { contextBridge, ipcRenderer } = require('electron');

// 主进程 → 渲染进程的事件通道（与 main.js 的 send() 调用一一对应）
const EVENTS = ['steps', 'step', 'done', 'fail', 'log', 'exit', 'alldone', 'need-creds'];

contextBridge.exposeInMainWorld('engramInstaller', {
  /** 订阅主进程事件；通道名白名单之外的调用一律忽略 */
  on(channel, callback) {
    if (!EVENTS.includes(channel) || typeof callback !== 'function') return;
    ipcRenderer.on(channel, (_event, data) => callback(data));
  },
  startInstall(payload) {
    ipcRenderer.send('start-install', payload || {});
  },
  cancelInstall() {
    ipcRenderer.send('cancel-install');
  },
  hasRepo() {
    return ipcRenderer.invoke('has-repo');
  },
  probeRepo(url) {
    return ipcRenderer.invoke('probe-repo', url);
  },
  bundleInfo() {
    return ipcRenderer.invoke('bundle-info');
  },
  /** 复制日志走主进程剪贴板（与改造前一致：不依赖网页 Clipboard API） */
  copyLog(text) {
    ipcRenderer.send('copy-log', String(text == null ? '' : text));
  },
});
