# 预构建环境包（安装器自带，免联网免构建）

这个目录放 `pack-prebuilt-bundle.ps1` 生成的 zip。**打包时它会被塞进安装器 exe**（`installer/package.json`
的 `extraResources` → `resources\prebuilt`），安装器启动时检测到 zip 就自动走「免构建安装」：
直接解压覆盖客户机上的旧环境，不再 git 克隆、不装依赖、不构建、不联网。

## 安装器必须带包（2026-11-26 起强制）

正式发给客户的安装器一律内置本包，并且部署引擎带 `-RequireBundle`：找不到包时**直接失败**，
不会退回「git clone + pnpm install + 本机构建」。原因：固定链接上曾经有一个只带 Node/pnpm 运行时、
没带环境包的安装器，客户一装就要私有库凭据、拉 1 GB 依赖再自己构建，客户机上多半过不去。

一条命令打完整套（打包 + 打 exe + 自检 exe 内确实带包且版本/提交与源码一致）：

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

默认产出 `installer/resources/prebuilt/engram-prebuilt-win-x64.zip`（约 500–800 MB，视是否内置离线资源），
同目录的 `engram-prebuilt-win-x64.zip.json` 是打包回执（版本、提交、sha256、是否带离线资源），
安装界面的「内置运行环境 vX」就来自它。内容：

| 内容 | 说明 |
|---|---|
| 源码 | `git archive HEAD main`（无 `.git`、无临时目录、无凭据） |
| 已构建产物 | `server/dist`、`web/dist`、`desktop/server/dist`、`desktop/web/dist` |
| Electron 运行时 | `desktop/node_modules/electron/dist`（品牌启动器 `Engram.exe`；`electron.exe` 由安装器复制出来，省一份 190MB） |
| 服务端运行时依赖 | `desktop/server/node_modules`（含 better-sqlite3 的 Electron ABI binding，打包时校验 ABI 一致） |
| 便携 Node | `node/node.exe`（打包机 / 已装实例的 Node 20+，安装时落到 `%LOCALAPPDATA%\engram\node`，内置 Agent 与外部 CLI 都靠它） |
| 依赖指纹记录 | `node_modules/.engram-deps.json`、`desktop/server/node_modules/.engram-deps.json`（避免客户机判成「缺依赖记录」去联网重装） |
| 包清单 | `.engram-prebuilt.json`（版本、提交号、打包时间、Electron / Node 版本、是否带离线资源） |
| 可选离线资源 | `offline/dsh/speech-to-text/sensevoice/models`（语音模型）、`offline/runtime/python`（Python 共享运行时）——只带本体，不带凭据/会话/用户数据 |

zip 与回执都不入库（见根 `.gitignore`）：它们是二进制发布产物，归档到 `releases/` 或随安装器发布。

## 用它

```powershell
# 直接装（客户机已有旧环境也能覆盖，数据目录 %APPDATA%\@engram\desktop 不动）
powershell -ExecutionPolicy Bypass -File scripts\install-engram.ps1 -BundleZip <zip 路径>

# 或打成自带环境的安装器 exe
cd main
powershell -ExecutionPolicy Bypass -File scripts\build-customer-installer.ps1
```

## 注意

* 包与提交绑定：换了 main 的代码就要重新打一次包（`build-customer-installer.ps1` 会拦版本/提交不一致）。
* 预构建安装**不使用 git**：安装器会把旧 `.git` 删掉，应用内「检查更新」不再能拉源码，
  更新方式是重新跑新安装器。应用主进程会读 `main/.engram-prebuilt.json` 识别这种安装：
  设置页直接说明「请用新版安装器覆盖安装」，不再按源码模式跑 git 检查。
* `-RuntimeSource` 指向一台已跑通的源码模式安装目录（默认 `%LOCALAPPDATA%\engram\Engram\main`）：
  Electron 运行时与服务端运行时依赖取自那里，故打包机必须是「装过、跑过」的机器。
* `-OfflineDataDir` 指向本机数据目录（默认 `%APPDATA%\@engram\desktop\data`）：那里的语音模型
  与 Python 运行时会一并打进包；不想带加 `-SkipOfflineAssets`。
