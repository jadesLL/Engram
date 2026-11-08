# Engram 工作区入口

> 仓库根目录为 `Engram/`；Gitea 仓库、镜像路径、运行时容器与 Docker 卷统一使用 `engram` 命名；ONLYOFFICE 数据卷 `engram-onlyoffice-*` 不可改名（Docker 卷改名即丢数据）；worktree 基建命名统一为 `engram:<feature>` 与 `com.engram.feature` 标签。

## 目录与必读

* `main/`：主分支应用源码和集成入口；`worktrees/`：独立任务 worktree（不入主目录版本控制）；`releases/`：发布产物（不入 Git）。
* 处理 `main/` 或 `worktrees/` 下任何任务前，必须从仓库根目录完整读取 [`main/AGENTS.md`](./main/AGENTS.md) 和 [`main/WORKTREES.md`](./main/WORKTREES.md)。
* 跨端功能（server / web / desktop / mobile 任一改动）、Android 适配或发版相关任务，还必须先读 [`main/docs/PLATFORM-PARALLEL-DEV.md`](./main/docs/PLATFORM-PARALLEL-DEV.md)（三端并行规范：设计理念、平台契约、A–F 分类、同步节奏与门禁）。
* Git 命令从仓库根目录执行。不要运行仍引用旧 `Wiki知识库` 路径的 worktree 脚本，不要在 `releases/` 中开发。

## Git 远端与 CI

官方远端为 `gitea`（`https://github.com/jadesLL/Engram.git`，私有）。开发、验收与合并都在本地完成（验收通过后**自动合并**进 main，见「验收与合并」与项目规则 4/10）；**推送 gitea 与发版必须经用户明确批准**，未批准不推送、不打 tag。不经批准不推其他远端，不强推或改写远端历史。

推送 main 或 `v*` 标签触发 Gitea Actions（详见 [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md)）：main 推送跑 verify（build+typecheck+test）并构建推送**主分支滚动镜像 `:main`**（发版前的测试通道，合 main 即更新）；版本 tag 与 `:latest` 只在 `v*` 发版时由 release.yml 构建推送并创建 Release（正文=CHANGELOG 段落）；exe/APK 是每次发版的固定交付，推完 tag 后必须 dispatch release.yml（输入本次标签+勾选 binaries）构建并补挂到对应 Release（2026-09-27 起，取代 2026-09-08 的「二进制不随发版、按需分发」口径，见项目规则 9）；同一趟 dispatch 还会把产物同步到**公开仓库（GitHub）同名 Release** 作为公开下载入口（2026-09-30 起，历史版本用 `github_backfill` 回填，见 GITEA-CI.md 的「公开仓库产物同步」）；离线 tar.gz 等额外产物仍按需分发。CI runner 的联网下载属既定流程，本地开发机的下载限制不因此放宽。

发版流程（细则见 main/docs/GITEA-CI.md）。发版是显式动作：仅当用户要求发版时执行，日常迭代不发版；一旦发版就必须按项目规则 9 交付三件套（Android 端 + Windows 桌面版 + Docker 镜像）：

1. 功能合并 main 后推送：`git push gitea main` → ci.yml 跑 verify 并推送滚动镜像 `:main`（测试部署可切「更新通道 → main」跟主分支）。
2. 发版：先跑 `bash main/scripts/platform-parity-check.sh --strict` 并确认手机滞后清单目标版本已清零（规范见 `main/docs/PLATFORM-PARALLEL-DEV.md`）；然后同步 bump 三处版本号（`main/desktop/package.json`、`main/web/src/version.ts`、`main/docker-compose.yml` 镜像 tag）→ 把距上次发布的**全部新功能**写入仓库根 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落（缺失则 release.yml 直接失败）→ 提交推送 → `git tag v<版本> && git push gitea v<版本>` → release.yml 自动构建推送镜像并发布 Gitea Release（正文=CHANGELOG 段落）。
3. **补齐三件套的另外两件（每次发版必做，不是按需）**：Actions → Release → Run workflow，输入本次标签 + 勾选 `binaries`（Windows exe + Android APK，构建后自动补挂到对应 Release，并同步到公开仓库 GitHub 同名 Release）；Windows exe 也可按下方「Windows 桌面端打包」本地打包。APK 必须基于本次发版提交构建、版本号与发版一致（禁止复用旧包），并发版说明要按项目规则 9 补齐安卓端自上次更新以来的全部内容。产物归档到 `releases/<版本>/`（含 release.json）。离线 tar.gz（`offline_image`）属额外产物，仍按需 dispatch。
4. 镜像地址固定三层路径 `gitea.example.com/example/engram/engram:<版本>`（两层 `owner/image` 形式 NAS 拉取异常，勿改回）。
5. 部署 compose 不得写 `pull_policy: never`。

