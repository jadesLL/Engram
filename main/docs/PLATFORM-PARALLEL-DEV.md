# 三端并行开发规范（PLATFORM-PARALLEL-DEV）

> **适用**：Windows 桌面端（Electron）、Docker 服务端、Android 本地优先端（Capacitor + Kotlin）。
> **定位**：本文件是「一套设计理念 + 三套操作逻辑」的**唯一规范来源**，同时定义 Windows 主开发 → Docker/Android 定期同步的操作流程与门禁。
> **配套**：开发规则见根 [`AGENTS.md`](../../AGENTS.md)、[`main/AGENTS.md`](../AGENTS.md)；worktree 生命周期见 [`WORKTREES.md`](../WORKTREES.md)；构建发版见 [`BUILDING.md`](./BUILDING.md)、[`GITEA-CI.md`](./GITEA-CI.md)；Android 细节见 [`ANDROID.md`](./ANDROID.md)；手机滞后清单见 [`MOBILE-SYNC-LEDGER.md`](./MOBILE-SYNC-LEDGER.md)。
> **状态**：2026-11-02 制定（对应 v1.5.6）。规则生效后，所有开发 Agent 与维护者都必须按本文件执行。

---

## 0. 一页纸

### 0.1 三端是什么关系

Engram 不是一个产品抄三份，而是**一套产品内核 + 三个运行壳**：

```text
                     ┌─────────────────────────────────────────┐
                     │        产品内核（唯一事实源）              │
                     │   main/server（Fastify + SQLite）        │
                     │   main/web（Vue 3 + 设计令牌 + 全部页面）  │
                     └───────────────────┬─────────────────────┘
            ┌────────────────────────────┼────────────────────────────┐
     同一份 server + web 源码      同一份 server + web 源码        同一份 web 构建
            │                            │                            │
     ┌──────▼───────┐            ┌───────▼───────┐            ┌───────▼────────┐
     │ Windows 桌面端 │            │ Docker 服务端  │            │ Android 本地端  │
     │ Electron 壳    │            │ Node 容器      │            │ Capacitor 壳    │
     │ 内嵌 server    │            │ 同款 server    │            │ Kotlin/Ktor 本地│
     │ 127.0.0.1:18180│            │ 容器 8080      │            │ 127.0.0.1:18182 │
     └──────┬───────┘            └───────┬───────┘            └───────┬────────┘
        主开发 / 主验收               同源 / 零移植                 需适配 / 定期对齐
```

| 端 | 产品角色 | 代码构成 | 开发定位 |
| --- | --- | --- | --- |
| **Windows 桌面端** | 个人本机主力形态，owner 级管理面（外部接入 / MCP Token / 本机数据与端口 / 桌面壳能力） | `main/server` + `main/web` + `main/desktop`（Electron 壳） | **主开发与主验收环境**：新功能先在桌面形态跑通，再评估另两端影响 |
| **Docker 服务端** | 24h 在线中枢 / NAS / 公网部署，owner 级管理面 + 服务器更新 / DDNS / ONLYOFFICE（可选） | 与 Windows **完全同一份** `main/server` + `main/web` | **同源并行端**：不做代码移植；差异只在容器运行配置、能力位与更新通道 |
| **Android 本地端** | 随身成员端：本地库离线可用，绑定中枢后做成员同步与窄代理 | 同一份 `main/web` 构建 + `main/mobile`（Capacitor 壳 + Kotlin/Ktor 本地服务 + 原生桥） | **适配端**：操作逻辑按触屏重做；Web 改动自动共享，数据面/壳层需单独对齐 |

**一句话**：**Windows 与 Docker 是同一套源码的两个运行形态，必须始终兼容、零移植；Android 复用同一份 Web 构建，但有自己的壳、本地服务与同步数据面，是唯一需要"定期同步"的一端。**

### 0.2 十条核心结论（先记住这些）

1. **Docker 不需要代码移植**：Windows 与 Docker 共用 `main/server` + `main/web`，`docker build` 产出的就是同一套代码。所谓"同步到 Docker"，实际是**合并 main → 推送（需批准）→ CI 滚动镜像 `:main` / 发版 `:latest` → 部署验证**，没有任何人工改代码环节。
2. **真正需要定期同步的是 Android**：它共享 Web 构建，但操作逻辑、原生桥、本地 Ktor 服务与同步数据面（`SyncEngine.kt`）都是独立实现；APK 又是它唯一的升级通道。
3. **"Windows 主开发"不等于"Windows 私有分支"**：主开发指以桌面形态做第一验收环境、在 Windows 宿主上完成打包与宿主能力验证；共享代码必须落在 `main/server`、`main/web`，不得为 Windows 另起一套实现。
4. **一个设计理念**：视觉语言、信息架构、文案口径、数据模型只有一份（`main/web/src/styles/main.css` 令牌 + `Icon.vue` + 现有页面结构）；**操作逻辑按平台各自最优**（鼠标/键盘/多窗口 vs 触屏/返回栈/底部面板）。
5. **平台差异必须显式**：差异只能落在五类显式契约上——能力位、窗口尺寸档、整页分叉、原生桥、同步协议；禁止用 UA / 平台字符串 / "宽度猜设备"制造隐式分叉。
6. **能力位要三处同改**：`main/web/src/lib/capabilities.ts`（前端类型与缺省）、`main/server/src/routes/runtime.ts`（server/desktop 返值）、`EngramLocalServer.kt`（Android 返值）。漏 Kotlin 会 **fail-open**（前端合并缺省值后把桌面功能显示在手机上）。
7. **手机没有"立即通道"**：不跑滚动预发布 APK，只能发版装 APK。因此采用三层节奏：**每次合并登记影响 → 每周对齐窗口 → 每次发版全量清零**（见 §5）。
8. **手机最高危的差异在同步数据面，不只在 UI**：新增 SyncKind / 字段语义 / 回放规则如果只改 server 与 web，手机会走 `else` 分支记 warn 并推进水位——**内容静默缺失**，UI 上什么都看不出来。
9. **门禁自动化**：本次在 verify 内新增静态契约测试（版本号、能力位、桥、内嵌构建链、设置域可达性、滞后清单），并配套 `main/scripts/platform-parity-check.sh` 做发版/每周巡检；不靠记性。
10. **分支模型**：trunk-based + 短命 `feat/*` 分支；**不设长期 `mobile` / `android` 分支**（必然漂移）。跨端改动尽量在同一分支完成；确实滞后的登记滞后清单，最迟下次发版前清零。

### 0.3 三条铁律

- **铁律一**：Windows 与 Docker 不许出现"只在一端存在"的实现。任何 server/web 改动必须同时能在桌面形态与容器形态运行；差异只能通过能力位/配置表达。
- **铁律二**：Android 复用的永远是**本次源码重新构建的 web 产物**。打 exe / APK 前必须重新 build web 并走 `prepare-desktop.js` / `prepare-mobile-web.cjs`，禁止复用旧 `dist`。
- **铁律三**：手机端未对齐的功能，要么在本次分支补齐，要么在 `MOBILE-SYNC-LEDGER.md` 登记并写清目标版本；**不允许"悄悄少一块"**。

---

## 1. 事实基础（2026-11-02，v1.5.6）

> 本节是后续规则的依据。行号会随代码演进变化，以文件与结构为准；关键结论均可在仓库中复核。

### 1.1 源码拓扑（唯一事实源）

| 目录 | 内容 | 是否被三端共用 |
| --- | --- | --- |
| `main/server/` | Fastify 服务端：内容/检索/同步/Agent/Office/更新 | ✅ Windows 内嵌进程 + Docker 容器共用 |
| `main/web/` | Vue 3 SPA：全部页面、设计令牌、能力位判断、原生桥消费 | ✅ Windows/Docker 同一份构建；Android 复用同一份构建 |
| `main/desktop/` | Electron 主进程、preload 桥、托盘/更新/打包脚本 | 仅 Windows |
| `main/mobile/` | Capacitor 壳、Kotlin/Ktor 本地服务、同步引擎、原生桥、OTA、Gradle | 仅 Android |
| `main/installer/` | 源码版安装器（包装 `install-engram.ps1`） | Windows 分发辅助 |
| `main/scripts/` | worktree/打包/发布/一致性脚本 | 全仓共用 |

构建链核对点：

