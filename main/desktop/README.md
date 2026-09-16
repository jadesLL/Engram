# Engram Windows 桌面端（Electron）

Windows 桌面客户端，内嵌完整后端，所有数据保存在本机，无需服务器即可使用。需要多设备协作时，在「设置 → 多端同步」加入同步群组，各端仍保留完整本地库并支持离线工作。

相比浏览器额外提供**本地文件「用系统程序打开」**（下载到临时目录后调起 Word/WPS 等）。

## 使用

1. 首次启动直接初始化本地数据库与数据目录，完成后进入主界面。
2. 之后启动继续直接进入主界面。
3. **点 × 驻留系统托盘**：关闭窗口不退出应用，最小化到系统托盘后台继续运行（内嵌后端与任务不中断；首次关闭弹通知说明）；最小化按钮仍进任务栏。托盘单击/双击恢复窗口，右键菜单「打开 Engram / 退出 Engram」真正退出（退出时内嵌后端一并结束）。驻留托盘期间再次启动只唤起已有窗口（单实例锁，避免双实例抢占本地端口）。
4. 数据仓库位置与本地服务端口可在「设置 → 数据管理」中调整。

## 软件更新

更新源在 Web 端「设置 → 软件更新 → 更新源配置」配置（远端仓库地址 + 可选凭据），保存在数据目录 `.env`。

- **自动更新（默认开启）**：应用启动约 30 秒后自动检查更新，之后每 8 小时复查一次。发现新版本后自动在后台下载（设置页可见进度），下载完成后应用内弹出全屏「正在更新」提示，随后退出并以 `/S` 静默参数运行安装包（无向导），装完自动重启新版；`userData/downloads` 中的旧安装包随之清理。
- **安装过程提示不空窗**：应用退出前显示应用内全屏「正在更新」提示层；随后由独立于安装目录的 Windows 进度窗（PowerShell WinForms，经 -EncodedCommand 启动，无临时脚本文件）持续显示「正在安装更新」，静默安装完成后该窗口关闭并自动拉起新版；编排过程记录在 `userData/updater/install-ui.log`。
- **手动更新**：同一页面保留「检查更新」「下载并安装」按钮作为兜底，点击「下载并安装」同样全自动——直接下载并静默安装，无中间确认、无安装向导，安装期间持续显示进度提示。
- **开关**：设置页「自动更新」开关即时生效（关闭会中断进行中的自动下载），状态持久化在 `config.json` 的 `autoUpdate` 字段。
- **边界**：便携版（portable）不参与自动更新；双击安装包本身仍走完整安装向导（`oneClick: false`，可选安装目录），只有应用内更新（自动与手动按钮）走静默参数。若安装时选择了「为所有用户安装」（Program Files），静默安装会触发一次 UAC 授权，属系统要求。

## 重新构建

在仓库 `main/` 根目录执行（需联网下载 electron / electron-builder / 原生模块，届时申请 `--allow-downloads`）：

```bash
pnpm build:desktop
```

该命令依次：构建 server → 构建 web → `prepare-desktop.js` 复制产物并生成 server 运行时依赖清单（zod 固定 3.25.76）→ 装 server 生产依赖（`--ignore-workspace --no-frozen-lockfile`）→ `electron-builder` 产出 NSIS 安装包与便携版到 `desktop/dist/`（内置 `@electron/rebuild` 自动重编 better-sqlite3 对 Electron ABI）。

**Windows Defender 注意**：打包时 electron-builder 解压 electron 二进制，Defender 实时扫描可能锁定 `electron.exe` 致 `EPERM rename` 失败。构建前请关闭 Defender 实时扫描，或把构建目录加入 Defender 排除项。

**asar 配置**：`desktop/package.json` 设 `asar: true`，配合 `asarUnpack` 解包 better-sqlite3 / sqlite-vec / @napi-rs/canvas 三个原生模块到 `app.asar.unpacked`。把上万 `node_modules` 散文件合并进单个 `app.asar`，使 NSIS 安装从逐文件写出变为单归档解压，安装速度显著提升。此前 `asar: false` 是为避免非管理员环境无法创建 symlink，但 `build:desktop` 用 `--shamefully-hoist` 产出扁平 node_modules、无 symlink，该顾虑不成立，已切回 `true`。**注意**：server 子进程必须以 `fork + ELECTRON_RUN_AS_NODE`（electron.exe 纯 Node 模式）启动才能读 asar，不可改 `spawn('node')`。

## 技术说明

- `main.js`：主进程。启动时 fork 内嵌 server 子进程（`ELECTRON_RUN_AS_NODE` 纯 Node 模式），探活后加载本地页面。环境变量 `ENGRAM_USER_DATA` 可覆写 userData 目录、`ENGRAM_LOCAL_PORT` 可覆写服务端口（默认 18180），用于隔离测试/便携场景；两者须在启动前设置，前者在单实例锁之前生效。
- `preload.js`：通过 `window.wikiDesktop` 暴露受控 API（`getDataDir` / `chooseDataDir` / `restartServer` / `getLocalPort` / `setLocalPort` / `openFileBytes` / `desktopUpdateCheck` / `desktopUpdateDownload` / `desktopUpdateRunInstaller` / `desktopUpdateGetState` / `desktopUpdateSetAuto`，以及事件订阅 `onUpdateProgress` / `onUpdateState`），`contextIsolation` 开启。
- `scripts/prepare-desktop.js`：打包前复制 server/web 产物并生成 server 运行时依赖清单。
- 原生模块：`better-sqlite3` 按 Electron ABI 重编；`sqlite-vec`（平台包 `sqlite-vec-windows-x64`）与 `@napi-rs/canvas` 用 Windows 预编译二进制，均通过 `asarUnpack` 解包以便加载。
- 桌面端默认关闭 ONLYOFFICE 在线编辑（`OFFICE_EDITOR_ENABLED=false`），Office 文件以本地预览或「用系统程序打开」替代。
