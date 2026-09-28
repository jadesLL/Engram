# Android 本地优先版

Engram Android 端不是远程网页壳。APK 打包与桌面/服务器相同的 Vue 界面，并在应用进程内启动只监听 `127.0.0.1:18182` 的 Kotlin/Ktor 服务；WebView 始终访问这个本地入口。知识内容保存在应用私有目录，断网时页面编辑、搜索、图谱、附件、归档、回收站和备份恢复均可使用。

## 能力边界

- Android 只能作为同步成员，不能签发成员令牌或充当中枢。
- 同步仅由冷启动/回到前台、本机写入和用户手动全量对账触发；没有同步 SSE、WorkManager、常驻前台服务或通知。应用进入后台时会断开当前请求，SQLite 待推队列保留到下次前台继续。
- 页面、附件、删除、移动和证据快照沿用 Node 中枢的 `/api/sync/*` 协议；首次绑定同路径以中枢内容为准，本机独有内容上传。页面并发由中枢按现有三方合并与冲突副本规则裁决。
- **连接通道择优（局域网 → IPv6 → IPv4 → 断开）**：中枢在 `/api/sync/announce` 里通告自己的内网地址，手机把它们与配置的中枢地址排成候选逐个探测（局域网候选 1.5 秒超时），局域网通就走内网直连，否则回到中枢地址按双栈选 IPv6/IPv4，全部不可达时显示「已断开」（本机改动照常排队，下一轮自动重试）。探测节流为「首次 + 每 10 分钟」，改开关或改绑定立即重探；探测**不写进双栈记账**，避免「探测说断开、同步其实正常」。通道现状经 `/api/sync/status` 的 `link` 字段给界面——侧栏状态胶囊显示「局域网 / IPv6 / IPv4 / 已断开」，设置 → 多端同步 → **局域网优先** 可开关（关掉只按中枢地址连）。中枢还没有这个通告端点时按中枢地址归类通道，不误报断开。
- 会话与任务看板不落本地副本：手机的聊天与看板经窄代理读中枢那一份（会话同步只同步完成态，看板全端唯一一份）。同步引擎遇到 `session` / `board` 两类 op 显式跳过；协议比本端新时的未知类型不再静默吞掉——记一条 warn、水位照常推进，升级手机端即可补齐。
- 同步详情与桌面端同口径：逐条记录带「哪个文件 + 什么增量 + 改动正文采样」（`data.changes`，单条 20 行 / 1400 字预算），支持 视角 / 事件 / 级别 / 关键字 筛选；本机推送被中枢合并时记一条 `push-merged`，说清「本机与中枢都有改动，已按中枢合并结果写回」。
- 本机名称取中枢配置的成员名：每次全量对账从快照的 `device` 字段学回（`sync_device_label`），还没连上中枢时退回手机型号；设置页「多端同步 → 本机名称」与对话来源徽标都用它。
- **收集箱与「记一条灵感」走中枢**（语义转换、模型拟标题与落盘前勘误都在中枢）：中枢这两条内容面接口与 `/api/assistant/**` 同一道门（成员 token 或 owner / MCP token），手机只持同步成员令牌即可用；未绑定中枢时给出明确提示而不是报错。图片资产「挂载到…」（`POST /api/assets/attach`）在手机上本地实现：把未归属散图移进目标页面目录并把引用追加进正文。
- 原始资料 md 改「分类」与桌面端同口径：可移动到 `原始资料/文档`、`原始资料/对话`、`原始资料/灵感碎片`（不再是「只能留在 Wiki 目录」）。
- 不在手机上运行 dsh/MCP/CLI，也不下发模型 Key；完成成员绑定后，聊天抽屉通过本机 loopback 服务把 Agent 交互窄代理到 Docker 中枢。会话与长任务留在 24 小时在线的服务器上，手机退后台只断开 SSE，不会取消已经提交的任务，回到前台后按 active run 与快照接续。
- 不提供同步中枢管理、Agent 模型配置、DDNS/TLS、Docker/桌面更新、ONLYOFFICE 在线编辑或 OCR。同步来的 AI 工作区与证据仍可只读查看。
- PDF.js 提取 PDF 自带文字层，浏览器兼容组件解析 DOCX/PPTX/XLSX 并把确定性文本写入本地搜索索引；图片和扫描 PDF 不做 OCR。
- Android 系统分享面板可把文字、单个或多个文件直接收进本地 `原始资料/文档`（原始资料的三个二级目录之一）；文件按 64 KiB 分块复制、遵守 200 MB 单文件上限，写入后进入正常同步待推队列。

## 数据与安全

应用数据位于 Android app-specific storage 下的 `engram/`：