- Docker 镜像只打包 `server` + `web`（`main/Dockerfile` 的 build 阶段；运行时镜像只 COPY `server/dist`、`web/dist`、`VERSION`、`GIT_SHA`）。
- 桌面端由 `desktop/scripts/prepare-desktop.js` 把 `server/dist` + `web/dist` 复制进 `desktop/`，再打 asar / NSIS。
- Android 由 `mobile/scripts/prepare-mobile-web.cjs` 把 `web/dist` 复制成 `mobile/web-dist`，`cap sync` 复制进 APK 的 `assets/public`，由本地 Ktor 服务在 `127.0.0.1:18182` 提供。
- 三份 web 产物（Docker 镜像内、exe 内、APK 内）都来自**同一次 `pnpm --filter @engram/web build`**。

### 1.2 运行形态差异（代码事实）

| 维度 | Windows 桌面端 | Docker | Android |
| --- | --- | --- | --- |
| 端口 | 本地 `127.0.0.1:18180`（可改，`ENGRAM_LOCAL_PORT` 可覆写） | 容器 `8080`；宿主映射 `18080`（本地构建 compose）或 `8080`（pull 模板） | 本地 `127.0.0.1:18182` |
| 数据目录 | Electron `userData/data`（可在设置里改） | `/data` ← compose 卷 / 绑定目录 | 应用私有 `filesDir/engram`（`brain/` + `wiki.db`），卸载即删 |
| Web 产物位置 | asar 内 `desktop/web/dist` | 镜像 `/app/web/dist` | APK `assets/public` |
| 能力位来源 | `server/src/routes/runtime.ts`（`runtime=desktop`，`localFirst=true`） | 同一路由（`runtime=server`，`localFirst=false`） | `EngramLocalServer.kt`（`runtime=android-local`，窄集） |
| 桌面壳能力 | 标题栏融合、托盘、开机自启、本地数据目录/端口、系统程序打开文件、exe/源码模式更新、快捷方式 | 无（浏览器） | 系统分享入口、生物解锁、返回键、系统栏 insets、OTA |
| 更新方式 | 源码模式：拉源码重建重启；安装包模式：下载 exe 静默安装；应用内自动更新 | 拉镜像 `:latest` / `:main` + switcher 重建容器（失败回滚）；应用内一键更新 | 仅 OTA：下载 APK → 系统安装器确认 → 覆盖安装 |
| 跨端角色 | 可 `none/hub/member`，owner 级管理面全开 | 同 Windows（常驻中枢首选） | 只能 `none/member`；owner 级（成员邀请/DDNS/TLS/外部接入/MCP Token）不下发 |

### 1.3 版本号与发版链

- **版本号唯一权威源**：`main/desktop/package.json` 的 `version`。
- 发版时**三处同步 bump**：`main/desktop/package.json`、`main/web/src/version.ts`（`APP_VERSION`，界面显示）、`main/docker-compose.yml`（`image: engram:<版本>`）。Android `versionName/versionCode` 自动从 `desktop/package.json` 派生（`mobile/android/app/build.gradle`），Docker 镜像内 `/app/VERSION` 也由它生成。
- 发版两步、缺一不算完成：① 推送 `v*` 标签 → `release.yml` 校验 tag=版本、CHANGELOG 段落存在、verify 通过 → 构建推送 `:<版本>` + `:latest` → 创建 Gitea Release；② 手动 dispatch `release.yml` 勾选 `binaries` → 构建 Windows exe + 签名 APK → 补挂同一 Release → 同步公开仓库同名 Release。
- 日常推送 main（需用户批准）：`ci.yml` 跑 verify + 构建推送滚动镜像 `:main`（发版前测试通道，部署机可切「更新通道 → main」跟主分支）。
- **现状缺口**：三处版本号此前没有自动校验；CHANGELOG 只在 tag 推送时校验；Kotlin 编译/单测不在日常 verify 里（只在发版 dispatch 的 Android 构建容器跑）。本次已补版本号/契约门禁（§6），Kotlin 门禁列入阶段二。

### 1.4 能力位现状（12 枚 feature）

| 能力位 | server / desktop | android-local | 用途 |
| --- | --- | --- | --- |
| `agent` | true | 绑定中枢后 true | Agent 聊天交互面 |
| `agentAdmin` | true | **false** | 外部接入 / MCP Token 等 owner 管理面 |
| `agentConsole` | true | 绑定中枢后 true | 内置 Agent 控制台（手机写中枢配置） |
| `videoConfig` | true | 绑定中枢后 true | 视频理解模型配置（手机写中枢） |
| `mcp` | true | **false** | MCP 服务/Token |
| `jobs` | true | true（桩） | 任务队列状态徽标 |
| `onlyOffice` | 按配置 | **false** | ONLYOFFICE 在线编辑 |
| `serverUpdate` | true | **false** | 服务器镜像更新 |
| `apkUpdate` | **false** | true | 手机 OTA（APK 更新） |
| `ddns` | true | **false** | DDNS 直连域名 |
| `backup` | true | true | 备份/恢复 |
| `fileExtraction` | true | true | 文档文本提取 |

> 说明：`nativeActions`（手机声明 `share-text/share-file/file-picker`）目前在 Web 侧**没有消费者**；新增原生动作入口时必须同时补 Web 消费与无桥降级（见 §3.2）。Android 端 `syncRoles=[none,member]`、`agentMode=hub|unavailable`、`localFirst=true`；server/desktop 端 `syncRoles=[none,hub,member]`、`agentMode=local`、`localFirst` 随运行形态变化。

### 1.5 现有护栏与缺口

**已有一部分护栏**（新增门禁应尽量复用这套「读源码 + 正则断言」的范式）：

- `main/web/src/lib/` 下有 9 个 UI 护栏测试文件、约 81 条断言（`mobileLayout.test.ts`、`mobileShellUx.test.ts`、`mobileInboxUx.test.ts`、`androidUiFit.test.ts`、`androidUxGaps.test.ts`、`androidPredictiveBack.test.ts`、`settingsLayout.test.ts`、`mobileInsertPanel.test.ts`、`readingOutlineLayout.test.ts`），锁断点常量、安全区、返回键、热区、设置导航等既有声明。
- server 侧 `runtime.test.ts` / `runtimeDesktop.test.ts` 锁能力位取值；桌面打包侧有 ABI / MZ 头 / asar staging / node.exe / dsh 断言；release.yml 锁 tag、CHANGELOG、未签名 APK；`build.gradle` 派生 Android 版本号。
- 但三端**跨文件契约**没有统一门禁：版本号三处、能力位三处、原生桥、内嵌 web 构建链、设置域手机可达性、滞后清单，此前全靠人工。

**本次新增的自动化门禁**（详见 §6）：`main/web/src/lib/platformParity.test.ts`（随 `verify` 跑）+ `main/scripts/platform-parity-check.sh`（发版 / 每周巡检）+ `main/docs/MOBILE-SYNC-LEDGER.md`（滞后清单）。

---

## 2. 设计理念：一套 Engram，三套操作逻辑

### 2.1 一句话

> **视觉和桌面版是同一个 Engram（暖纸底、Engram Blue、细线图标、14px 卡片）；操作逻辑按平台各自重做（桌面：鼠标 + 键盘 + 多栏；手机：顶栏 + 底部导航 + 返回栈 + 底部面板 + 手势 + 大触控目标）。**

这句话来自安卓改版设计基线（`android-ui-redesign/BRIEF.md`，该目录未入库，其结论已落在 v1.5.3–v1.5.5 的实现与 `docs/ANDROID.md` 中）。它同时约束两端：**不许给手机另造一套视觉**，也**不许把桌面操作硬塞进触屏**。

### 2.2 五条设计原则

1. **一个 Engram**：色板、字体、图标、圆角、阴影、文案语气、信息分类只有一份。新增视觉元素先问「桌面/手机是否都成立」；只在单端成立的样式必须走平台差异登记，不做隐式覆盖。
2. **内容优先、材质克制**：沿用现有 Fluent / 暖纸 + 白卡 + 毛玻璃浮层的语言；动效只服务「入场、主操作反馈、状态切换」三类，不做炫技。
3. **每个平台用最自然的操作**：
   - Windows/Docker：hover、右键菜单、快捷键（`Ctrl+K` 搜索 / `Ctrl+N` 新建 / `Ctrl+S` 保存 / `[[` 双链）、可拖拽分栏、多窗口。
   - Android：底部导航、底部面板（替代 hover/右键）、长按、滑动、FAB、Snackbar、系统返回键/预测性返回、48dp 热区、安全区、轻振。
