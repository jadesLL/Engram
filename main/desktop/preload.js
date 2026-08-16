// 预加载脚本：向页面暴露受控 API（window.wikiDesktop）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wikiDesktop', {
  // 查询当前连接模式（mode: '' | 'local' | 'remote'，远端含地址与令牌）
  getConnection: () => ipcRenderer.invoke('get-connection'),
  // 切换到本地模式（内嵌后端）
  setLocalMode: () => ipcRenderer.invoke('set-local-mode'),
  // 切换到远端模式（地址 + 令牌，免密兑换）
  setRemoteMode: (url, token) => ipcRenderer.invoke('set-remote-mode', url, token),
  // 返回启动页重新选择模式
  openConnectionSettings: () => ipcRenderer.invoke('open-connection-settings'),
  // 远程文件「用系统程序打开」
  openFileBytes: (name, bytes) => ipcRenderer.invoke('open-file-bytes', name, bytes),
});
