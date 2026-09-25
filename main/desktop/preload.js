// 预加载脚本：向页面暴露受控 API（window.wikiDesktop）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wikiDesktop', {
  // ---------- 数据仓库位置与整库恢复（本地模式） ----------
  // 查询当前数据仓库位置（{ dataDir, isDefault }）
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  // 打开系统目录选择框切换数据仓库（不迁移数据：已有仓库直接打开，空目录由后端新建；
  // 取消返回 null，位置未变返回 { same }，失败返回 { error }，成功返回 { dir, isNew }）
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
  // 收集箱原文件：按 vault 相对路径用系统默认应用打开 / 在资源管理器中定位
  // （只传路径不传字节，GB 级录屏也能秒开；主进程限制在数据目录的 收集箱/ 内）
  openInboxFile: (relPath) => ipcRenderer.invoke('inbox-open-path', relPath),
  revealInboxFile: (relPath) => ipcRenderer.invoke('inbox-reveal-path', relPath),
  // 同步窗口控制按钮（标题栏融合条 WCO）配色，主题切换时调用；不支持的平台主进程忽略
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('set-title-bar-overlay', opts),
  // ---------- 桌面端自更新 ----------
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
  // 查询运行形态：{ packaged, platform, version }，源码模式额外带 git 身份
  // { commit, commitDate, dirty }（版本号仅随发版变化，提交号随每次更新变化）
  getDesktopEnv: () => ipcRenderer.invoke('desktop-get-env'),
  // 检查源码更新：fetch 远端并比对当前分支落后多少提交
  // { ok, branch, behind, upToDate, localCommit, localDate, dirty, remoteCommit, remoteDate, changes }
  desktopSourceUpdateCheck: () => ipcRenderer.invoke('desktop-source-update-check'),
  // 增量拉取源码并重建：主进程 pull 后拉起构建脚本，应用自动退出并由新实例接管
  // （依赖清单真变化时自动装依赖，不再要求去终端跑脚本）
  desktopSourceUpdate: () => ipcRenderer.invoke('desktop-source-update'),
  // ---------- 源码模式卸载（设置 → 软件更新；仅源码安装形态显示） ----------
  // 查询卸载可用性：{ available }，进程位于源码版安装根（%LOCALAPPDATA%\engram）下才可用
  desktopSourceUninstallState: () => ipcRenderer.invoke('desktop-source-uninstall-state'),
  // 卸载应用：deleteData 为 true 时连知识库数据一起删（默认保留）。
  // 主进程停掉内嵌服务后拉起独立卸载脚本并立即退出应用；失败返回 { ok: false, error }
  desktopSourceUninstall: (deleteData) => ipcRenderer.invoke('desktop-source-uninstall', deleteData),
  // ---------- 源码模式自动检查（启动延迟首查 + 每 8 小时复查；只提示，不自动升级） ----------
  // 查询状态：{ enabled, phase: idle|checking|up-to-date|behind|failed, behind,
  //             localCommit, remoteCommit, changes, error, checkedAt }
  desktopSourceAutoState: () => ipcRenderer.invoke('desktop-source-auto-state'),
  // 开关自动检查（持久化到 config.json；开启后立即触发一次检查）
  desktopSourceSetAuto: (enabled) => ipcRenderer.invoke('desktop-source-set-auto', enabled),
  // 自动检查状态订阅（返回取消函数）
  onSourceState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('desktop-source-state', listener);
    return () => ipcRenderer.removeListener('desktop-source-state', listener);
  },
  // ---------- 桌面快捷方式（设置 → 软件更新 → 桌面端） ----------
  // 重建桌面快捷方式：源码模式同时生成/刷新带 Engram 图标的 Engram.exe 作为启动目标，
  // 开始菜单里属于本安装的 Engram.lnk 一并同步。
  // 返回 { ok, shortcut, target, exe, startMenu, message } 或 { ok: false, error }
  desktopRebuildShortcut: () => ipcRenderer.invoke('desktop-rebuild-shortcut'),
  // ---------- 开机自启（设置 → 连接与同步 → 桌面端更新；Windows 登录时静默启动到托盘） ----------
  // 查询状态：{ supported, name, enabled, stale, blocked, command }
  //   enabled=注册表 Run 项在（开机会启动）；stale=命令与当前安装形态不一致；
  //   blocked=项在但被「任务管理器 → 启动」禁用；command=当前/将写入的完整命令行
  getLaunchAtLogin: () => ipcRenderer.invoke('get-launch-at-login'),
  // 开关开机自启（写/删注册表 Run 项；失败返回 { ok: false, error }，成功返回 { ok: true, ...状态 }）
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('set-launch-at-login', enabled),
  // 状态订阅：托盘菜单里改了开关时同步到已打开的设置页（返回取消函数）
  onLaunchAtLoginState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('desktop-launch-at-login', listener);
    return () => ipcRenderer.removeListener('desktop-launch-at-login', listener);
  },
});
