# Engram Windows 桌面端（Electron）

Windows 桌面客户端，内嵌完整后端，所有数据保存在本机，无需服务器即可使用。需要多设备协作时，在「设置 → 连接与同步 → 多端同步」加入同步群组，各端仍保留完整本地库并支持离线工作。

相比浏览器额外提供**本地文件「用系统程序打开」**（下载到临时目录后调起 Word/WPS 等）。

## 使用

1. 首次启动直接初始化本地数据库与数据目录，完成后进入主界面。
2. 之后启动继续直接进入主界面。
3. **点 × 驻留系统托盘**：关闭窗口不退出应用，最小化到系统托盘后台继续运行（内嵌后端与任务不中断；首次关闭弹通知说明）；最小化按钮仍进任务栏。托盘单击/双击恢复窗口，右键菜单「打开 Engram / 退出 Engram」真正退出（退出时内嵌后端一并结束）。驻留托盘期间再次启动只唤起已有窗口（单实例锁，避免双实例抢占本地端口）。
4. **开机自启（可选）**：设置 → 连接与同步 → 桌面端更新 →「开机自启」打开后，登录 Windows 会**静默启动到系统托盘**——只拉起内嵌后端与托盘图标，**不弹主窗口**；双击托盘图标（或桌面快捷方式）即打开主界面。托盘右键菜单里也有同一个开关。启动项写在注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `Engram` 值（任务管理器「启动」页可见，可在那儿禁用）；便携版不提供该项（运行时目录每次启动都在变）。
5. 数据仓库位置与本地服务端口可在「设置 → 数据与存储 → 存储位置」中调整。

## 软件更新

更新源在 Web 端「设置 → 连接与同步 → 软件更新 → 更新源配置」配置（远端仓库地址 + 可选凭据），保存在数据目录 `.env`。