下载任何环境需要的文件必须先向用户申请，不允许私自下载；环境安装到本地，不放进代码库。

## 验收与合并

完成功能后必须自行验证并截取能证明结果的界面或终端画面。**截图必须直接发给用户**：归档保存的同时在汇报消息里附上图片（`Read` 图片文件随汇报输出），并注明保存路径，不能只给路径让用户翻目录。汇报改动、检查结果、截图、分支和提交信息，并把改动提交到功能分支后，**自动合并进 main**：不再为「是否合并」征求批准，但合并仍走既有串行流程（worktree 任务走 `main/scripts/merge-feature.sh`），冲突且双方意图不明时停下问用户。合并后检查通过即按规则 10 自动清理功能分支、worktree 与 Docker 功能资源，复验零残留；随后用弹窗问用户「仅本地保留 / 推送 gitea / 推送并发版」（推荐推送）——**推送与发版都必须拿到明确批准**，未批准不推送、不 bump 版本号、不打 tag、不部署。获批推送后立即 `git push gitea main` 并确认 CI；版本号 bump 的提交完成后必须立即推送并确认 CI 成功——版本号是镜像 tag 和 Release 标签的来源，留在本地会与远端脱节。用户选择暂不推送时本地会领先远端，下次任务开始前再确认一次是否补推。

## 三端并行开发（Windows 主开发 · Docker 同源 · Android 定期对齐）

Engram 是「一套产品内核 + 三个运行壳」：`main/server` + `main/web` 是唯一事实源；Windows 桌面端与 Docker 共用同一份源码与 UI，**Docker 不做代码移植**；Android 复用同一份 Web 构建，但操作逻辑按触屏重做、需定期对齐。完整规范、平台契约、同步节奏与检查清单见 [`main/docs/PLATFORM-PARALLEL-DEV.md`](./main/docs/PLATFORM-PARALLEL-DEV.md)，跨端任务必须遵守。

- **先分类再动手**：按规范 §4.1 把功能标为 A–F（纯服务端+窄代理 / Web 通用 / 移动布局手势返回 / 原生桥 / 手机不做 / 同步数据面）；A/C/D/F 必须有手机侧动作。
- **适配尽量同分支**：Android 适配与共享代码尽量在同一个 `feat/<feature>` 完成；确实滞后的登记 [`main/docs/MOBILE-SYNC-LEDGER.md`](./main/docs/MOBILE-SYNC-LEDGER.md) 并写目标版本，最迟下次发版前清零。
- **提交声明**：提交信息末行写 `平台影响: A`（跨类用 `平台影响: B,F`；无平台影响写 `none`）。未声明按 C 处理。
- **每周巡检 + 发版门禁**：每周跑一次 `bash main/scripts/platform-parity-check.sh --since <上次 ref>`；发版前用 `--strict` 并完成规范 §5.5 全量对齐门禁。
- **验收分工**：Windows 主验收（桌面形态）、Docker 同源验证、Android 真机/模拟器验收；三端清单见规范 §4.4–4.6。

## 项目规则

