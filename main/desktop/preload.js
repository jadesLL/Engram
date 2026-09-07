// 预加载脚本：向页面暴露受控 API（window.wikiDesktop）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wikiDesktop', {
  // 查询当前连接模式（mode: '' | 'local' | 'remote'，远端含地址与令牌）
  getConnection: () => ipcRenderer.invoke('get-connection'),
  // 切换到本地模式（内嵌后端）
  setLocalMode: () => ipcRenderer.invoke('set-local-mode'),
  // 切换到远端模式（地址 + 令牌，免密兑换；directUrl 可选直连地址，可用时优先连接）
  setRemoteMode: (url, token, directUrl) => ipcRenderer.invoke('set-remote-mode', url, token, directUrl),
  // 返回启动页重新选择模式
  openConnectionSettings: () => ipcRenderer.invoke('open-connection-settings'),
  // ---------- 数据保存位置与整库恢复（本地模式） ----------
  // 查询当前数据保存位置（{ dataDir, isDefault }）
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  // 打开系统目录选择框更改数据保存位置（旧数据自动迁移并重启内嵌后端；取消返回 null，失败返回 { error }）
  chooseDataDir: () => ipcRenderer.invoke('choose-data-dir'),
  // 重启内嵌后端（恢复备份暂存后使其生效；窗口会重新加载）
  restartServer: () => ipcRenderer.invoke('restart-server'),
  // ---------- 本地服务端口（本地模式） ----------
  // 查询当前本地服务端口（{ port, isDefault, envOverridden }）
  getLocalPort: () => ipcRenderer.invoke('get-local-port'),
  // 更改本地服务端口（占用预检通过后写入 config.json 并重启内嵌后端；未变化返回 { same }，失败返回 { error }）
  setLocalPort: (port) => ipcRenderer.invoke('set-local-port', port),
  // 远程文件「用系统程序打开」
  openFileBytes: (name, bytes) => ipcRenderer.invoke('open-file-bytes', name, bytes),
  // 同步窗口控制按钮（标题栏融合条 WCO）配色，主题切换时调用；不支持的平台主进程忽略
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('set-title-bar-overlay', opts),
  // ---------- 桌面端自更新（本地/远端模式均可用；配置取自当前连接服务器的 /api/update/config） ----------
  // 检查 Gitea 最新 Release（cfg 传设置页已保存的更新源配置，旧版主进程会忽略该参数自行解析；
  // 返回 { ok, currentVersion, latestVersion, hasUpdate, exe, releaseUrl }）
  desktopUpdateCheck: (cfg) => ipcRenderer.invoke('desktop-update-check', cfg),
  // 下载安装包（cfg 同上，用于下载鉴权与来源校验；进度经 desktop-update-progress 事件推送）
  desktopUpdateDownload: (url, cfg) => ipcRenderer.invoke('desktop-update-download', url, cfg),
  // 运行安装包并退出应用（静默安装：/S 静默 + 独立进度窗 + 装完自动重启；version 仅用于进度窗文案）
  desktopUpdateRunInstaller: (filePath, version) => ipcRenderer.invoke('desktop-update-run-installer', filePath, version),
  // 下载进度订阅（返回取消函数）
  onUpdateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('desktop-update-progress', listener);
    return () => ipcRenderer.removeListener('desktop-update-progress', listener);
  },
  // ---------- 自动更新（主进程状态机：idle/unconfigured/checking/downloading/up-to-date/installing/failed） ----------
  // 查询自动更新当前状态（含开关、阶段、最新版本、下载进度、失败原因）
  desktopUpdateGetState: () => ipcRenderer.invoke('desktop-update-get-state'),
  // 开关自动更新（持久化到 config.json；开启后立即触发一次检查）
  desktopUpdateSetAuto: (enabled) => ipcRenderer.invoke('desktop-update-set-auto', enabled),
  // 自动更新状态订阅（返回取消函数）
  onUpdateState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('desktop-update-state', listener);
    return () => ipcRenderer.removeListener('desktop-update-state', listener);
  },
  // ---------- 源码模式自更新（非打包形态；安装包形态主进程会拒绝） ----------
  // 查询运行形态（{ packaged, platform, version }）：false = 源码模式，更新走源码拉取
  getDesktopEnv: () => ipcRenderer.invoke('desktop-get-env'),
  // 检查源码更新：fetch 远端并比对当前分支落后多少提交（{ ok, branch, behind, upToDate }）
  desktopSourceUpdateCheck: () => ipcRenderer.invoke('desktop-source-update-check'),
  // 增量拉取源码并重建：主进程 pull 后拉起构建脚本，应用自动退出并由新实例接管
  desktopSourceUpdate: () => ipcRenderer.invoke('desktop-source-update'),
});