4. **能力决定 UI（capability-driven）**：功能有无看能力位；布局看窗口尺寸档；绝不靠 UA 字符串或「宽度 < x 就是手机」判断平台能力（触屏能力用 `hover: none` + `pointer: coarse`）。
5. **渐进增强 + 可降级**：没有原生桥、没有能力位、没有中枢绑定时，UI 必须**隐藏或给出可读说明**，不能出现死按钮、空页面、报错弹窗。样板：`biometric.ts` 无桥返回 `null` → 登录页整块隐藏；`systemInsets.ts` 无桥 → 全 0，安全区退化。
6. **差异显式化并留证据**：每一处平台差异都要能指向「能力位 / 尺寸档 / 整页分叉 / 原生桥 / 同步协议」之一，并在本文档或代码注释/测试里留下依据。

### 2.3 视觉与组件：单一来源

| 资产 | 唯一来源 | 约束 |
| --- | --- | --- |
| 设计令牌 | `main/web/src/styles/main.css`（浅色 + 深色两套） | 新增颜色/阴影/圆角只加令牌，不在组件里写裸 hex（现状仍存 322 处 hex / 854 处裸 px，属设计债，见 §8） |
| 图标 | `main/web/src/components/Icon.vue`（约 68–86 枚线性图标，24/1.7） | 不引第三方图标库、不用 emoji 当图标 |
| 品牌 | `main/docs/brand/`（SVG 单一来源 + 生成器） | 不在业务组件里复制 logo |
| 断点常量 | `main/web/src/lib/layoutBreakpoints.ts`（640/768/1024）+ `windowSizeClass.ts`（600/840） | CSS 媒体查询用字面量时必须与常量一致（已有测试锁） |
| 触屏/指针判断 | `pointer.ts`、`main.css` 的 `(hover: none) and (pointer: coarse)` | 不用宽度代替触屏判断 |
| 安全区 | `systemInsets.ts` 注入 `--inset-*`，样式只用 `--safe-*` | 禁止裸 `env(safe-area-inset-*)`（已有全库断言） |

已知设计债（不阻塞开发，但新增代码不应扩大）：无间距/字号/动效标尺令牌；`--font-sm/md` 定义了但 0 引用；组件内媒体查询存在两套断点口径（§2.5 的 L2/L3）。

### 2.4 信息架构同构、导航模型异构

- **同构**：功能集合、页面语义、术语、数据组织方式三端一致。同一个「收集箱」「知识库」「Agent」「客户调研」在手机上不能改名换义。
- **异构**：到达路径与容器形态按平台重做。

| 目的地 | Windows / Docker | Android |
| --- | --- | --- |
| 首页 | 三栏 + 首页看板（12 列画布） | 顶层「首页」/ 底栏第一项 + 看板手机布局 |
| 知识库/侧栏 | 常驻侧栏 280px（可拖 232–420）+ 44px rail | 抽屉（浮层），medium 档 rail + 并排双栏，expanded 三栏 |
| 搜索 | `Ctrl+K`、rail 图标 | 底栏 / 我的面板入口 |
| 收集箱 | 桌面工作台（列表/筛选/拖入） | 卡片台（右滑入库 / 左滑回收 / 上滑详情 / 长按多选），≤768 |
| Agent | 右侧可拖宽抽屉 | <840 独立全屏页；≥840 回抽屉 |
| 设置 | 7 大类双栏 + 锚点 | 账户卡 + 6 行分组 + 子页 push，行高 ≥56dp |
| 新建 | `Ctrl+N` / 侧栏 + | 底栏「新建」→ 选择面板（新建页面 / 记灵感） |
| 更多 | rail 图标直接可达 | 「我的」底部面板（多端同步 / 设置 / 外观 / 工具入口） |

### 2.5 平台差异的四层模型（新增功能必须逐层判断）

| 层 | 机制 | 现状承载 | 新增功能时要做什么 |
| --- | --- | --- | --- |
| **L1 能力位** | `/api/runtime/capabilities` + `features.*` | 三处实现（web / server / Kotlin），24 个前端文件消费 | 三处同改 + 文档矩阵 + 语义一致；漏 Kotlin = fail-open |
| **L2 窗口尺寸档** | `windowSizeClass` 600/840；`.layout.size-*` 切骨架 | `Home.vue` 设备矩阵、`windowSizeClass.ts` | 新骨架/双栏必须支持 compact / medium / expanded 三档；新增常量先改 `windowSizeClass.ts` |
| **L3 页面级断点/整页分叉** | 组件内 768 媒体查询；`InboxViewRoute` 二选一；`AgentView` 整页 | `InboxViewRoute.vue`、`SettingsView.vue`、`EditorView.vue`、`ReadingPreview.vue` 等 | 明确该页面在 <600 / 600–839 / ≥840 各是什么形态；新页面默认两端共用，确需整页分叉必须登记为平台差异 |
| **L4 原生桥与全局 CSS** | `window.__engram*` / `wikiDesktop` / insets / 返回层 / 热区白名单 | `systemInsets`、`androidBack`、`globalBackLayers`、`haptics`、`mobileShellUx` 等 | 新桥必须「原生实现 + Web 降级 + 文档登记」；新浮层必须注册返回层级；新控件必须可点区域 ≥44/48dp |

> **重要口径**：页面级 768 与壳层 600/840 **两套断点并存**，这是历史迁移态。新增代码应以 600/840（壳层）为准；页面级媒体查询不得再造新断点。已知冲突：768–839 会出现「medium 壳 + 桌面版页面」，属待收敛设计债（§8）。

### 2.6 操作逻辑差异矩阵

| 操作面 | Windows / Docker | Android |
| --- | --- | --- |
| 导航 | 常驻 rail + 侧栏；多窗口/多任务 | 底栏（compact）/ rail（medium）/ 三栏（expanded）；单任务返回栈 |
| 主操作 | 悬停显现、右上按钮、右键菜单 | 常显按钮、底部固定动作条、FAB、滑动分诊 |
| 菜单 | 右键上下文菜单 / 下拉菜单 | 长按 500ms → 底部面板；行尾按钮 |
| 提示 | tooltip（hover 展开） | 无 tooltip；用说明文字/长按；触屏常显 |
| 反馈 | hover/active 态、行内进度 | 按压态 + 轻振（可关）+ Snackbar（带撤销） |
| 弹层 | 浮层/对话框/可拖抽屉 | 底部面板（拖柄 + scrim + 22–26px 圆角），破坏性操作才用对话框 |
| 输入 | 键盘、快捷键、`[[` 双链 | 软键盘适配（`html.kb-open` 收底栏）、插入面板、选中浮动格式条 |
| 返回 | 无系统返回；Esc 关浮层 | 返回键优先级：浮层 → 抽屉/阅读目录 → 路由历史 → 退后台（预测性返回 API 33+） |
| 安全区 | 无 | `--safe-*` 统一留白；横竖屏/折叠/键盘变化重推 insets |
| 手势 | 拖拽分栏、拖放 | 下拉刷新（真对账）、卡片三向滑动、抽屉横滑、长按多选 |
| 批量 | Shift 多选、全选 | 长按进选择态、整列勾选、批量动作条 |
| 通知 | 更新图标/标题栏 | 贴底 Snackbar、系统通知（下载完成）、轻振 |
| 数据管理 | 数据目录选择、端口修改、备份/恢复 | 本机私有目录、可移植 v2 备份、卸载删数据提示 |
| 更新 | 源码模式自更新 / exe 静默安装 / 自动更新 | 仅 OTA，系统安装确认不可省，签名一致才能覆盖 |
| 设置 | 7 大类双栏 + 锚点 | 账户卡 + 分组列表 + 子页 push |

### 2.7 设备与窗口矩阵

| 窗口档 | 宽度 | 骨架 | 典型设备 |
| --- | --- | --- | --- |
| compact | < 600 | 五项底部导航 + 「我的」面板 + 抽屉侧栏 | 手机竖屏、折叠屏合上、分屏窄窗 |
| medium | 600–839 | 左侧 rail + 并排双栏（列表 | 内容） | 折叠屏展开、手机横屏、小平板竖屏 |
| expanded | ≥ 840 | rail + 常驻侧栏 + 三栏 | 平板横屏、桌面网页 |
| tabletop（姿态） | 折叠屏桌面姿态 | 操作台布局（输入/阅读分离） | 折叠屏半折摆放 |

Windows 窗口可自由缩放，因此桌面/浏览器形态也要在 640/768/1024 页面断点下成立；**桌面窗口变窄 ≠ 手机**（触屏能力仍按指针判断）。

### 2.8 差异显式化纪律（新增功能四问）

每个新功能落地前必须回答并记录：