```text
engram/
├── brain/       # Markdown 与附件真源
└── wiki.db      # 页面/文件索引、搜索词、图谱、回收站、证据、同步水位和待推队列
```

- 每次启动扫描 `brain/` 与索引对账；数据库可由文件库重建。
- 登录密码使用 PBKDF2 哈希；同步成员令牌与本地会话密钥由 Android Keystore AES-GCM 密封保存，不进入 SQLite 或备份。
- 所有本地、上传、恢复与同步路径均做 canonical 越界校验；写入先落同盘临时文件再原子替换；普通文件同步单文件上限 200 MB，收集箱文件同步不设固定单文件上限；网络和文件复制采用流式处理。
- Android 私有目录会在卸载时删除。设置 → 知识库数据 → 备份与恢复 可导出 v2 备份：`manifest.json + brain/ + portable-metadata.json`，不含密码、会话和同步令牌；导入旧版 `wiki.db + brain/` 时忽略旧数据库并从 `brain/` 重建本机索引。
- 旧远程 APK 原地升级后，只把已保存服务器地址预填为候选中枢地址；仍需成员令牌，不会静默启用同步或覆盖本地库。

## 工程结构

```text
main/mobile/
├── capacitor.config.json       # appId=com.engram.app，webDir=web-dist，adjustMarginsForEdgeToEdge=disable
├── scripts/prepare-mobile-web.cjs
├── scripts/build-apk-ci.sh     # Web build → 复制资产 → cap sync → Gradle test/assemble
├── Dockerfile.ci
└── android/app/src/main/java/com/engram/app/
    ├── MainActivity.java       # 生命周期、WebView、系统分享与下载、返回键与启动层
    ├── SystemBars.java         # 透明系统栏 + insets 交给网页 + 系统栏图标明暗跟随应用主题
    ├── SystemBarPolicy.java    # 系统栏策略纯逻辑（JVM 单测：insets JSON 契约、API 版本差异）
    ├── BackPolicy.java         # 返回键判定纯逻辑：网页 → 历史 → 退后台
    ├── BiometricUnlock.java    # 系统解锁桥（指纹/人脸/锁屏密码 + Keystore 密封的登录密码）
    ├── EngramLocalServer.kt    # loopback Ktor REST/静态服务
    ├── AgentBridge.kt          # Docker Agent 交互面窄代理
    ├── LocalDatabase.kt        # Markdown/SQLite/备份/回收站
    ├── SyncEngine.kt           # 前台一次性成员同步
    └── SecretStore.kt          # Android Keystore
```

`mobile/web-dist/` 是构建产物，不入 Git。每次打包必须先构建 `@engram/web`，再运行 `prepare:web` 和 `cap sync android`。

## 系统栏与返回手势

安卓系统栏是完全边到边（edge-to-edge）的，网页背景一直铺到屏幕边缘，状态栏/导航栏区域不会再出现一条独立色带：

- **透明系统栏**：`SystemBars.install()` 关掉 `windowOptOutEdgeToEdgeEnforcement` 时代的 opt-out，改用 `WindowCompat.setDecorFitsSystemWindows(false)` + 透明 `statusBarColor`/`navigationBarColor` + 关掉系统蒙层（API 29+ `setNavigationBarContrastEnforced(false)`）。
- **图标明暗跟随应用主题**（不是系统深色开关）：网页在 `applyTheme()` 之后调 `window.EngramSystemBars.setDark(dark)`，原生据此设置 `setAppearanceLightStatusBars/NavigationBars`，并把选择记进 SharedPreferences 供下次冷启动使用。
- **安全区由原生注入**：WebView 里 `env(safe-area-inset-*)` 不可靠（恒为 0），所以原生把 `systemBars()`/`ime()`/挖孔的尺寸经 JS 接口 `EngramSystemBars.insets()` + `window.__engramSystemBars(json)` 交给网页；网页在 `web/src/lib/systemInsets.ts` 写进 `--inset-*`，样式层统一用 `--safe-top/right/bottom/left`（`max(env(...), var(--inset-*))`）。软键盘只用来加 `html.kb-open`（底部常驻栏收起），不加进底部安全区——布局视口本来就随键盘收缩。
- **`adjustMarginsForEdgeToEdge` 必须保持 `disable`**：Capacitor 的 `auto/force` 会给 WebView 自己加 margin，网页视口被内缩、安全区仍然算不出来，正好把上面这套废掉。
- **返回键/侧滑返回**：`MainActivity` 的 `OnBackPressedCallback` 先 `evaluateJavascript("window.__engramHandleBack()")` 问网页是否消费（关确认框、长按菜单、资产/同步日志抽屉、对话抽屉、文件树、阅读目录面板……注册入口是 `web/src/lib/androidBack.ts`），网页不要才 `webView.goBack()`，历史到头才 `moveTaskToBack`。启动期 `loadDataWithBaseURL` 的占位页在首帧就绪时用 `clearHistory()` 清掉，避免根页面按返回退到空白页。`@capacitor/app` 的 `backButton` 在这个壳里不可用（页面来自 `http://127.0.0.1:18182`，Capacitor 桥没有注入该 origin），不要改回去用它。

