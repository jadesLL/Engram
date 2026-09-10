# Engram 工作区入口

> 仓库根目录为 `Engram/`；Gitea 仓库、镜像路径、运行时容器与 Docker 卷统一使用 `engram` 命名；ONLYOFFICE 数据卷 `engram-onlyoffice-*` 不可改名（Docker 卷改名即丢数据）；worktree 基建命名统一为 `engram:<feature>` 与 `com.engram.feature` 标签。

## 目录与必读

* `main/`：主分支应用源码和集成入口；`worktrees/`：独立任务 worktree（不入主目录版本控制）；`releases/`：发布产物（不入 Git）。
* 处理 `main/` 或 `worktrees/` 下任何任务前，必须从仓库根目录完整读取 [`main/AGENTS.md`](./main/AGENTS.md) 和 [`main/WORKTREES.md`](./main/WORKTREES.md)。
* Git 命令从仓库根目录执行。不要运行仍引用旧 `Wiki知识库` 路径的 worktree 脚本，不要在 `releases/` 中开发。

## Git 远端与 CI

官方远端为 `gitea`（`https://github.com/jadesLL/Engram.git`，私有）。开发、合并、发版均在本地完成后按用户明确指示推送 gitea；不经批准不推其他远端，不强推或改写远端历史。

推送 main 或 `v*` 标签触发 Gitea Actions（详见 [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md)）：main 推送只跑 verify（build+typecheck+test）；镜像只在 `v*` 发版时由 release.yml 构建推送（版本 tag + latest）并创建 Release（正文=CHANGELOG 段落，无二进制附件）；exe/APK/离线 tar.gz 不随发版构建，需要分发时手动 dispatch release.yml（输入标签+勾选产物）按需构建并补挂到对应 Release（2026-09-08 起对齐 Hermes 式发版）。CI runner 的联网下载属既定流程，本地开发机的下载限制不因此放宽。

发版流程（细则见 main/docs/GITEA-CI.md）。发版是显式动作：仅当用户要求产出镜像/exe/APK 给他人时执行，日常迭代不发版：

1. 功能合并 main 后推送：`git push gitea main` → ci.yml 只做 verify。
2. 发版：同步 bump 三处版本号（`main/desktop/package.json`、`main/web/src/version.ts`、`main/docker-compose.yml` 镜像 tag）→ 把距上次发布的**全部新功能**写入仓库根 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落（缺失则 release.yml 直接失败）→ 提交推送 → `git tag v<版本> && git push gitea v<版本>` → release.yml 自动构建推送镜像并发布 Gitea Release（正文=CHANGELOG 段落，无二进制附件）。
3. 需要分发 exe/APK/离线 tar.gz 时（按需，不随发版）：Actions → Release → Run workflow，输入标签+勾选产物，构建后自动补挂 Release；Windows exe 也可按「Windows 桌面端打包」本地打包。产物归档到 `releases/<版本>/`（含 release.json）。
4. 镜像地址固定三层路径 `gitea.example.com/example/engram/engram:<版本>`（两层 `owner/image` 形式 NAS 拉取异常，勿改回）。
5. 部署 compose 不得写 `pull_policy: never`。

下载任何环境需要的文件必须先向用户申请，不允许私自下载；环境安装到本地，不放进代码库。

## 验收与合并

完成功能后必须自行验证并截取能证明结果的界面或终端画面。**截图必须直接发给用户**：归档保存的同时在汇报消息里附上图片（`Read` 图片文件随汇报输出），并注明保存路径，不能只给路径让用户翻目录。汇报改动、检查结果、截图、分支和提交信息后，询问用户「仅合并 / 合并并推送远端 / 合并并推送远端+发版」三选一；没有明确批准不得合并、推送或发版。批准合并后必须同步推送 gitea（`git push gitea main`），不得留下本地与远端分叉。版本号 bump 的提交完成后必须立即推送并确认 CI 成功——版本号是镜像 tag 和 Release 标签的来源，留在本地会与远端脱节。

## 项目规则