1. **能力位**：需要新开/修改能力位吗？（三处同改，语义写进 §3.1 矩阵）
2. **尺寸/页面**：在 compact / medium / expanded 各是什么形态？需要整页分叉吗？
3. **原生桥**：需要系统能力（权限、Intent、分享、Keystore、通知、返回键）吗？无桥时如何降级？
4. **接口/同步**：新接口是手机本地实现、窄代理到中枢，还是 owner 级不可用？新增/变更同步 op 吗？

答完写进提交信息（§4.3）与必要的文档；涉及新差异面的，同步更新本文件对应矩阵。

---

## 3. 平台契约

### 3.1 能力位契约

**定义位置（三处，必须一致）**：

1. 前端类型与缺省：`main/web/src/lib/capabilities.ts`（`RuntimeCapabilities`、`fullCapabilities`、`loadRuntimeCapabilities`）。
2. server/desktop 返值：`main/server/src/routes/runtime.ts`。
3. Android 返值：`main/mobile/android/app/src/main/java/com/engram/app/EngramLocalServer.kt` 的 `get("/api/runtime/capabilities")`。

**规则**：

- 新增能力位：三处同改 + `platformParity.test.ts` 会校验键集一致 + 文档矩阵登记；前端默认值必须保守（手机不报 true 的能力一律默认 false）。
- 语义：`agentAdmin` 是「能否管理 Agent 管理面」，`agent` 是「能否使用 Agent 聊天」——不得混用（见 `settingsDomains.ts` 注释与 `settingsDomains.test.ts`）。
- 取值为动态依赖时必须写清依赖条件（例如 `agentConsole = 已绑定中枢`），并在 Android 侧有对应实现。
- **fail-open 防护**：前端在能力位加载失败时当前回退 `fullCapabilities`（桌面全量）。新增「手机才有」的能力位默认值必须 false；新增「桌面才有」的能力位若被前端默认 true 且 Kotlin 漏报，会在手机露出死入口——所以三处键集校验是硬门禁。

### 3.2 原生桥契约

**Android 桥**（原生 → Web；无桥必须自动降级）：

| 桥 | 原生实现 | Web 消费 | 无桥降级 |
| --- | --- | --- | --- |
| `EngramSystemBars.insets()/setDark()` + `window.__engramSystemBars(json)` | `SystemBars.java` | `lib/systemInsets.ts` | insets 全 0，安全区退化为 `env()` |
| `EngramBiometric.*` + `window.__engramBiometricResult(id, json)` | `BiometricUnlock.java` | `lib/biometric.ts` | `biometricStatus()=null`，登录页整块隐藏 |
| `window.__engramHandleBack()` | `MainActivity.java`（预测性返回/旧返回回调） | `lib/androidBack.ts` + `globalBackLayers.ts` | 无原生调用，不触发 |
| `window.__engramJoinLink(raw)` → 返回 true 才算送达 | `MainActivity.java` | `lib/joinLink.ts` | 无调用；粘贴链接仍可用 |
| `window.__engramShareInbox(delivery)` | `MainActivity.java` | `lib/shareInbox.ts` | 无分享入口 |
| `EngramInboxRender` + `window.__engramInboxRenderResult(id, payload)` | `InboxRender.java` | `lib/inboxRender.ts` | 走服务端抓取，失败给原错误提示 |

**Windows 桥**：`main/desktop/preload.js` 通过 `contextBridge` 暴露 `window.wikiDesktop`（约 30 个方法，见文件）；Web 侧在 19 处调用，全部必须做「无桥不渲染/不调用」判断（样板：`App.vue` 用桥存在性判标题栏；`biometric.ts` 用 null 判降级）。

**规则**：

- 新增桥：原生实现 + Web 调用 + 无桥降级 + 本表登记，四件事缺一不可。
- 桥方法名与语义一旦上线按兼容处理（旧 APK 可能仍在用旧 Web 产物？不——Web 与 APK 同版本，但旧 APK 仍可能连新中枢；桥是壳内契约，随 APK 生效）。新增桥不要求旧 APK 兼容，但 Web 必须能在无桥环境（Docker 浏览器 / 旧壳）安全运行。
- 新增原生能力（权限/Intent/Keystore）时，在 `docs/ANDROID.md` 补「权限与降级」说明。

### 3.3 API 端点归属

| 类别 | 判据 | 例子 | 手机侧动作 |
| --- | --- | --- | --- |
| 本地实现 | 只读写本机 `brain/` 或 `wiki.db` | auth、pages、files/assets、search、graph、trash、settings、backup/restore、sync config/status/log/pairing/reconcile、app-update | Kotlin/Ktor 路由实现 |
| 窄代理到中枢 | 中枢做实事，手机只转发（成员令牌） | assistant 会话/run/events、agent-console 18 条、video-config、dream、guide、customer-research、tasks/board、inbox、ideas | `EngramLocalServer.kt` 的 `proxyHub` / `proxyAgent` + 未绑定中枢时 409 中文提示 |
| 不代理（owner 级） | 成员令牌不能做 | 成员邀请/peers、DDNS、TLS、外部接入、MCP Token 发放 | 能力位 false，UI 不出现；直接访问给可读说明 |
| 手机专属 | 只有壳层能做 | `/api/app-update/*`（OTA）、本机分享落袋 | Kotlin 实现 |

**规则**：新增 server 接口时，必须判断手机端属于哪一类；窄代理类要在 `EngramLocalServer` 加一行代理并在能力位/文案上说明「由中枢执行」；owner 级必须继续报 false。

### 3.4 同步协议兼容契约（Android 与中枢）

- 同步对象（`SyncKind`）：`page`、`file`、`delete`、`move`、`session`、`board`、`preference`、`research`。手机镜像 `page/file/delete/move/preference`；`session/board/research` 不落本地副本，读走窄代理。
- **未知 kind**：手机记 warn 并**照常推进水位**（不卡死，但内容会静默缺失）→ **新增 SyncKind 必须同时改手机 `SyncEngine.applyOp`，否则旧 APK 会"看得见同步成功、看不见内容"**。
- 字段兼容：只增不改语义；手机对未知键跳过（`skipValue`）；服务端对旧手机降级（`missing`、`resync`、快照字段）。
- **preference 新键（2026-11）**：`agent_model_config`（内置 Agent 的模型配置与相关 API Key，JSON 字符串）与 `video_config`（视频理解总开关）都归「设置」分类，走既有 preference 管道。Android 对未知 preference key 按现有逻辑跳过、不落盘（手机不持有模型 Key，视频提炼与聊天都在中枢执行），**因此本功能 `平台影响: B,F`、Kotlin 零改动**；新增 preference 键不得要求手机侧改 `SyncEngine` 才算兼容。
- **删除语义**：preference 合取按并集，删除不跨端（一端删掉提供商会被另一端的并集带回），文档与界面文案都写清，避免用户以为「删一处全端删」。
- 旧中枢兼容：手机对缺失端点（如 `/api/sync/distilled`）只记一次 warn 并照旧走全量对账。
- 文件与页面冲突：页面由中枢三方合并；**文件不可合并，按 mtime 较新者胜**（全量清单条目带 `mtime`，成员有未推送改动时仍以本端为准推送；旧中枢不带该字段时退回旧行为）。
- 增量回放：`sync_oplog` 的 file op 带内容 `hash`（重连补拉据此判断是否要拉文件；旧行 hash 为空时成员端无条件拉一次）。
- 标记清单：`/api/sync/distilled` 只回中枢仍存在的来源路径、不按中枢同步分类过滤（各成员按自己的分类开关采纳）；成员收到空清单不清本地标记。
- **破坏性变更**（改字段语义、改 op 语义、删字段）：必须走「发版 + 首次连接提示升级」或引入新端点/协议版本字段；禁止静默改变语义。
- 现状缺口：没有显式 `syncProtocol` 版本号，靠「多读少写 + 未知跳过 + 能力位」做增量兼容。后续建议增加只读协议版本字段（阶段三，§8）。

### 3.5 版本与产物契约

| 契约 | 内容 | 校验 |
| --- | --- | --- |
| 版本号 | 三处一致；Android/Docker 派生 | `platformParity.test.ts`（verify 内） |
| 内嵌 Web | 三端 Web 产物必须来自本次构建；prepare 脚本不得指向其它目录 | 测试校验构建链引用；打包手册要求重建 |
| 发版三件套 | Android APK + Windows exe + Docker 镜像 `:<版本>`/`:latest` | release.yml + 人工 dispatch |
| 安卓累积更新 | CHANGELOG 安卓段必须写「自上一个 Android 版本以来的全部改动」 | 发版门禁 + 人工核对 |
| 产物身份 | 镜像有 `/app/GIT_SHA`；exe/APK 仅有版本号（缺口） | 阶段二补 build-info |
| 渠道 | `:main` 滚动仅测试；`:latest` 只发版产出 | BUILDING/GITEA-CI 既有规则 |