1. 优先使用中文。
2. 功能和代码优化要兼顾 Windows 桌面端、Docker 与 Android 三端（Windows/Docker 同一份源码，Android 复用同一份 Web 构建 + 壳层适配；平台影响分类与同步节奏见 `main/docs/PLATFORM-PARALLEL-DEV.md`）。版本号节奏参照 hermes-agent：日常开发只合 main，不 bump 版本号、不发产物——自用机器走源码模式（桌面快捷方式或 `main/scripts/update-from-source.ps1`，新机器用 `main/scripts/install-engram.ps1`（或其打包的安装器 exe）一键装环境+克隆+构建+快捷方式；应用内「检查更新」即增量拉源码重建）。三处版本号仅在用户明确要求发版时 bump。
3. 安装包（exe/APK）每次发版必备，归档到 `releases/` 相同版本号文件夹，记录提交 ID、构建时间、sha256；离线包（tar.gz）等额外产物按需构建后同样归档；Docker 镜像走 Registry 不重复归档。
4. **验收通过即自动合并进 main，不再问「是否合并」；推送与发版必须先问用户**：合并是本地动作（仍串行执行，冲突且意图不明时停下问用户），合并后检查通过即自动清理功能分支、worktree 与 Docker 功能资源；随后用弹窗问「仅本地保留 / 推送 gitea / 推送并发版」（推荐推送，推送后源码模式客户端即可更新）；未获批准不推送、不 bump 版本号、不打 tag、不部署。发版是显式动作，仅当用户明确提出时才执行（见下方发版流程）。
5. 只要更新了版本号，提交后必须立即推送 gitea（触发 CI 更新镜像 tag 与 latest），并确认 Actions 运行成功。
6. 功能合并进 main 时同步把新功能整合进仓库根 `README.md`（功能总览、使用说明、数据目录等；纯内部重构/CI 调整可只更新 CHANGELOG）。
7. 发布新版本时，距上次发布的全部新功能写入 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落，与 bump 同一提交推送。
8. **凡需用户拍板的事一律弹窗点选**（是否推送、是否发版、方案选择、操作确认等），必须用当前 Agent 自带的结构化提问组件让用户点选，不得纯文本提问，更不得替用户默认决定；组件确实不可用时才退回在对话正文提问并停下等答复。各 Agent 对应关系：ZCode 桌面端 / Claude Code → `AskUserQuestion`；DeepSeek Harness（dsh，含本仓库的 DSH 会话）→ `ask_user_question`（弹窗点选）；Engram 内置 Agent（聊天抽屉里的 dsh）→ `engram ask`（CLI 阻塞长轮询，问题弹在对话最下侧的选项框；外部 Agent 不要用，它等的是 Engram 界面）；Codex CLI 等没有结构化提问组件的客户端 → 在对话正文列出编号选项并停下等答复。
9. **发版只在用户明确提出时进行；一旦发版就固定发三件套**：① Android 端（APK）② Windows 版桌面端（exe）③ Docker 镜像（`:<版本>` + `:latest`）——三件缺一即视为本次发版未完成（离线 tar.gz 等额外产物仍按需）。**安卓端要补齐「距上次更新之间的全部更新内容」**：APK 必须基于本次发版提交构建、版本号与发版一致，不得复用旧包；发版说明（`CHANGELOG.md` 对应段落与 Release 正文）里安卓部分必须写全自上一个安卓版本以来**累积**的所有改动——安卓端只能靠安装包更新（不能源码模式自更新），可能一次跨过多个版本，因此不能只写本版增量。安卓端要同步补上这段区间内桌面/Docker 端已有的功能（最新代码对齐），不能让手机端停在旧版本。
10. **自动合并与自动清理**：已验收、已提交的功能分支合并进 main，并且合并后检查通过后，必须立即自动删除已合并的功能分支、对应 worktree，以及该任务的全部 Docker 容器、镜像、数据卷、网络和 Git `safe.directory` 记录；不得等待用户确认推送，不再询问是否清理。worktree 任务执行 `main/scripts/merge-feature.sh --cleanup <feature>`；补清理旧任务执行 `main/scripts/cleanup-feature.sh <feature>`。清理后必须复验，任一资源残留都要报告「清理失败/尚未完成」，不能只删分支就结束。合并仍串行执行，工作区须干净；未合并、未提交、检查失败或冲突意图不明时保留资源并报告原因。仅当用户明确要求继续保留某个预览环境供检查时才暂缓该任务清理。主运行环境、主数据、ONLYOFFICE 数据卷、共享基础镜像和构建缓存、其他任务资源不属于清理范围，禁止使用全局 prune。推送 gitea、bump 三处版本号、打 `v*` tag、发版与补齐 APK/exe、部署（`--deploy` / 刷新主环境）仍必须先弹窗取得明确批准。
11. **三端并行与单一事实源**：Windows 桌面端与 Docker 共用同一份 `main/server` + `main/web` 源码，Docker 不得另起实现；Android 复用同一份 Web 构建并在壳层适配。设计语言（令牌、图标、信息架构）只有一个来源；平台差异只能落在能力位 / 窗口尺寸档 / 页面断点 / 原生桥 / 同步协议五类显式契约上，禁止 UA、平台字符串或宽度猜测造成的隐式分叉。完整规范见 [`main/docs/PLATFORM-PARALLEL-DEV.md`](./main/docs/PLATFORM-PARALLEL-DEV.md)。
12. **平台影响声明与手机对齐**：任何合并进 main 的功能（纯文档/CI 除外）必须在提交信息末行声明 `平台影响:`；标为 A/C/D/F 的必须在同一分支或紧邻 follow-up 完成手机适配，未完成的登记 [`main/docs/MOBILE-SYNC-LEDGER.md`](./main/docs/MOBILE-SYNC-LEDGER.md)，最迟下次发版前清零。每周做一次手机端巡检，每次发版做全量对齐（含安卓累积更新说明）。
13. **三端一致性与产物门禁**：verify 必须通过（含 `web/src/lib/platformParity.test.ts` 的版本号/能力位/原生桥/构建链/设置域/滞后清单检查）；发版前必须跑 `bash main/scripts/platform-parity-check.sh --strict`；打 exe/APK 前必须用本次源码重新构建 web 产物（禁止复用旧 `dist`）；三件套与安卓累积更新说明缺一不发（见规则 9）。

