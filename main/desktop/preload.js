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
  // ---------- 桌面端自更新（仅本地模式；配置共用服务器 /api/update/config） ----------
  // 检查 Gitea 最新 Release（返回 { ok, currentVersion, latestVersion, hasUpdate, exe, releaseUrl }）
  desktopUpdateCheck: () => ipcRenderer.invoke('desktop-update-check'),
  // 下载安装包（进度经 desktop-update-progress 事件推送）
  desktopUpdateDownload: (url) => ipcRenderer.invoke('desktop-update-download', url),
  // 运行安装包并退出应用
  desktopUpdateRunInstaller: (filePath) => ipcRenderer.invoke('desktop-update-run-installer', filePath),
  // 下载进度订阅（返回取消函数）
  onUpdateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('desktop-update-progress', listener);
    return () => ipcRenderer.removeListener('desktop-update-progress', listener);
  },
});