---

## 4. 开发工作流（Windows 主开发）

### 4.1 任务分级：A–F 六类（先分类，再动手）

| 类 | 判据 | Windows/Docker 动作 | Android 动作 | 验证 |
| --- | --- | --- | --- | --- |
| **A 纯服务端 + 窄代理** | 中枢做实事，手机只需转发 | 改 server + web（能力位显隐） | Kotlin 加代理行 + 能力位 + 未绑定提示 | web 断言 + 窄代理冒烟 |
| **B Web 通用改动** | 只改 `main/web`，无平台语义 | 无额外动作 | 无（同构共享），但必须看窄窗/触屏 | 桌面 + Docker 窄窗回归 |
| **C 移动布局/手势/返回** | 骨架、浮层、手势、返回层级 | 桌面保持原行为 | 600/840 档 + `.layout.size-*` + `registerBackHandler` + `pointer.ts` | 三档窗口 + 返回键手测 |
| **D 原生桥/权限/系统集成** | 需要系统能力 | Web 侧加无桥降级 | Manifest/权限 + Java/Kotlin 桥 + Web 降级 | API 23/35 真机/模拟器 + 无桥回归 |
| **E 手机不能做** | owner 级、常驻后台、本地 dsh、本地模型 Key | 正常做 | 能力位 false + 文案说明，不做入口 | 手机端确认入口不出现 |
| **F 同步数据面** | 新增/修改 `SyncKind`、op 字段、回放规则、本地 outbox | 改 `server/src/sync` 等 | `SyncEngine` + `LocalDatabase` + 旧中枢降级 + Kotlin 单测 | 双向同步 + 积压重放 + 旧中枢/旧手机模拟 |

> 一个功能可能落在多类（如「新增设置项并同步」= B + A/F）。分类结果写进提交信息（§4.3）。
> 真实样本：v1.5.1（`ea1883a4`）是 A 类样板（26 文件 785 行，Android 仅 +52 行）；v1.5.4（`d88e955a`）是 C+D；v1.5.5（`350b67bc`）是纯 B+C（17 个 web 文件 +3147 行，0 原生改动）；v1.5.6（`60c8650c`）是 F 类样板（"纯服务端修复"照样改了 `SyncEngine`）。

### 4.2 标准路径（从需求到合并）

1. **分类**：按 §4.1 判定 A–F；判断是否需要 worktree（源码/配置/测试/文档改动一律建 `worktrees/<feature>`，见 `WORKTREES.md`）。
2. **读规范**：跨端任务先读本文件与相关端文档（ANDROID / BUILDING / GITEA-CI）。
3. **实现共享内核**：先改 `main/server` / `main/web`，保持桌面与 Docker 同时成立。
4. **Windows 验收**：以桌面形态走真实路径（含桌面壳能力），截图留证。
5. **Docker 验收**：`verify-feature.sh` 通过 + 容器真实运行冒烟（能力位、数据目录、端口、更新入口）。
6. **Android 适配（按类）**：A/C/D/F 必须在本分支或紧邻 follow-up 完成；确实滞后的登记 `MOBILE-SYNC-LEDGER.md`。
7. **文档与变更记录**：更新 `docs/ANDROID.md`（若手机行为变化）、本文件矩阵（若新增平台差异）、`README.md`（用户可见功能）；CHANGELOG 在发版时统一写。
8. **提交与合并**：提交信息末行写平台影响声明 → `verify-feature.sh` → `merge-feature.sh --cleanup <feature>` 自动合并并清理（规则见根 AGENTS / WORKTREES）。

### 4.3 平台影响声明（提交信息约定）

提交信息最后一段（trailer）固定一行：

```text
平台影响: A
```

取值：`A` 纯服务端+窄代理 / `B` Web 通用 / `C` 移动布局手势返回 / `D` 原生桥权限 / `E` 手机不做 / `F` 同步数据面 / `none` 无平台影响（纯文档、CI、样式无平台语义）。跨类用逗号：`平台影响: B,F`。

可选补充行（推荐，便于每周巡检直接读）：

```text
Windows: 已验收（桌面形态，截图见报告）
Docker: 同源，容器冒烟通过
Android: 已适配（底栏入口 + 返回键层）/ 已登记 MOBILE-SYNC-LEDGER v1.5.7
```

**规则**：未声明视为 `C`（需手机适配），由巡检脚本标红；发版前 `platform-parity-check.sh --strict --since <上个 tag>` 会列出缺声明提交（阶段一为警告，阶段二可升为错误）。

### 4.4 Windows 端验收清单

- [ ] 桌面形态真实路径可用（不是只看 Docker 网页）。
- [ ] 桌面壳能力未被破坏：标题栏融合、窗口控制、托盘驻留/退出、单实例、开机自启、本地文件系统打开、数据目录/端口设置。
- [ ] 更新链路未被破坏：版本显示、检查更新、源码模式/安装包模式入口（改到相关代码时）。
- [ ] 窄窗（640/768/1024）下桌面布局成立。
- [ ] 打包相关改动按根 AGENTS「Windows 桌面端打包」验证（ABI / MZ / node.exe / dsh / 端到端 fork server）。

### 4.5 Docker 端验收清单

- [ ] `verify-feature.sh <feature>` 通过（build + typecheck + test）。
- [ ] 容器真实运行：`/health` 200、登录页、设置页版本号、数据卷挂载、端口映射。
- [ ] 能力位差异正确：`runtime=server`、`localFirst=false`、`serverUpdate`/`ddns` 可用、`apkUpdate=false`；ONLYOFFICE 按当前 compose 配置。
- [ ] 服务器更新/一键更新相关改动不破坏 switcher 回滚路径。
- [ ] 更新通道（`:main` / `:latest`）行为符合预期。

### 4.6 Android 端 Definition of Done（手机适配完成）

- [ ] 已按 §4.1 标定 A–F 类，并在提交信息声明。
- [ ] A 类：窄代理 + 能力位 + 未绑中枢 409 中文提示；D 类：权限 + 无桥降级；F 类：未知 kind / 旧中枢 404 / Kotlin 单测三条路径。
- [ ] Web 侧护栏测试通过（`pnpm test` 内已含安卓断言；新增关键声明时补 `lib/*.test.ts`）。
- [ ] 真机/模拟器矩阵（至少）：API 23 + API 35、compact/medium/expanded、返回键、安全区、横竖屏/折叠切换、触屏热区、轻振开关、下拉刷新。
- [ ] 同步双向冒烟（改到数据面时）：页面/附件/图片资产/回收站恢复/改名+移动/删除、待推清零、标记对齐。
- [ ] OTA（改到更新时）：旧 APK 覆盖升级、签名一致、debug 包拦截。
- [ ] `docs/ANDROID.md` 对应段落已更新；滞后清单无本功能待办。

### 4.7 分支与提交模型

- **主线**：`main` 是唯一集成线（trunk-based）；功能分支 `feat/<feature>` 短命，合并后自动清理。
- **禁止**：长期 `mobile`、`android`、`windows` 分支；平台专用分支只能作为**短命 follow-up**（如 `feat/mobile-<feature>`），且必须在滞后清单里关联来源提交。
- **跨端改动尽量同分支**：Android 适配与共享代码在同一个 `feat/<feature>` 内完成（同一 worktree），避免"共享改动已合、手机改动另起"导致上下文丢失。只有需要真机长时间验证时才拆 follow-up。
- **提交前缀**：沿用现有习惯 `feat(android):`、`fix(mobile):`、`feat(web):`、`docs:`；末行平台影响声明。
- **合并**：沿用 `merge-feature.sh --cleanup`，串行、不跳过末尾残留复验；推送/发版仍须用户明确批准。

### 4.8 关于"主开发环境"

- 代码开发仍在 worktree + Docker verify（仓库既有规则），**Windows 是主验收与主打包环境**：桌面形态是第一个 "真实用户路径"，exe 打包与宿主验证在 Windows 完成。
- 不因为"Windows 主开发"就把共享逻辑写进 `main/desktop`；桌面壳只放桌面专属能力（窗口/托盘/更新/系统文件）。
- Docker 端不做"移植补丁"：发现 Docker 行为不对，改共享代码或配置，不改出第三份实现。

---

## 5. 定期同步机制（Windows → Docker / Android）

### 5.1 同步节奏总表

