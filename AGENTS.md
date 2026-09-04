# Engram 工作区入口

> 产品更名：**Engram**（2026-08，原名 ExampleProject）。本地检出目录仍为 `ExampleProject/`，Gitea 仓库与镜像路径改用 `engram`。运行时容器/服务已改名 `engram`（ONLYOFFICE 容器 `engram-onlyoffice`，自更新临时容器 `engram-update-switcher`/`engram-old`/`engram-net-probe`，环境变量 `ENGRAM_UPDATE_*`/`ENGRAM_PROBE_*`）；ONLYOFFICE 数据卷名 `example-wiki-onlyoffice-*` 保留（Docker 卷不可改名，改名即丢数据）；worktree 生命周期基建命名（`example-wiki:<feature>`、`com.exampleproject.feature` 标签）暂保留，待在途 worktree 清理后统一。

Git 工作目录位于当前 `ExampleProject/` 目录，使用以下布局：

* `main/`：主分支中的应用源码和集成入口
* `worktrees/`：独立任务 worktree；实际检出内容不纳入主工作目录版本控制
* `releases/`：发布快照和产物；不纳入 Git

处理 `main/` 或 `worktrees/` 下的任何仓库任务前，必须从仓库根目录完整读取：

1. [`main/AGENTS.md`](./main/AGENTS.md)
2. [`main/WORKTREES.md`](./main/WORKTREES.md)

Git 命令默认从当前 `ExampleProject/` 根目录执行。不要运行仍引用旧 `Wiki知识库` 路径的 worktree 脚本，也不要在 `releases/` 中开发。

Git 以本地管理为主，官方远端为 `gitea`（`https://github.com/jadesLL/Engram.git`，私有）。日常开发、合并、发版均在本地完成后按用户明确指示推送 gitea；不经用户批准不得推送到其他远端，也不得强制推送或改写远端历史。
推送 main 或 `v*` 标签到 gitea 会触发 Gitea Actions（`.gitea/workflows/`，详见 [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md)）：main 推送只跑 verify（build+typecheck+test），不构建镜像；镜像只在 `v*` 标签发版时由 release.yml 构建推送（版本 tag + latest），并额外构建 Windows 安装包发布 Release。CI 在 runner 上的联网下载属既定流程；本地开发机的下载申请限制不因此放宽。

### Gitea 发版工作流（摘要，细则见 main/docs/GITEA-CI.md）

1. 功能合并 main 后推送：`git push gitea main` → ci.yml 只做 verify（build+typecheck+test），不构建不推送镜像。
2. 发版：同步 bump 三处版本号（`main/desktop/package.json`、`main/web/src/version.ts`、`main/docker-compose.yml` 镜像 tag）→ 把距上次发布以来的**全部新功能**写入仓库根 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落（缺失该段落 release.yml 会直接失败）→ 提交推送 → `git tag v<版本> && git push gitea v<版本>` → release.yml 自动构建推送镜像（`:<版本>` + `:latest`），校验并提取 CHANGELOG 段落发布为 Gitea Release 正文（exe + docker tar.gz + sha256 附件）。
3. 从 Release 附件下载产物归档到 `releases/<版本>/`（含 release.json）。
4. **镜像地址固定三层路径** `gitea.example.com/example/engram/engram:<版本>`（owner/repo/imagename 归属仓库；两层 `owner/image` 形式 NAS 拉取异常，勿改回）。
5. 部署 compose 不得写 `pull_policy: never`（禁止拉取，本地无镜像必报找不到）。
下载任何环境需要的文件，需要先向用户申请，不允许私自下载。使用环境若不是必须，不要在代码库中安装环境，安装到本地环境不放在代码库。

完成任何功能后，必须先自行验证功能是否正确，并截取能够证明结果的界面或终端画面。验收完成后，向用户汇报改动、检查结果、截图、分支和提交信息，并明确询问用户选择「仅合并」「合并并推送远端」还是「合并并推送远端+发版」；没有用户对相应动作的明确批准，不得合并、推送或发版。用户批准合并后必须把合并结果同步推送到 gitea（`git push gitea main`），不得只合并不推送留下本地与远端分叉。

**截图必须直接发给用户**：验证用的每一张截图（界面/终端画面）不能只保存到磁盘就完事——保存归档的同时必须在汇报消息里附上图片（`Read` 图片文件后随汇报一起输出），并注明保存路径。用户不应该需要自己去目录里翻找验证截图。

