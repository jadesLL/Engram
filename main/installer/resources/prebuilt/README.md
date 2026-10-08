# 预构建环境包（安装器自带，免构建）

这个目录放 `pack-prebuilt-bundle.ps1` 生成的 zip。**打包时它会被塞进安装器 exe**（`installer/package.json`
的 `extraResources` → `resources\prebuilt`），安装器启动时检测到 zip 就自动走「免构建安装」：
直接解压覆盖客户机上的旧环境，不再 git 克隆、不装依赖、不构建。

## 生成

```powershell
cd main
powershell -ExecutionPolicy Bypass -File scripts\pack-prebuilt-bundle.ps1
# 等价：pnpm -C installer run pack-prebuilt
```

默认产出 `installer/resources/prebuilt/engram-prebuilt-win-x64.zip`（约 350~400 MB），内容：

| 内容 | 说明 |
|---|---|
| 源码 | `git archive HEAD main`（无 `.git`、无临时目录、无凭据） |
| 已构建产物 | `server/dist`、`web/dist`、`desktop/server/dist`、`desktop/web/dist` |
| Electron 运行时 | `desktop/node_modules/electron/dist`（品牌启动器 `Engram.exe`；`electron.exe` 由安装器复制出来，省一份 190MB） |
| 服务端运行时依赖 | `desktop/server/node_modules`（含 better-sqlite3 的 Electron ABI binding） |
| 依赖指纹记录 | `node_modules/.engram-deps.json`、`desktop/server/node_modules/.engram-deps.json`（避免客户机判成「缺依赖记录」去联网重装） |
| 包清单 | `.engram-prebuilt.json`（提交号、打包时间、Electron 版本） |

zip 本身不入库（见根 `.gitignore`）：它是二进制发布产物，归档到 `releases/` 或随安装器发布。

## 用它

```powershell
# 直接装（客户机已有旧环境也能覆盖，数据目录 %APPDATA%\@engram\desktop 不动）
powershell -ExecutionPolicy Bypass -File scripts\install-engram.ps1 -BundleZip <zip 路径>

# 或打成自带环境的安装器 exe：把 zip 放进本目录后
cd main
pnpm -C installer dist        # → installer/dist/Engram-source-setup.exe（体积约等于 zip）
```

## 注意

* 包与提交绑定：换了 main 的代码就要重新打一次包，否则客户机装到的是旧代码。
* 预构建安装**不使用 git**：安装器会把旧 `.git` 删掉，应用内「检查更新」不再能拉源码，
  更新方式是重新跑新安装器（或换用打包版 exe）。
* `-RuntimeSource` 指向一台已跑通的源码模式安装目录（默认 `%LOCALAPPDATA%\engram\Engram\main`）：
  Electron 运行时与服务端运行时依赖取自那里，故打包机必须是「装过、跑过」的机器。