1. 优先使用中文。
2. 功能和代码优化要兼顾 desktop 和 docker 两个版本。版本号节奏参照 hermes-agent：日常开发只合 main，不 bump 版本号、不发产物——自用机器走源码模式（桌面快捷方式或 `main/scripts/update-from-source.ps1`，新机器用 `main/scripts/install-engram.ps1`（或其打包的安装器 exe）一键装环境+克隆+构建+快捷方式；应用内「检查更新」即增量拉源码重建）。三处版本号仅在用户明确要求发版时 bump。
3. 按需构建的安装包/离线包（exe/APK/tar.gz）归档到 `releases/` 相同版本号文件夹，记录提交 ID、构建时间、sha256；Docker 镜像走 Registry 不重复归档。
4. 每次功能验收完成后询问「仅合并 / 合并并推送远端」两选一，默认推荐合并并推送（推送后源码模式客户端即可更新）；发版是显式动作，仅当用户明确提出时才执行（见下方发版流程）。合并后必须推送 gitea。
5. 只要更新了版本号，提交后必须立即推送 gitea（触发 CI 更新镜像 tag 与 latest），并确认 Actions 运行成功。
6. 功能合并进 main 时同步把新功能整合进仓库根 `README.md`（功能总览、使用说明、数据目录等；纯内部重构/CI 调整可只更新 CHANGELOG）。
7. 发布新版本时，距上次发布的全部新功能写入 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落，与 bump 同一提交推送。
8. 在 ZCode 中凡需向用户提问（三选一、方案选择、操作确认等），必须用 AskUserQuestion 对话框点选，不得纯文本提问；仅当工具不可用时退回文本。

## Windows 桌面端打包

**仅当用户明确要求生成安装包时才打包，其余时候一律不打包**：exe 安装包已不随 CI 发版自动构建（2026-09-08 起），按需分发走 CI dispatch 或本节手动流程二选一；自用机器日常更新走源码模式（`powershell -File main/scripts/update-from-source.ps1`，合 main 即更新，见脚本头部说明），不产生安装包。

安装包版本号与发布版本对齐（`desktop/package.json`），产物写入 `releases/<version>/`。因 Windows Defender 实时扫描锁定 `electron.exe` 导致 `EPERM rename`，不走 `pnpm build:desktop`，分两步手动打包：

**前置**（每次改了 server/web 源码都必做，否则 asar 里是旧代码）：`cd main/server && node ../node_modules/typescript/bin/tsc -p tsconfig.json` → `cd main/web && node ../node_modules/vite/bin/vite.js build` → `node desktop/scripts/prepare-desktop.js` 复制产物。

1. **组装 win-unpacked**：
   * `pnpm -C desktop/server install --prod --node-linker=hoisted --ignore-workspace --no-frozen-lockfile`（ignored builds 的 exit 1 用 `|| true` 容忍）。
   * 手动补 better-sqlite3 native：从 `main/node_modules/better-sqlite3/build/Release/better_sqlite3.node` 复制到 `desktop/server/node_modules/better-sqlite3/build/Release/`（缺失则 server 启动报 `Could not locate the bindings file`）。
   * 完整解压 electron 运行时：`powershell -Command "Expand-Archive electron-v35.7.5-win32-x64.zip dist/win-unpacked"`——必须得到含 `electron.exe` 的完整目录，否则 pack-asar 仍会跑但产出的 exe 无法启动。
   * `node desktop/scripts/pack-asar.js` 生成 `resources/app.asar` + `app.asar.unpacked/`，三个原生模块（better-sqlite3/sqlite-vec/@napi-rs/canvas）解包（`desktop/package.json` 已设 `asar: true` + `asarUnpack`）。
2. **打 NSIS 安装包**：`cd desktop && pnpm exec electron-builder --prepackaged dist/win-unpacked --win nsis`，产出 `Engram Setup <version>.exe`，复制到 `releases/<version>/` 并记录提交 ID、构建时间、sha256。

**关键坑**：

* `node-linker=hoisted` 必须带：否则原生模块是 symlink，asar 解包重建因非管理员无 symlink 权限失败。
* `zod` 必须 3.25.76（旧版无 `zod/v3` exports 致 MCP SDK ESM 崩，`prepare-desktop.js` 已固定）。
* `Engram.exe` 测试后不退出会锁 `@napi-rs/canvas` 的 `skia.node`，再跑 pack-asar 报 EBUSY：`taskkill /F /IM "Engram.exe"` 强杀 + 删 `app.asar`/`app.asar.unpacked` 后重跑。
* sqlite-vec 在 asar 下 `loadExtension` 需真实路径：`server/src/lib/db.ts` 已把路径转成 `app.asar.unpacked`；**改了 db.ts 必须重 build server**，否则本地模式必崩。
* 本地模式默认端口 18180（Docker 版 18080，可共存）；被占需改 `LOCAL_PORT` 或加端口回退。
* 端到端验证必做：`ELECTRON_RUN_AS_NODE=1 <exe> app.asar/server/dist/index.js` 实际 fork server，等 `/health` 返回 200，并 `curl /assets/SettingsView-*.js` 确认前端版本号为当前版本，才算通过。
