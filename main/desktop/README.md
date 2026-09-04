# Engram Windows 桌面端（Electron）

桌面客户端，支持两种使用模式，可在「启动页 / 连接设置」中切换：

- **本地模式**：内嵌后端，所有数据保存在本机，无需任何服务器，开箱即用。适合离线、隐私或客户单机部署。
- **远端模式**：连接远端 Engram 服务（Docker 部署），凭「桌面端连接令牌」免密码登录。适合复用 NAS 上的集中数据。

相比浏览器额外提供**远程文件「用系统程序打开」**（下载到临时目录后调起 Word/WPS 等）。

## 使用

1. 首次启动进入启动页：
   - 选「使用本地」→ 直接进入本地模式（首次会初始化本地数据库与目录）。
   - 或在远端 Web 端「设置 → 桌面端连接」生成令牌，回桌面端填入服务器地址 + 令牌 → 连接。
2. 之后启动会记住上次模式，直接进入。
3. **点 × 驻留系统托盘**：关闭窗口不退出应用，最小化到系统托盘后台继续运行（本地模式下内嵌后端与任务不中断；首次关闭弹通知说明）；最小化按钮仍进任务栏。托盘单击/双击恢复窗口，右键菜单「打开 Engram / 退出 Engram」真正退出（退出时内嵌后端一并结束）。驻留托盘期间再次启动只唤起已有窗口（单实例锁，避免双实例抢占本地端口）。
4. 切换模式（进入本地/远端模式后唯一切换途径，快捷键 CmdOrCtrl+Shift+L）：
   - 应用菜单「Engram → 返回启动页 / 切换模式」回到启动页重新选择；
   - 或在远端 Web 端「设置 → 桌面端连接」面板点「返回启动页 / 切换模式」（仅桌面端壳内显示该按钮）。

## 远端令牌

在远端服务的 Web 端「设置 → 桌面端连接」生成令牌（默认有效期 365 天，可随时撤销），令牌格式 `lwid_…`。桌面端用它调 `/api/auth/desktop-exchange` 免密兑换登录态，30 天有效，期间所有请求复用现有 cookie 鉴权。

## 软件更新

更新源在 Web 端「设置 → 软件更新 → 更新源配置」配置（远端仓库地址 + 可选凭据），保存在数据目录 `.env`，本地/远端模式均可用。

- **自动更新（默认开启）**：应用启动约 30 秒后自动检查更新，之后每 8 小时复查一次。发现新版本后自动在后台下载（设置页可见进度），下载完成后应用内弹出全屏「正在更新」提示，随后退出并以 `/S` 静默参数运行安装包（无向导），装完自动重启新版；`userData/downloads` 中的旧安装包随之清理。
- **手动更新**：同一页面保留「检查更新」「下载并安装」按钮作为兜底，手动路径运行安装包时仍走完整安装向导（可选安装目录）。
- **开关**：设置页「自动更新」开关即时生效（关闭会中断进行中的自动下载），状态持久化在 `config.json` 的 `autoUpdate` 字段，跨模式切换保留。
- **边界**：便携版（portable）不参与自动更新；安装器本身保持向导式（`oneClick: false`），只有应用内自动更新走静默参数。

## 重新构建

在仓库 `main/` 根目录执行（需联网下载 electron / electron-builder / 原生模块，届时申请 `--allow-downloads`）：

```bash
pnpm build:desktop
```

该命令依次：构建 server → 构建 web → `prepare-desktop.js` 复制产物并生成 server 运行时依赖清单（zod 固定 3.25.76）→ 装 server 生产依赖（`--ignore-workspace --no-frozen-lockfile`）→ `electron-builder` 产出 NSIS 安装包与便携版到 `desktop/dist/`（内置 `@electron/rebuild` 自动重编 better-sqlite3 对 Electron ABI）。

**Windows Defender 注意**：打包时 electron-builder 解压 electron 二进制，Defender 实时扫描可能锁定 `electron.exe` 致 `EPERM rename` 失败。构建前请关闭 Defender 实时扫描，或把构建目录加入 Defender 排除项。

**asar 配置**：`desktop/package.json` 设 `asar: true`，配合 `asarUnpack` 解包 better-sqlite3 / sqlite-vec / @napi-rs/canvas 三个原生模块到 `app.asar.unpacked`。把上万 `node_modules` 散文件合并进单个 `app.asar`，使 NSIS 安装从逐文件写出变为单归档解压，安装速度显著提升。此前 `asar: false` 是为避免非管理员环境无法创建 symlink，但 `build:desktop` 用 `--shamefully-hoist` 产出扁平 node_modules、无 symlink，该顾虑不成立，已切回 `true`。**注意**：server 子进程必须以 `fork + ELECTRON_RUN_AS_NODE`（electron.exe 纯 Node 模式）启动才能读 asar，不可改 `spawn('node')`。

## 技术说明

- `main.js`：主进程。双模式调度——本地 fork 内嵌 server 子进程（`ELECTRON_RUN_AS_NODE` 纯 Node 模式，探活后加载）；远端用 token 兑换 JWT 预置 cookie 后加载远端页面。环境变量 `ENGRAM_USER_DATA` 可覆写 userData 目录、`ENGRAM_LOCAL_PORT` 可覆写本地模式端口（默认 18180），用于隔离测试/便携场景；两者须在启动前设置，前者在单实例锁之前生效。
- `preload.js`：通过 `window.wikiDesktop` 暴露受控 API（`getConnection` / `setLocalMode` / `setRemoteMode` / `openConnectionSettings` / `openFileBytes` / `desktopUpdateCheck` / `desktopUpdateDownload` / `desktopUpdateRunInstaller` / `desktopUpdateGetState` / `desktopUpdateSetAuto`，以及事件订阅 `onUpdateProgress` / `onUpdateState`），`contextIsolation` 开启。
- `scripts/prepare-desktop.js`：打包前复制 server/web 产物并生成 server 运行时依赖清单。
- 原生模块：`better-sqlite3` 按 Electron ABI 重编；`sqlite-vec`（平台包 `sqlite-vec-windows-x64`）与 `@napi-rs/canvas` 用 Windows 预编译二进制，均通过 `asarUnpack` 解包以便加载。
- 本地模式默认关闭 ONLYOFFICE 在线编辑（`OFFICE_EDITOR_ENABLED=false`），Office 文件以本地预览或「用系统程序打开」替代；远端模式（Docker 版）保留完整协同编辑。
