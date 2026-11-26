# 源码快装环境包（安装器自带，含完整 Git 源码态与运行时）

这个目录放 `pack-prebuilt-bundle.ps1` 生成的 zip。**打包时它会被塞进安装器 exe**（`installer/package.json`
的 `extraResources` → `resources\prebuilt`），安装器启动时检测到 zip 就自动走「免构建快装」：
直接解压覆盖本机目录，装完同时具备**完整单分支 `.git` 仓库 + 已构建运行时**，既不需要装机时长时间等待
`pnpm install` 与本地构建，装完也能直接作为标准源码版在应用内 `git pull` 拉取更新。

## 安装器必须带包（2026-11-26 起强制）

正式分发的安装器一律内置本包，并且部署引擎带 `-RequireBundle`：找不到包时**直接失败**，
不会退回「git clone + pnpm install + 本机构建」。

一条命令打完整套（打包 + 打 exe + 自检 exe 内确实带 `.git/HEAD` 与 `pnpm.cjs`、`.git/config` 无凭据且版本/提交与源码一致）：

```powershell
cd main
powershell -ExecutionPolicy Bypass -File scripts\build-customer-installer.ps1
# 产物：main\installer\dist\Engram-source-setup.exe
# 发布：node installer/scripts/publish-installer.js installer\dist\Engram-source-setup.exe
```

## 生成（只打环境包）

```powershell
cd main
powershell -ExecutionPolicy Bypass -File scripts\pack-prebuilt-bundle.ps1
```

默认产出 `installer/resources/prebuilt/engram-prebuilt-win-x64.zip`，同目录的
`engram-prebuilt-win-x64.zip.json` 是打包回执（版本、提交、sha256、是否含 Git/离线资源）。内容：

| 内容 | 说明 |
|---|---|
| 完整单分支 Git 仓库 | `.git`（仅含 `main` 分支与跟踪配置，绝不含任何账号/凭据）+ 仓库根文件（`CHANGELOG.md` / `README.md` 等）+ `main/` |
| 已构建产物 | `server/dist`、`web/dist`、`desktop/server/dist`、`desktop/web/dist` |
| Electron 运行时 | `desktop/node_modules/electron/dist`（品牌启动器 `Engram.exe`；`electron.exe` 由安装器复制出来，省一份 190MB） |
| 服务端运行时依赖 | `desktop/server/node_modules`（含 better-sqlite3 的 Electron ABI binding，打包时校验 ABI 一致） |
| 便携 Node & pnpm | `main/node/node.exe`、`main/pnpm/pnpm.cjs`（安装时落位到 `%LOCALAPPDATA%\engram\{node,pnpm}`，首次应用内更新即用来补装开发依赖） |
| 可选便携 MinGit | 打包机已有时一并打入 `mingit/` 并落位到 `%LOCALAPPDATA%\engram\MinGit` |
| 运行时依赖记录 | `desktop/server/node_modules/.engram-deps.json`（不写假的工作区依赖记录，首次更新按需补齐 `tsc`/`vite`） |
| 包清单 | `.engram-prebuilt.json`（`mode=source-bundle`、`git=true`、版本、提交号、打包时间、Electron / Node 版本） |
| 可选离线资源 | `offline/dsh/speech-to-text/sensevoice/models`、`offline/runtime/python`——只带本体，不带凭据/会话/用户数据 |

zip 与回执都不入库（见根 `.gitignore`）：它们是二进制发布产物，归档到 `releases/` 或随安装器发布。

## 用它

```powershell
# 直接装（客户机已有旧环境也能覆盖，自动保留旧 .git/config 更新源，数据目录不动）
powershell -ExecutionPolicy Bypass -File scripts\install-engram.ps1 -BundleZip <zip 路径>

# 或打成自带环境的安装器 exe
cd main
powershell -ExecutionPolicy Bypass -File scripts\build-customer-installer.ps1
```

## 注意

* 包与提交绑定：换了 main 的代码就要重新打一次包（`build-customer-installer.ps1` 会拦版本/提交不一致）。
* 安装后即是标准源码模式（`prebuilt: false`）：桌面端主进程会保留 `.git` 并在应用内启用「检查更新 / 更新并重启」，同时在设置页提供「Git 更新源」配置；只有**缺少 `.git` 的历史旧包安装**才会继续显示「预构建安装不含 Git」的兼容提示。
* `-RuntimeSource` 指向一台已跑通的源码模式安装目录（默认 `%LOCALAPPDATA%\engram\Engram\main`）。
* `-OfflineDataDir` 指向本机数据目录（默认 `%APPDATA%\@engram\desktop\data`）；需要把语音模型与 Python 运行时打进包时显式传 `-IncludeOfflineAssets`。
