// 预加载脚本：向页面暴露受控 API（window.wikiDesktop）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wikiDesktop', {
  setServer: (url) => ipcRenderer.invoke('set-server', url),
  getServer: () => ipcRenderer.invoke('get-server'),
  resetServer: () => ipcRenderer.invoke('reset-server'),
  openFileBytes: (name, bytes) => ipcRenderer.invoke('open-file-bytes', name, bytes),
});