| 时机 | Docker | Android | 负责人 |
| --- | --- | --- | --- |
| **每次功能合并前** | verify + 容器形态成立（同源代码） | 按 A–F 分类决定是否同分支适配；影响登记 | 开发 Agent |
| **每次合并后**（推送获批时） | CI 自动推 `:main` 滚动镜像；测试部署可一键更新 | 无需动作（APK 不随 main 滚动） | CI + 用户 |
| **每周一次（建议周一，30–90 分钟）** | 检查是否有待验证的 `:main` 行为变化 | 手机对齐窗口：跑巡检脚本、清滞后清单、真机冒烟 | 维护者 Agent |
| **每次发版前** | 三件套镜像 + 部署验证 | **全量对齐**：滞后清单清零、累积更新写全、APK 基于发版提交构建 | 维护者 Agent |
| **紧急修复（hotfix）** | 合 main 走 `:main`；或热修版本 | 仅当影响手机使用/数据面/协议时补发 APK；否则并入下次发版 | 维护者 Agent |

> **数量阈值（建议）**：同一功能在 Windows 上合并后，**最多跨 2 次合并 / 14 天**必须完成手机适配或登记滞后清单；超过即视为手机端欠账，周会/巡检必须处理。

### 5.2 Docker：同源零移植（操作步骤）

Docker 与 Windows 共用源码，**没有"代码同步"步骤**；需要做的是"让部署形态跟上并验证"：

1. 功能合并 main（自动）→ 用弹窗问用户是否推送 gitea。
2. **获批推送后**：`git push gitea main` → `ci.yml` 跑 verify 并推送 `:main` 滚动镜像。
3. **测试部署**：部署机设置 → 版本与更新 → 更新通道选 `main` → 点「立即更新」（switcher 重建容器，失败自动回滚）→ 验证新功能。无需发版号。
4. **正式部署**：仅在用户明确要求发版时 bump 版本 + 打 tag → `release.yml` 产出 `:<版本>`/`:latest` → 部署机切回 `latest` 更新。部署动作需用户批准。
5. **验证清单**（每次 Docker 行为变化时）：
   - `/health` 200；设置页版本号/提交号正确；
   - `runtime=server`、`localFirst=false`、`apkUpdate=false`；
   - 数据在 `/data`（或 compose 卷），重启不丢；
   - 服务器更新入口/通道/回滚正常；
   - 同步中枢角色（hub）与成员管理正常（改到同步时）。

**注意**：`:main` 是滚动 tag，不是长期部署基线；发版后应切回 `:latest`。正式线 `:latest` 只能由发版产生，不允许"日常推送覆盖"（既有 CI 规则）。

### 5.3 Android：定期对齐的操作步骤

**前置：先列出"自上次手机对齐以来 desktop/Docker 侧新增了什么"**

```bash
# 以最近一次 Android 发版 tag 为基线（例如 v1.5.6），列出影响手机的提交与文件
git log v1.5.6..HEAD --oneline -- main/mobile main/web/src/lib main/web/src/views/home main/server/src/sync main/server/src/routes/sync.ts
# 或按平台影响声明聚合（脚本会列出缺失声明的提交）
bash main/scripts/platform-parity-check.sh --since v1.5.6
```

**步骤**：

1. **逐条分类**：对每条提交按 §4.1 标 A–F；只有 B 类可以"零手机改动"，A/C/D/F 都必须有手机侧动作。
2. **按类实现**（优先顺序）：
   - **F（数据面）最先**：新增/变更 SyncKind、op 字段、回放规则必须先改 `SyncEngine`/`LocalDatabase` 与 Kotlin 单测；否则手机同步会静默缺内容。
   - **A（窄代理）**：`EngramLocalServer` 加代理行；能力位（若新开）三处同改；未绑定中枢时给中文提示。
   - **C（布局/手势/返回）**：壳层 600/840 档、`registerBackHandler`、`pointer.ts`、安全区、热区；补 `lib/*.test.ts` 断言。
   - **D（原生桥）**：Manifest 权限 + Java/Kotlin 桥 + Web 无桥降级 + `ANDROID.md` 说明。
   - **B（Web 通用）**：确认窄窗/触屏成立即可。
3. **验证**：`pnpm test`（含 web 安卓断言）→ Android builder 容器跑 `testDebugUnitTest`（阶段二接入日常 CI；此前在发版构建时也会跑）→ 真机/模拟器矩阵（§4.6）。
4. **更新文档与清单**：`docs/ANDROID.md` 增补；`MOBILE-SYNC-LEDGER.md` 关闭/新增条目；在 CHANGELOG 里为后续发版预备"安卓端"素材。
5. **发版交付**：bump 三处版本（Android 自动派生）→ CHANGELOG 写**自上一个 Android 版本以来的累积改动** → 打 tag → dispatch `binaries` → APK 与 exe 补挂 Release → 覆盖安装验证（签名一致、数据不丢）。

**手机端"陈旧"的四个可观测维度**（排查用）：

1. 能力位 false / 整组 UI 消失（预期内的能力差异）；
2. 同步日志出现未知 op kind 的 warn（手机缺功能，内容静默缺失）；
3. 旧端点 404 被容错吞掉（旧中枢/旧手机都无感）；
4. 原生桥缺失 → UI 静默隐藏（用户看不到"少了功能"）。

### 5.4 每周手机巡检清单（30–90 分钟）

- [ ] 跑 `bash main/scripts/platform-parity-check.sh --since <上次巡检 ref>`：看契约检查 + 缺声明提交清单。
- [ ] 看 `MOBILE-SYNC-LEDGER.md`：待办是否有超过 14 天 / 目标版本临近的条目；逐条推进或改派。
- [ ] 拉最新 main 构建一次 Android（builder 容器或本机环境），跑 `testDebugUnitTest` + 真机/模拟器冒烟（冷启动、首页、收集箱、设置、返回键、安全区）。
- [ ] 抽查 1–2 个近期 Windows 新功能在手机上的表现（尤其是设置页/导航入口/浮层）。
- [ ] 同步日志是否出现新的未知 kind/字段 warn（有则按 F 类补）。
- [ ] 更新本文件 §2 矩阵（若这周新增了平台差异）。

> 小团队/单人维护时，可把"每周"降级为"每 2 周或每累计 5 次功能合并"，但**发版前全量对齐不可省**。

### 5.5 发版前全量对齐门禁

发版（用户明确要求时）必须全部满足，缺一不发：

1. `bash main/scripts/platform-parity-check.sh --strict` 通过（版本号三处一致、能力位键集、桥、构建链、设置域、滞后清单无当前版本待办）。
2. `MOBILE-SYNC-LEDGER.md` 中目标版本 ≤ 本次版本的待办清零（或改「不适用」并写原因）。
3. CHANGELOG 有 `## v<版本>（YYYY-MM-DD）` 段落，且**安卓段写全自上一个 Android 版本以来的累积改动**。
4. 三件套齐全：APK（本次发版提交构建、签名一致）+ Windows exe + Docker 镜像（`:<版本>` + `:latest`）。
5. 手机端已对齐：本版本区间的 A/C/D/F 类改动都有手机侧实现或明确的"不适用"记录。
6. 真机/模拟器冒烟通过（§4.6）；发布说明已写清安卓用户如何升级（OTA/覆盖安装）。

### 5.6 滞后清单（MOBILE-SYNC-LEDGER）规则

- 文件：`main/docs/MOBILE-SYNC-LEDGER.md`；一行一条，状态仅限 `待办/进行/完成/不适用`。
- 触发登记：任何 A/C/D/F 类改动**未能在本分支完成**手机侧适配时，合并前必须登记；B/E/none 不登记。
- 目标版本：写计划补齐的发版号（如 `v1.5.7`）；不允许空。
- 关闭：手机侧完成后改「完成」并写提交 hash；确认手机不需要做的改「不适用」并写原因。
- 门禁：发版 bump 后，`platformParity.test.ts` 会失败于「待办行的目标版本 = 当前版本」；`--strict` 脚本同样检查。
- 周检：超过 14 天未动的待办必须升级处理（拆小、排期或明确降级为「不适用」）。

### 5.7 紧急修复流程

| 缺陷类型 | 处理 |
| --- | --- |
| 纯 server/web，手机同步/使用不受影响 | 合 main → 推送获批 → `:main` 滚动镜像 + 桌面源码模式即可拿到；必要时打 hotfix 版本（三件套照发） |
| 影响同步数据面 / 手机功能 | 必须按 F 类补手机侧；无法补时在滞后清单登记，并在发布说明中说明限制 |
| 影响 Android 启动/登录/数据安全 | 立即 hotfix 发版，APK 必须重新构建并覆盖安装验证 |
| 纯 Docker 部署问题 | 优先改配置/镜像，不改共享代码另起分支；发 hotfix 版本或仅更新部署文档 |