版本号变更（bump）的提交完成后必须立即推送 gitea 远端并确认 CI 运行成功——版本号是镜像 tag 和 Release 标签的来源，留在本地会导致远端镜像与版本号脱节。

项目规则：

1.优先使用中文。
2.在功能和代码优化时，要兼顾desaktop和docker两个版本。同时软件内的版本号显示也要更改成最新版。
3.构建最新的安装包时要同步构建最新的同版本tar和win安装包，放入releases中相同版本号文件夹内
4.每次功能验收完成后，向用户询问「仅合并 / 合并并推送远端 / 合并推送+发版」三选一；合并后必须推送 gitea。
5.只要更新了版本号，提交后必须推送 gitea 远端（触发 CI 更新镜像 tag 与 latest），并确认 Actions 运行成功。
6.**每次功能合并进 main 时，同步把新功能整合进仓库根 `README.md`**（功能总览、使用说明、数据目录等对应章节；纯内部重构/CI 调整可只更新 CHANGELOG）。README 是 Gitea 仓库主页的展示位，不允许与实际功能漂移。
7.**每次发布新版本，必须把距上次发布以来的全部新功能写入仓库根 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落**，与版本号 bump 同一提交推送。release.yml 会校验该段落（缺失即发版失败），并自动把它发布为 Gitea Release 正文。
8.在 ZCode 中凡需要向用户提问（如验收后的「三选一」、方案选择、操作确认等），必须使用 AskUserQuestion 对话框列出选项让用户点选，不得用纯文本提问让用户手打回复；仅当对话框工具不可用时才退回文本提问。



## Windows 桌面端打包

桌面端安装包版本号与发布版本对齐（`desktop/package.json` 的 `version` 与 `releases/` 下最新版本号衔接，如当前 `1.1.6`）。产物写入 `releases/<version>/`，不纳入 Git。

打包在代码库外的本地目录进行（属第 17 行允许的宿主机原生任务），分两步走，绕过 Windows Defender 实时扫描锁定 `electron.exe` 导致的 `EPERM rename`：

**前置（每次改了 server/web 源码都要做，否则 asar 里是旧代码）**：`cd main/server && node ../node_modules/typescript/bin/tsc -p tsconfig.json` → `cd main/web && node ../node_modules/vite/bin/vite.js build`，确保 `server/dist`、`web/dist` 是最新产物。

1. **组装 win-unpacked**（不经 electron-builder 的 extract/rename）：

   * `pnpm build:desktop` 跑到 `electron-builder` 那步会因 Defender EPERM 失败，但此前 server/web 已 build、`prepare-desktop.js` 已复制产物、server 生产依赖已装、better-sqlite3 已重编（electron-builder 内置 `@electron/rebuild`，日志 `completed installing native dependencies` 即成功）。手动两步法不走 `build:desktop`，须自行先 build + `node desktop/scripts/prepare-desktop.js` 复制产物 + `pnpm -C desktop/server install --prod --node-linker=hoisted --ignore-workspace --no-frozen-lockfile` 装依赖 + 手动补 better-sqlite3 native（见下文关键坑）。
   * 手动解压 electron zip 到 `dist/win-unpacked`（`Expand-Archive` 直接解压，无 rename，不触发 Defender）：`powershell -Command "Expand-Archive electron-v35.7.5-win32-x64.zip dist/win-unpacked"`。解压后必须有 `electron.exe`（pack-asar 会重命名为 `Engram.exe`）。
   * 跑 `node desktop/scripts/pack-asar.js` 生成 `dist/win-unpacked/resources/app.asar` + `app.asar.unpacked/`：组装 staging（`main.js`/`preload.js`/`index.html` + `server` + `web/dist`）→ `@electron/asar` 打包，三个原生模块（better-sqlite3/sqlite-vec/@napi-rs/canvas）解包到 `app.asar.unpacked`。
2. **打 NSIS 安装包**（跳过 extract，直接打包已有 win-unpacked）：

```bash
   cd desktop \\\&\\\& pnpm exec electron-builder --prepackaged dist/win-unpacked --win nsis
   ```

* `--prepackaged` 跳过 electron 解压/rename，不触发 Defender 锁定；输出文件被扫描锁定时 electron-builder 自动 `waiting for unlock` 重试。
* 产出 `desktop/dist/Engram Setup <version>.exe`，复制到 `releases/<version>/` 并记录提交 ID、构建时间、sha256。