## Windows 桌面端打包

**发版时必须打包（三件套之一，见项目规则 9），非发版的日常迭代一律不打包**：exe 不随 CI 发版自动构建（2026-09-08 起），发版时走 CI dispatch（勾选 `binaries`）或本节手动流程二选一；自用机器日常更新走源码模式（`powershell -File main/scripts/update-from-source.ps1`，合 main 即更新，见脚本头部说明），不产生安装包。

安装包版本号与发布版本对齐（`desktop/package.json`），产物写入 `releases/<version>/`。因 Windows Defender 实时扫描锁定 `electron.exe` 导致 `EPERM rename`，不走 `pnpm build:desktop`，分两步手动打包：

**前置**（每次改了 server/web 源码都必做，否则 asar 里是旧代码）：`cd main/server && node ../node_modules/typescript/bin/tsc -p tsconfig.build.json` → `cd main/web && node ../node_modules/vite/bin/vite.js build` → `node desktop/scripts/prepare-desktop.js` 复制产物（构建走 `tsconfig.build.json`：不产出 `*.test.js`，测试文件不进安装包）→ `node desktop/scripts/prepare-node-runtime.js` 生成随包 Node（`desktop/node/node.exe`；本地默认复制本机 Node，CI 用 `--download` 按固定版本下载，原因见下方「内置 Agent 运行时」坑条）。

1. **组装 win-unpacked**：
   * `pnpm -C desktop/server install --prod --node-linker=hoisted --ignore-workspace --no-frozen-lockfile`（ignored builds 的 exit 1 用 `|| true` 容忍）。
   * better-sqlite3 native 的 ABI 必须匹配打包进去的 Electron：用 `node desktop/scripts/sync-deps.js server` 取对应 ABI 的 prebuild（它直接问 Electron 运行时要 `process.versions.modules`）；**不要**直接从 `main/node_modules/better-sqlite3/build/Release/` 拷——那是系统 Node 的 ABI，装进 exe 会 `ERR_DLOPEN_FAILED`（v1.3.0 事故同类）。
   * 完整解压 electron 运行时：`powershell -Command "Expand-Archive electron-v36.9.5-win32-x64.zip dist/win-unpacked"`——必须得到含 `electron.exe` 的完整目录，否则 pack-asar 仍会跑但产出的 exe 无法启动。
   * `node desktop/scripts/pack-asar.js` 生成 `resources/app.asar` + `app.asar.unpacked/`：`server/**` 整棵解包（内置 Agent 的 dsh 由真实 Node 拉起，真实 Node 读不了 asar；`desktop/package.json` 已设 `asar: true` + `asarUnpack: server/**`），并把 `desktop/node/node.exe` 复制到 `resources/node/node.exe`（随包 Node 运行时）。