无论哪种：**不得跳过 verify；不得复用旧产物打 exe/APK；不得在未获批准时推送/发版**。

### 5.8 同步完成状态怎么判断

- **Docker 已同步**：`:main` 镜像 digest 对应 main 最新提交（或 `:latest` 对应发版 tag）；容器已更新且 `/health` 正常；设置页提交号匹配。
- **Android 已同步**：APK `versionName` = 发版版本；目标版本内所有 A/C/D/F 改动已在手机端验证；滞后清单该版本无待办；CHANGELOG 安卓段可回溯到具体提交。
- **Windows 已同步**：main 已包含改动；桌面源码模式/安装包用户可更新；桌面壳能力回归通过。

---

## 6. 审计与门禁

### 6.1 自动门禁（已落地，随 verify 跑）

新增 `main/web/src/lib/platformParity.test.ts`，在 `pnpm test`（Docker verify / release verify）中执行，静态检查：

1. **版本号一致**：`desktop/package.json` = `web/src/version.ts` = `docker-compose.yml` 镜像 tag。
2. **Android 版本派生**：`build.gradle` 引用 `desktop/package.json`，不写死 `versionName/versionCode`。
3. **内嵌 Web 构建链**：`prepare-desktop.js` 复制 `web/dist`、`prepare-mobile-web.cjs` 复制 `../web/dist`、Dockerfile 构建 `@engram/web`、`desktop/package.json` 的 `files` 含 `web/dist/**`、Capacitor `webDir=web-dist`。
4. **能力位三处键集一致**：web `fullCapabilities`、server `runtime.ts`、Kotlin `EngramLocalServer.kt` 的 feature 键集合相等。
5. **能力位语义**：`apkUpdate` 仅 Android true；`agentAdmin/mcp/onlyOffice/serverUpdate/ddns` 在 Android 侧 false；`syncRoles`、`runtime` 取值符合契约。
6. **平台绑定契约**：Web 侧使用的每个 `__engram*` 桥名都能在 Android 源码找到实现。
7. **设置域手机可达性**：`SETTINGS_DOMAINS` 的每个大类都在手机 `MOBILE_GROUPS` 中（`account` 由账户卡特判），防止新增设置大类在手机永久不可达。
8. **滞后清单**：文件存在；无「目标版本 = 当前版本」的待办行。
9. **文档覆盖**：每个能力位键/运行形态值都出现在本文件中（防止能力位加了、文档漏了）。

> 该测试只读源码、无网络/无依赖；Dockerfile 已把 `docs/PLATFORM-PARALLEL-DEV.md`、`docs/MOBILE-SYNC-LEDGER.md`、`docker-compose.yml` 复制进 build 阶段供测试读取。

### 6.2 人工巡检（脚本）

`main/scripts/platform-parity-check.sh`：

```bash
bash main/scripts/platform-parity-check.sh                 # 只跑契约检查
bash main/scripts/platform-parity-check.sh --since v1.5.6  # + 列出该区间缺平台影响声明的提交
bash main/scripts/platform-parity-check.sh --since v1.5.6 --strict   # 发版前：缺声明即失败
```

用途：每周巡检、发版前置、合并前自查（verify 内已跑契约部分，脚本用于人工快速复核与提交声明审计）。

### 6.3 发版门禁

- release.yml 既有门禁：tag=版本、CHANGELOG 段落、verify、未签名 APK 失败。
- 新增人工门禁（发版操作卡）：`platform-parity-check.sh --strict` + 滞后清单清零 + 安卓累积更新核对 + 三件套归档（记录提交 ID、构建时间、sha256）。
- 阶段二可将 strict 检查接入 release.yml 的 verify 前置步骤（届时另开任务实现并验证）。

### 6.4 阶段二/三可选的自动化增强（不在本次范围，登记为改进项）

1. **Kotlin 编译门禁**：ci.yml 在 main 推送且改动含 `main/mobile/**` 时，用 `mobile/Dockerfile.ci` 跑 `testDebugUnitTest`（gradle 依赖已预热，离线可行）。
2. **产物身份戳**：Web 构建写 `build-info.json {version, sha, builtAt}`，prepare 脚本复制后断言版本一致；exe/APK 内可读，解决"APK 是否来自本次提交"无法验证的问题。
3. **release.json 自动生成**：release.yml 整理产物时产出（版本/commit/run/sha256），替代人工归档。
4. **协议版本字段**：`/api/sync/snapshot` 增加只读 `syncProtocol`，手机可提示"中枢协议较新，请升级 App"。
5. **桌面桥契约测试**：preload 暴露方法与 Web 调用集合的双向校验（先做 warning）。
6. **设计令牌 debt 清理**：补 spacing/type/motion 标尺，收敛 322 处 hex / 854 处裸 px；统一 768 与 600/840 两套断点。

---

## 7. 风险与对策

| # | 风险 | 后果 | 现有兜底 | 本规范对策 |
| --- | --- | --- | --- | --- |
| 1 | 三处版本号漏 bump | 页面/镜像/安装包版本错位，更新检测异常 | 仅 release.yml 校验 tag↔desktop | 契约测试（verify）+ 发版 strict 脚本 |
| 2 | 新增能力位漏改 Kotlin | 手机 fail-open 露出桌面功能（死入口/白屏） | 无 | 三处键集测试 + 文档矩阵 + A 类清单 |
| 3 | 新增设置大类未进手机分组 | 手机永久不可达 | 无 | 设置域可达性测试 |
| 4 | 复用旧 `web/dist` 打 exe/APK | 安装包里是旧前端（版本号对、行为错） | 打包手册人工要求 | prepare 构建链测试 + 打包 checklist + 阶段二 build-info |
| 5 | 新增 SyncKind 只改 server/web | 手机静默缺内容（同步显示成功） | 手机未知 kind 只 warn | F 类强制 + 未知 kind 处理清单 + Kotlin 单测要求 |
| 6 | 手机适配无限期滞后 | 发版前才发现手机没跟上 | 无 | 滞后清单 + 每周巡检 + 发版门禁 |
| 7 | 768 与 600/840 两套断点冲突 | 768–839 出现"medium 壳 + 桌面页面" | 部分测试锁常量 | 新增代码以 600/840 为准；登记设计债；周检抽查 |
| 8 | 原生桥缺失/未降级 | 桌面或手机出现死按钮/报错 | 样板（biometric/insets） | 桥契约表 + 无桥降级要求 + Web 桥名测试 |
| 9 | owner 级接口被手机代理 | 成员令牌越权 | 服务端鉴权分层 | 端点归属表 + E 类规则 + 安全审查 |
| 10 | Windows 打包回归（ABI/node.exe/dsh） | exe 启动失败（历史事故） | CI 脚本断言 + 手工验证清单 | 沿用既有清单，不因三端并行简化 |
| 11 | Docker 部署漂移（tag/manual compose） | 版本落后、更新失败 | 更新通道 + 文档 | 部署验证清单 + 发版归档 |
| 12 | 破坏性同步协议变更 | 旧手机/旧中枢静默错位 | 多读少写/未知跳过 | 协议变更评审 + 发版说明 + 阶段二协议版本字段 |

---

## 8. 落地路线

### 阶段一（本次已落地，随本文件合并）

- 本规范文档 + 平台契约矩阵 + 操作逻辑矩阵 + 同步节奏与检查清单。
- 根 `AGENTS.md` / `main/AGENTS.md` 新增三端并行规则与平台影响声明要求；项目规则 2 扩为三端。
- `platformParity.test.ts` 契约门禁（verify 内自动跑）；server `runtime.ts` 补 `apkUpdate: false` 占位，键集三处对齐。
- `main/scripts/platform-parity-check.sh` 巡检/发版脚本。
- `main/docs/MOBILE-SYNC-LEDGER.md` 滞后清单。
- `Dockerfile` 复制契约测试所需文件；`README.md`/`docs/ANDROID.md`/`BUILDING.md`/`GITEA-CI.md` 增加指针。

### 阶段二（建议 1–2 周内，另开 worktree）

- Kotlin 编译/单测接入 ci.yml（仅 `main/mobile/**` 变更时触发）。
- Web 构建产物 `build-info.json` + prepare 断言 + release.json 自动生成。
- 将 `platform-parity-check.sh --strict` 接入 release.yml 的 verify 前置。
- 补桌面桥契约测试（warning 级）。

### 阶段三（可选，按需）