## 系统解锁（指纹 / 人脸 / 锁屏密码）

本地库的会话 cookie 最长 30 天，过期或退出登录后仍会回到登录页。登录页的「指纹 / 人脸解锁」调用的是**系统自己的解锁界面**，应用不自绘图案锁，也不引入 `androidx.biometric`（全部走框架 API，离线构建不需要新依赖）：

- **Android 11+（API 30）**：`BiometricPrompt` + `setAllowedAuthenticators(BIOMETRIC_WEAK | DEVICE_CREDENTIAL)`——录了指纹/人脸就走生物识别，没录就落到锁屏密码，弹窗长什么样由系统决定；
- **Android 9/10（API 28-29）**：同一个 `BiometricPrompt`，用 `setDeviceCredentialAllowed(true)`（该 API 在 30 起被 allowed authenticators 取代，但这两档没有等价写法；它与「取消」按钮互斥，所以这两档不设取消按钮，返回键 / 点空白仍可取消）；
- **Android 6-8（API 23-27）**：`KeyguardManager.createConfirmDeviceCredentialIntent()`，由系统出示锁屏验证界面（框架版 `BiometricPrompt` 要求 API 28+）。结果经 `MainActivity.onActivityResult` 转回桥。

网页侧契约在 `web/src/lib/biometric.ts`：`status()`（能力 + 是否已开启）、`remember(password)`、`unlock(requestId)`、`forget()`；解锁结果由原生回调 `window.__engramBiometricResult(requestId, json)` 送回（按 requestId 对号，带 3 分钟超时兜底）。**凭据只有登录密码这一份**：开启后由 `SecretStore` 用 Android Keystore 的 AES-GCM 密钥密封存盘（密钥不可导出、不进备份），只有系统解锁成功之后才会取出交给网页去换会话 cookie；解锁失败、取消或从未开启都不会有凭据离开进程。改密码（设置 → 账户）自动关闭它，避免拿旧密码撞 401；开启只能在登录页做（那里才有明文密码）。桌面端 / Docker 网页端没有这条桥，登录页自动隐藏整块（`biometricStatus()` 返回 null）。


## 本地开发与验证

环境依赖：JDK 21、Android SDK platform/build-tools 35、Node 22 和仓库 pnpm 依赖。下载或安装环境文件前必须按仓库规则取得用户许可。

```bash
cd main
pnpm --filter @engram/web build
node mobile/scripts/prepare-mobile-web.cjs
cd mobile
pnpm exec cap sync android
cd android
./gradlew testDebugUnitTest assembleDebug
```

最低系统版本为 API 23，目标/编译版本 API 35；应用 ID 仍为 `com.engram.app`，版本号仍从 `desktop/package.json` 自动派生。验收至少覆盖 API 23 与 API 35：首次设密和离线 CRUD、进程重启、前后台取消网络、飞行模式编辑后重连、附件流式传输、旧 APK 升级、备份恢复和真实 Node 中枢双向同步。

## CI 与签名

`mobile/Dockerfile.ci` 同时安装主 workspace 和独立 Capacitor 依赖，构建期预热 Android/Gradle 缓存。`mobile/scripts/build-apk-ci.sh` 顺序为：构建 Web → 准备 `web-dist` → `cap sync android` → `testDebugUnitTest` → `assembleRelease`。

release 签名仍读取 `mobile/android/key.properties`（不入库）或 CI 的 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。keystore 丢失后无法覆盖升级既有安装，必须单独备份。日常开发不改版本号、不生成正式 APK。

**发版口径**（2026-09-27 起，见仓库根 `AGENTS.md` 项目规则 9）：

- 发版是显式动作，只在用户明确提出时进行；但**每次发版都必须产出 APK**——它是发版三件套之一（Android APK + Windows exe + Docker 镜像），三件缺一视为该次发版未完成。
- 推 `v*` 标签后立刻 dispatch release.yml 勾选 `binaries`，APK 与 exe 构建完成后自动补挂本次 Release。
- APK 必须基于本次发版提交构建、版本号与 `desktop/package.json` 一致（不得复用旧包）。
- 发版说明里的安卓部分要**补齐自上一个 Android 版本以来累积的全部改动**（安卓端不能源码自更新、可能一次跨过多个版本），并确保手机端代码已对齐这段区间内桌面/Docker 端已有的功能。