2. **打 NSIS 安装包**：先 `node desktop/scripts/verify-packaged-abi.js --app-dir dist/win-unpacked` 确认原生模块 ABI 与 Electron 一致，再 `cd desktop && pnpm exec electron-builder --prepackaged dist/win-unpacked --win nsis`，产出 `Engram Setup <version>.exe`，复制到 `releases/<version>/` 并记录提交 ID、构建时间、sha256。

**关键坑**：

* `node-linker=hoisted` 必须带：否则原生模块是 symlink，asar 解包重建因非管理员无 symlink 权限失败。
* **原生模块 ABI 必须与打包进去的 Electron 一致**（2026-09-28 v1.3.0 事故根因）：CI 打包脚本把 better-sqlite3 预编译写死成 `electron-v133`，而 Electron 已于 9-16 升到 36（ABI 135），发布出去的 1.3.0 exe 内嵌 server 一启动就 `NODE_MODULE_VERSION 133 vs 135` 退出，**所有装了 1.3.0 的机器都停在「本地服务启动失败」**。现在 ABI 一律由**实际打包的 Electron 版本**推导（`desktop/scripts/lib/electron-abi.js`，表兜底 + node-abi 权威），打包后静态校验 `.node` 里的 `node_register_module_v<ABI>` 符号（`desktop/scripts/verify-packaged-abi.js`）；CI（`scripts/build-desktop-ci.sh`）与手动 `pack-asar.js` 都已接上这一步，校验失败即打包失败。
* **内置 Agent（dsh）必须用「真实 Node」跑，不能用 Electron 的纯 Node 模式**（2026-10-22 控制台「进程提前退出 code 1」根因）：dsh 的 `node-addon-require-builtin` 只认 Electron 43/44/44.7/45 的 V8 指纹，Electron 36 直接 `Unsupported/no-context`。所以安装包必须带 `resources/node/node.exe`（`prepare-node-runtime.js` + `extraResources`），且 `asarUnpack` 必须含 `server/**`（真实 Node 读不了 asar，dsh 入口要在 `app.asar.unpacked/server/node_modules/@deepseek-ai/dsh/lib/bin.js`）；server 侧 `assistant/agentNode.ts` 会校验 Node >=20 并覆盖 `process.execPath`（聊天 SDK 把命令硬编码成 `process.execPath`）。CI（`build-desktop-ci.sh`）打包后会断言 `resources/node/node.exe` 与解包后的 dsh 都在。
* `zod` 必须 3.25.76（旧版无 `zod/v3` exports，server 会崩；`prepare-desktop.js` 已固定）。
* `Engram.exe` 测试后不退出会锁 `@napi-rs/canvas` 的 `skia.node`，再跑 pack-asar 报 EBUSY：`taskkill /F /IM "Engram.exe"` 强杀 + 删 `app.asar`/`app.asar.unpacked` 后重跑。
* sqlite-vec 在 asar 下 `loadExtension` 需真实路径：`server/src/lib/db.ts` 已把路径转成 `app.asar.unpacked`；**改了 db.ts 必须重 build server**，否则本地模式必崩。
* 本地模式默认端口 18180（Docker 版 18080，可共存）；被占需改 `LOCAL_PORT` 或加端口回退。
* 端到端验证必做：`ELECTRON_RUN_AS_NODE=1 <exe> app.asar/server/dist/index.js` 实际 fork server，等 `/health` 返回 200，并 `curl /assets/SettingsView-*.js` 确认前端版本号为当前版本，才算通过。
* 内置 Agent 控制台也要按真实路径验一次：打开 设置 → Agent 与自动化 →「内置 Agent 控制台」，状态栏应显示运行中且 iframe 加载出 DSH 界面；server 日志有 `[agent] dsh 运行时 Node：…\resources\node\node.exe` 一行。若报「未找到可运行内置 Agent 的 Node.js 20+」，说明 `resources/node/node.exe` 没进包或 PATH 解析到了 Electron。