- **自动更新（默认开启）**：应用启动约 4 秒后自动检查更新，之后按自适应退避复查——连续没发现新版本时 2→5→10→30→60 分钟逐级拉长（有更新待处理时每分钟复查），这一轮发现新版本（或你切回窗口、解除休眠/解锁）立刻回到最短间隔。发现新版本后自动在后台下载（设置页可见进度），下载完成后应用内弹出全屏「正在更新」提示，随后退出并以 `/S` 静默参数运行安装包（无向导），装完自动重启新版；`userData/downloads` 中的旧安装包随之清理。
- **源码模式的自动检查**：与安装包形态同一套节奏（启动 4 秒首查 + 自适应退避 + 回前台/唤醒补查）。检查走两级探测：先 `git ls-remote` 问远端分支的提交号，只有它和本地 `origin/<分支>` 不一致才真的 `git fetch` 增量对象，因此绝大多数轮次只有一个网络往返。落后时顶部更新提示条出现红点（并弹一次系统通知），点提示条的「立即更新并重启」即增量拉源码、重建并自动重启（过程中有置顶进度窗）。
- **一键更新提示条**：右上角更新提示条的主按钮直接执行更新，不再只是跳设置页——源码模式「立即更新并重启」、安装包形态「立即下载并安装」（下载带百分比）、服务端/浏览器形态「立即更新」（提交服务端更新并等新容器起来后自动刷新页面）。进度与失败原因就地显示在提示条里；「稍后提醒」与「查看详情」（跳设置页看完整信息）保留为次级入口。
- **安装过程提示不空窗**：应用退出前显示应用内全屏「正在更新」提示层；随后由独立于安装目录的 Windows 进度窗（PowerShell WinForms，经 -EncodedCommand 启动，无临时脚本文件）持续显示「正在安装更新」，静默安装完成后该窗口关闭并自动拉起新版；编排过程记录在 `userData/updater/install-ui.log`。
- **手动更新**：同一页面保留「检查更新」「下载并安装」按钮作为兜底，点击「下载并安装」同样全自动——直接下载并静默安装，无中间确认、无安装向导，安装期间持续显示进度提示。
- **开关**：设置页「自动更新」开关即时生效（关闭会中断进行中的自动下载），状态持久化在 `config.json` 的 `autoUpdate` 字段。
- **边界**：便携版（portable）不参与自动更新；双击安装包本身仍走完整安装向导（`oneClick: false`，可选安装目录），只有应用内更新（自动与手动按钮）走静默参数。若安装时选择了「为所有用户安装」（Program Files），静默安装会触发一次 UAC 授权，属系统要求。
- **桌面快捷方式（源码模式）**：源码模式的启动程序是 Electron 官方 `electron.exe`——资源管理器与任务栏里显示的是 Electron 原子图标。构建/更新时由 `desktop/scripts/ensure-branded-exe.js` 在同一运行时目录复制一份带 Engram 图标的 `Engram.exe`（rcedit 打 `desktop/build/icon.ico`，`electron.exe` 原样保留，Electron 升级或重装依赖后按 mtime 自动重做），桌面快捷方式（以及已存在、且属于本安装的开始菜单快捷方式）指向它。桌面图标丢失或显示不对时，用 设置 → 连接与同步 → 软件更新 → 桌面端 → 「重建桌面快捷方式」重建；若 `Engram.exe` 正在运行（Windows 锁文件）无法覆盖，会提示退出后重试，更新脚本下次会自动补上。

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
- `preload.js`：通过 `window.wikiDesktop` 暴露受控 API（`getDataDir` / `chooseDataDir` / `restartServer` / `getLocalPort` / `setLocalPort` / `openFileBytes` / `desktopUpdateCheck` / `desktopUpdateDownload` / `desktopUpdateRunInstaller` / `desktopUpdateGetState` / `desktopUpdateSetAuto` / `desktopRebuildShortcut` / `getLaunchAtLogin` / `setLaunchAtLogin`，以及事件订阅 `onUpdateProgress` / `onUpdateState` / `onLaunchAtLoginState`），`contextIsolation` 开启。
- `scripts/lib/login-item.js`：开机自启登录项命令与状态判定的纯逻辑（单测 `scripts/tests/login-item.test.js`）。三个实测结论写在文件头：Electron **不替调用方给 path/args 加引号**（路径带空格会让开机启动直接失败，所以这里自己引）；注册表 Run 项**没有工作目录**（源码模式必须传 desktop 绝对路径，快捷方式那套 `args='.'` 用不了）；Windows 上 `wasOpenedAtLogin` 只在 macOS 有效（静默判定只能靠命令行里的 `--silent-start` 标记）。主进程用 `app.setLoginItemSettings`（显式 `name: 'Engram'`，避免落到 Electron 默认的 `electron.app.Electron` 值名上与其他 Electron 应用互踩）写/删注册表，用 `reg.exe query` 读回命令行（36.x 的 `getLoginItemSettings` 没有 `name` 选项，读不回显式命名的项）；**启动时自动对齐**：项在、但命令已过期（换过安装目录 / 旧版没写静默标记）就改写成当前命令，并保留用户在任务管理器里的禁用选择。
- `scripts/prepare-desktop.js`：打包前复制 server/web 产物并生成 server 运行时依赖清单。
- `scripts/lib/shortcut.js` + `scripts/ensure-branded-exe.js`：桌面快捷方式与「品牌化 Engram.exe」的共用逻辑（纯 Node，单测 `scripts/tests/shortcut.test.js`）。主进程的「重建桌面快捷方式」走 Electron 的 `shell.writeShortcutLink`（GUI 进程不能 spawn powershell：空句柄会静默秒退），PowerShell 安装/更新脚本则调 `ensure-branded-exe.js` 只做 exe 品牌化，快捷方式由 WScript.Shell 写。
- `scripts/pack-asar.js` + `scripts/lib/asar-staging.js`：手动生成 `app.asar` / `app.asar.unpacked`（绕过 Defender 锁 electron.exe 导致的 rename EPERM）。staging 清单必须覆盖主进程的相对引入（`lib/`、`scripts/lib/`）——少一个，安装版一启动就报 `Cannot find module`，而源码模式与 Docker 验证都发现不了；由 `scripts/tests/asar-staging.test.js` 锁住，`desktop/package.json` 的 `build.files` 同步含 `scripts/lib/**`。
- 原生模块：`better-sqlite3` 按 Electron ABI 重编；`sqlite-vec`（平台包 `sqlite-vec-windows-x64`）与 `@napi-rs/canvas` 用 Windows 预编译二进制，均通过 `asarUnpack` 解包以便加载。
- 桌面端默认关闭 ONLYOFFICE 在线编辑（`OFFICE_EDITOR_ENABLED=false`），Office 文件以本地预览或「用系统程序打开」替代。