- 同步协议版本字段与手机升级提示。
- 统一断点口径（页面级 768 → 600/840），清理历史设计债。
- 设计令牌标尺（spacing/type/motion）与 hex/裸 px 门禁。
- 评估"手机滚动预发布通道"：**默认不做**（系统安装确认不可省、版本比较与签名成本高），维持发版 APK。

---

## 9. 检查清单速查

### 9.1 每个功能（合并前）

- [ ] 已分类 A–F（可多类）。
- [ ] Windows 验收（桌面形态，截图）。
- [ ] Docker 形态成立（同源 + 容器冒烟，改到运行配置时）。
- [ ] Android：同分支完成 / 滞后清单登记（A/C/D/F 必做）。
- [ ] 能力位三处同改（若新增）。
- [ ] 新桥：原生 + Web + 无桥降级 + 本文件登记（若新增）。
- [ ] 新接口：本地/窄代理/owner 归属明确（若新增）。
- [ ] 新同步 op/字段：手机侧 + 旧端降级（若新增）。
- [ ] 文档更新（ANDROID/README/本文件矩阵）。
- [ ] 提交信息末行 `平台影响:`。
- [ ] `verify-feature.sh` 通过。

### 9.2 每周（手机对齐窗口）

- [ ] `platform-parity-check.sh --since <上次巡检>`。
- [ ] 滞后清单逐条处理（>14 天升级）。
- [ ] 构建一次 Android + `testDebugUnitTest` + 真机冒烟。
- [ ] 抽查近期 Windows 功能在手机的入口/设置/返回。
- [ ] 同步日志新 warn 检查。
- [ ] 本文件矩阵与设计债更新。

### 9.3 发版前

- [ ] 用户明确要求发版（否则不发）。
- [ ] `platform-parity-check.sh --strict` 通过。
- [ ] 滞后清单目标版本清零。
- [ ] 三处版本号 bump 一致 + CHANGELOG 段落（安卓累积写全）。
- [ ] 三件套：镜像 `:版本`/`:latest`、exe、签名 APK（基于发版提交）。
- [ ] 手机/桌面真机冒烟 + 覆盖安装验证。
- [ ] 产物归档 `releases/<版本>/`（提交 ID、构建时间、sha256）。
- [ ] 推送/tag/dispatch/部署均获用户批准。

### 9.4 热修

- [ ] 影响面分类（是否触及 F 类/Android）。
- [ ] 修复验证（verify + 真实路径）。
- [ ] 需要时同步手机侧与滞后清单。
- [ ] 发版流程同 9.3（不得跳过）。

---

## 10. 附录

### A. 平台差异面清单（UI / 操作逻辑）

| 差异面 | Windows / Docker | Android | 承载位置 |
| --- | --- | --- | --- |
| 运行形态 | 内嵌 Node 进程 / 容器 | WebView + 本地 Ktor | `desktop/main.js` / `EngramLocalServer.kt` |
| 能力位 | 全量（apkUpdate=false） | 窄集 + 绑定中枢联动 | `runtime.ts` / `EngramLocalServer.kt` |
| 原生动作 | `nativeActions=[]` + wikiDesktop | 3 个声明（暂未消费）+ 6 组桥 | `preload.js` / Android 桥类 |
| 数据源 | 本机库 / 中枢本机 | 本机库 + 成员同步 + 窄代理 | `docs/ANDROID.md` |
| 同步角色 | none/hub/member | none/member | capabilities `syncRoles` |
| 骨架断点 | 640/768/1024 页面 | 600/840 壳层 + 设备姿态 | `windowSizeClass.ts` / `Home.vue` |
| 导航 | rail + 常驻侧栏 | 底栏/rail/三栏 + 我的面板 | `Home.vue` |
| Agent | 可拖宽右侧抽屉 | <840 独立页；≥840 抽屉 | `router.ts` / `AgentView.vue` |
| 设置 | 7 大类双栏 | 账户卡 + 6 行分组 + 子页 | `SettingsView.vue` |
| 收集箱 | 桌面工作台 | 卡片台（≤768） | `InboxViewRoute.vue` / `MobileInbox.vue` |
| 返回 | 无系统返回 | 浮层→抽屉/阅读→路由→历史→退后台 | `MainActivity.java` / `androidBack.ts` |
| 安全区/键盘 | 0 | 原生 insets + `kb-open` | `systemInsets.ts` / `main.css` |
| 指针/热区 | hover、右键、tooltip、拖宽 | 长按面板、48dp、无 tooltip | `pointer.ts` / `main.css` |
| 手势 | 拖拽/拖放 | 下拉刷新、卡片三向、长按多选 | `Home.vue` / `MobileInbox.vue` |
| 触觉/折叠 | 无 | 轻振 + 开关；medium 双栏/tabletop | `haptics.ts` / `Home.vue` |
| 更新 | serverUpdate / 桌面 OTA | apkUpdate OTA | `SettingsView.vue` 等 |
| 桌面壳 | wikiDesktop 桥 + 标题栏 | 无 | `App.vue` / `preload.js` |
| 事件流 | `/api/events` SSE | 无（必须门控） | `mobileLayout.test.ts` 已锁 |

### B. 能力位矩阵（速查，详细见 §1.4 / §3.1）

- 桌面/Docker 端：`agent/agentAdmin/agentConsole/videoConfig/mcp/jobs/onlyOffice/serverUpdate/ddns/backup/fileExtraction=true`，`apkUpdate=false`；`onlyOffice` 受配置影响。
- Android 端：`agent/agentConsole/videoConfig` 随「已绑定中枢」；`agentAdmin/mcp/onlyOffice/serverUpdate/ddns=false`；`jobs/apkUpdate/backup/fileExtraction=true`。
- 运行形态：`runtime ∈ {server, desktop, android-local}`；`localFirst` 桌面/手机 true；`agentMode ∈ {local, hub, unavailable}`。

### C. 命令速查

```bash
# 契约检查（合并前/每周/发版前）
bash main/scripts/platform-parity-check.sh
bash main/scripts/platform-parity-check.sh --since v1.5.6
bash main/scripts/platform-parity-check.sh --since v1.5.6 --strict

# 开发验证（Docker 内 build+typecheck+test）
bash main/scripts/verify-feature.sh <feature>

# 预览（需要真实页面时）
bash main/scripts/preview-feature.sh <feature> <port>

# 合并并自动清理
bash main/scripts/merge-feature.sh --cleanup <feature>

# 列出手机影响面（自上个 Android 发版 tag 起）
git log v1.5.6..HEAD --oneline -- main/mobile main/web/src/lib main/server/src/sync main/server/src/routes/sync.ts

# Android 构建（builder 容器，与发版一致）
cd main && docker build -f mobile/Dockerfile.ci -t engram-android-builder .
# 详见 docs/ANDROID.md 与 docs/BUILDING.md
```

### D. 术语

| 术语 | 含义 |
| --- | --- |
| 产品内核 | `main/server` + `main/web`，三端唯一事实源 |
| 运行壳 | 桌面 Electron 壳 / Docker 容器 / Android Capacitor 壳 |
| 能力位 | `/api/runtime/capabilities` 的 `runtime` / `features.*` / `nativeActions` / `syncRoles` |
| 平台差异四层 | 能力位 → 窗口尺寸档 → 页面断点/整页分叉 → 原生桥与全局 CSS |
| A–F 分类 | 功能对手机的影响类型（§4.1） |
| 滞后清单 | `MOBILE-SYNC-LEDGER.md`，登记未完成的手机适配 |
| 平台影响声明 | 提交信息末行 `平台影响: A,B` 等 |
| 滚动镜像 | `:main` tag，主分支测试通道，非正式发布基线 |

### E. 参考文件

| 文件 | 用途 |
| --- | --- |
| [`AGENTS.md`](../../AGENTS.md) / [`main/AGENTS.md`](../AGENTS.md) | 开发协作规则（含三端并行条目） |
| [`WORKTREES.md`](../WORKTREES.md) | worktree 生命周期、验证、合并、清理 |
| [`BUILDING.md`](./BUILDING.md) | 构建/发版/部署完整手册 |
| [`GITEA-CI.md`](./GITEA-CI.md) | CI/CD、镜像、发版踩坑 |
| [`ANDROID.md`](./ANDROID.md) | Android 架构、能力边界、同步、OTA、验收 |
| [`MOBILE-SYNC-LEDGER.md`](./MOBILE-SYNC-LEDGER.md) | 手机端滞后清单 |
| `main/web/src/lib/capabilities.ts` / `main/server/src/routes/runtime.ts` / `EngramLocalServer.kt` | 能力位三处实现 |
| `main/web/src/lib/*.test.ts` | 现有 UI/平台护栏测试范式 |