**关键坑**：

* **打包前必须重新 build server + web**：`prepare-desktop.js` 只复制 `main/server/dist` 和 `main/web/dist`，不会自动跑 tsc/vite。若 dist 是旧产物，打出的 exe 前端/后端就是旧版。流程：`cd main/server && tsc -p tsconfig.json` → `cd main/web && vite build` → 再 `prepare-desktop.js`。每次改了 server 或 web 源码都要重 build，否则 asar 里是旧代码。
* `zod` 必须 3.25.76（`@modelcontextprotocol/sdk@1.30` 的 zod-compat `import 'zod/v3'`，3.24.1 无 `./v3` exports 致 ESM 崩；`prepare-desktop.js` 已固定）。
* `pnpm -C desktop/server install` 需 `--node-linker=hoisted --ignore-workspace --no-frozen-lockfile`（hoisted 让原生模块为真实目录非 symlink，否则 asar 打包时 `@electron/asar` 对 unpack 的 symlink 在 `app.asar.unpacked` 重建会因非管理员无 symlink 权限失败；脱离 workspace + 避锁文件冲突），ignored builds 的 exit 1 用 `|| true` 容忍（better-sqlite3 由 electron-builder 内置 @electron/rebuild 重编）。
* **better-sqlite3 native 需手动补**：手动两步法不走 EB 的 @electron/rebuild，`pnpm --prod` 的 ignored builds 会让 `better-sqlite3/build/Release/better_sqlite3.node` 缺失，server 启动报 `Could not locate the bindings file`。修法：从主根 `main/node_modules/better-sqlite3/build/Release/better_sqlite3.node` 复制到 `desktop/server/node_modules/better-sqlite3/build/Release/`（N-API 跨 ABI，主根为 Node 22 编译的 ABI 133 = Electron 35 的 Node 22，兼容）。pack-asar 会自动把含 .node 的 better-sqlite3 目录解包到 `app.asar.unpacked`。
* **win-unpacked 必须从 electron zip 完整解压**：`pack-asar.js` 把 `electron.exe` 重命名为 `Engram.exe` 并往 `resources/` 塞 app.asar。若 win-unpacked 只有 resources/ 没有 electron.exe（如被误删），pack-asar 仍会跑但产出的 exe 无法启动。务必 `Expand-Archive electron-v35.7.5-win32-x64.zip dist/win-unpacked` 得到完整运行时后再 pack-asar。
* **EBUSY 锁 skia.node**：`Engram.exe` 测试后进程不退出会锁 `@napi-rs/canvas` 的 `skia.node`，再跑 pack-asar 报 `EBUSY`。修法：`taskkill /F /IM "Engram.exe"` 强杀 + `rm -rf app.asar app.asar.unpacked` 后重跑。
* `desktop/package.json` 设 `asar: true` + `asarUnpack` 解包三个原生模块；把上万 node\_modules 散文件合并进单个 `app.asar`，安装从逐文件写出变单归档解压，实测 243 秒→6 秒。asar 打包靠 `pack-asar.js`（EB 因 Defender EPERM 走不到 asar 阶段）；`node-linker=hoisted` 是前提（见上条）。
* sqlite-vec 在 asar 模式下 `load` 内部 `require.resolve` 返回 `app.asar` 虚拟路径，`better-sqlite3` 的 `loadExtension` 走 native dlopen 不经 asar fs 转换会失败；`server/src/lib/db.ts` 已把路径转成 `app.asar.unpacked` 真实路径（非 asar 环境 Docker/dev 原样工作）。**注意：改了 db.ts 后必须重 build server，否则 dist/lib/db.js 仍是旧的 `sqliteVec.load(db)` 无路径转换，本地模式必崩**。
* 本地模式默认端口 18180（避开 Docker 版的 18080，两者可共存）。若 18180 也被占需改 `LOCAL\\\_PORT` 或加端口回退。
* **端到端验证必做**：打包后不能只看 smoke test 不报错就认为通过。必须 `ELECTRON_RUN_AS_NODE=1 LLM\ Wiki.exe app.asar/server/dist/index.js` 实际 fork server，等 `/health` 返回 200，并从服务端 `curl /assets/SettingsView-*.js | grep 1.0.19` 确认前端版本号正确，才算通过。

