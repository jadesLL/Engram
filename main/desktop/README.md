# LLM Wiki Windows 桌面端（Electron）

桌面客户端，支持两种使用模式，可在「启动页 / 连接设置」中切换：

- **本地模式**：内嵌后端，所有数据保存在本机，无需任何服务器，开箱即用。适合离线、隐私或客户单机部署。
- **远端模式**：连接远端 LLM Wiki 服务（Docker 部署），凭「桌面端连接令牌」免密码登录。适合复用 NAS 上的集中数据。

相比浏览器额外提供**远程文件「用系统程序打开」**（下载到临时目录后调起 Word/WPS 等）。

## 使用

1. 首次启动进入启动页：
   - 选「使用本地」→ 直接进入本地模式（首次会初始化本地数据库与目录）。
   - 或在远端 Web 端「设置 → 桌面端连接」生成令牌，回桌面端填入服务器地址 + 令牌 → 连接。
2. 之后启动会记住上次模式，直接进入。
3. 切换模式：菜单「连接设置」回到启动页重新选择。

## 远端令牌

在远端服务的 Web 端「设置 → 桌面端连接」生成令牌（默认有效期 365 天，可随时撤销），令牌格式 `lwid_…`。桌面端用它调 `/api/auth/desktop-exchange` 免密兑换登录态，30 天有效，期间所有请求复用现有 cookie 鉴权。

## 重新构建

在仓库 `main/` 根目录执行（需联网下载 electron / electron-builder / 原生模块，届时申请 `--allow-downloads`）：

```bash
pnpm build:desktop
```

该命令依次：构建 server → 构建 web → 复制产物到 desktop/ → 装 server 生产依赖 → `@electron/rebuild` 重编 better-sqlite3 对 Electron ABI → `electron-builder` 产出 NSIS 安装包与便携版到 `desktop/dist/`。

## 技术说明

- `main.js`：主进程。双模式调度——本地 fork 内嵌 server 子进程（`ELECTRON_RUN_AS_NODE` 纯 Node 模式，探活后加载）；远端用 token 兑换 JWT 预置 cookie 后加载远端页面。
- `preload.js`：通过 `window.wikiDesktop` 暴露受控 API（`getConnection` / `setLocalMode` / `setRemoteMode` / `openConnectionSettings` / `openFileBytes`），`contextIsolation` 开启。
- `scripts/prepare-desktop.js`：打包前复制 server/web 产物并生成 server 运行时依赖清单。
- 原生模块：`better-sqlite3` 按 Electron ABI 重编；`sqlite-vec`（平台包 `sqlite-vec-windows-x64`）与 `@napi-rs/canvas` 用 Windows 预编译二进制，均通过 `asarUnpack` 解包以便加载。
- 本地模式默认关闭 ONLYOFFICE 在线编辑（`OFFICE_EDITOR_ENABLED=false`），Office 文件以本地预览或「用系统程序打开」替代；远端模式（Docker 版）保留完整协同编辑。
