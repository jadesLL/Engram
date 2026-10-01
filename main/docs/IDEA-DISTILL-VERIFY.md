# 灵感自动提炼（idea-distill）· 独立验证报告

- 验证者：`verify-idea`（独立验证，**只读功能源码**；本文件是本次唯一写入）
- 验证对象：`worktrees/idea-distill/main`，分支 `feat/idea-distill`，HEAD `2d84390` + 未提交改动（快照时间 2026-10-01 23:52 +08:00）
- 口径来源：[`docs/IDEA-DISTILL-SPEC.md`](./IDEA-DISTILL-SPEC.md)（以其第 1 节「已冻结的实现决定」为准）
- 验证方式：只读代码审查 + `node --test`/`tsx` 实跑 + 自建不变量脚本 + SFC/模板编译产物核对
- 未跑：`main/scripts/verify-feature.sh`（Lead 正在跑 Docker verify，避免资源争用）、`pnpm install`（网络限制）

> **Lead 追加（2026-10-02 00:0x）：本报告结论基于修复前快照。**下列条目已在本 worktree 内修好，并各自补了测试/复跑：
> - P1 `.editor-area` 漏 `!quiet` → 已加门（Lead 修；这正是本报告写「未在浏览器截图确认」的那一条）。
> - P3-L2 通知文案/动作三处偏差 → 已按冻结口径改（skipped-edit 按钮「查看」、failed「再试一次」真的重新入队并提示、去掉多余的 sticky 语义差异）。
> - P3-L3 `pending → running` 重复弹 info → `notifyOnce` 改按「通知键」去重（两档合成一条）。
> - P3-L4 死导出 `dismissToast` → 已删；`isIdeaPage` 字面量维持（前端没有 rawSections 等价模块，注释已说明）。
> - P3-L1 撞名 `-N` 后 frontmatter 标题 ≠ 文件名 → 提炼侧改为**先算唯一标题再改名**（`uniqueIdeaTitle`，撞名加 `(2)` 而非 `-2`），并新增用例「同一天两条灵感拟出同一个标题」钉住「frontmatter 标题 == 文件名」。
> - P2 Android 窄代理未放行两个新接口 → **本轮不修**，按下文口径记为 Android 限制（见「已知限制」）。
>
> 最终是否通过以 Lead 的 Docker verify + 真机预览验收为准；本文件保留原始快照与证据，便于追溯。

被验证快照的 sha256 前 16 位（写入报告时的工作区版本）：

| 文件 | sha256(16) |
| --- | --- |
| `server/src/routes/ideas.ts` | `EF1852B650C789DA` |
| `server/src/lib/ideaDistill.ts` | `A2407028B63B9E2F` |
| `server/src/jobQueue.ts` | `2AE58A700CF98383` |
| `server/src/jobs.ts` | `D1BE5A59865AE054` |
| `web/src/views/EditorView.vue` | `C3CCB49704835F85` |
| `web/src/lib/ideaDistillFeed.ts` | `5445485962270B60` |
| `web/src/lib/ideaDistill.ts` | `CD98D0ADCD6497A5` |
| `web/src/lib/quickNote.ts` | `3F96EAB2BE70C6D2` |
| `web/src/views/Home.vue` | `6DC1185434964217` |

---

## 1. 结论

**不通过（1 个阻塞项 + 1 个中等项 + 若干低项）** —— 针对验证当时的快照（见文首 Lead 追加说明：阻塞项与低项已在同一 worktree 内修复，中等项 Android 按限制口径收尾）。

服务端行为（三段接口、六种 staged、任务执行体、不变量）全部实测通过；前端通知/状态口径基本对得上；但**纯净模式在「记一条灵感」主路径上会与完整编辑器同时渲染**（`EditorView.vue` 的 `.editor-area` 漏了 `!quiet` 门），这是 SPEC 第 5 节验收路径上的显性缺陷，必须先修；另有 Android 窄代理两个新接口未放行（SPEC 已声明本次不改 Kotlin，但 SPEC 3 末条承诺的降级推导并未实现，需按文档口径收尾）。

---

## 2. 缺陷清单（按严重度）

### P1（阻塞）· 纯净模式与完整编辑器同时渲染

- 位置：`web/src/views/EditorView.vue:289`
  ```html
  <!-- 其余三处都加了 !quiet：L141 topbar / L230 editor-body / L391 statusbar(v-if) -->
  <div v-show="!app.readingMode" class="editor-area">
  ```
  同一文件里 topbar / editor-body 用 `v-show="!app.readingMode && !quiet"`、statusbar 用 `v-if="!app.readingMode && !quiet"`，**只有承载 `<MarkdownEditor>` 的 `.editor-area` 漏掉了 `!quiet`**。
- 为什么可达（主路径，不是边角）：
  - `Home.vue:500-506`：左下角「+」(L68)、手机底座「新建」(L422)、`Ctrl+N`(L514) 都走 `quickNote()` → `createIdeaNote()` 返回后 **先 `app.setReadingMode(false)`(L504) 再 `router.push('/page/'+id)`(L505)**；
  - `EditorView.vue:1441-1445` 欢迎页「记一条灵感」同样 `setReadingMode(false)`（L1444）后跳转；
  - 落到新灵感页时 `readingMode === false`、`quiet === true` ⇒ `.quiet`（`v-if="quiet"`）与 `.editor-area`（`v-show="!readingMode"`）**同时可见**；
  - 两者都是 `.editor-view{display:flex;flex-direction:column}` 的 `flex:1` 子元素（`.quiet` L2250 / `.editor-area` L1932），页面被上下切成两半；文件里没有任何 `.quiet` 兄弟选择器或 `:has()` 兜底。
  - 任何「本会话已关掉沉浸阅读」的入口（Wiki 页点「返回编辑」→`closeReading()` L1152；Home 新建页面 L495；EditorView `createFirst()` L1435）之后再从侧栏点开灵感，也会复现。
- 证据（编译产物，非目测）：用主检出 `vue/compiler-sfc` 编译该模板后，render 代码里只有三处 `_vShow`：
  - `[_vShow, !$setup.app.readingMode && !$setup.quiet]`（topbar）
  - `[_vShow, !$setup.app.readingMode]`（MarkdownEditor 外层 `.editor-area`，片段尾部为 `["modelValue","dark","mode","page-id","fullscreen"]`）
  - `[_vShow, !$setup.app.readingMode && !$setup.quiet]`（editor-body 或 statusbar）
- 最小复现（浏览器，桌面端）：
  1. 打开应用默认沉浸阅读（`readingMode=true`）；
  2. 按 `Ctrl+N`（或点左下角「+」）→ 写一句话 → 「记下来」→ 等约 1.2s 自动关框；
  3. 跳到 `/page/<新灵感 id>`：纯净视图与完整 Vditor 编辑器上下同时出现（本会话内即稳定复现）。
- 建议修法（由 Lead 决定）：`.editor-area` 改成 `v-show="!app.readingMode && !quiet"`；`quickNote()` 那两处面向灵感页的 `setReadingMode(false)` 也就变成无害。
- 置信度说明：**静态证据 + 编译产物证据确凿，但我在本机没有浏览器可截图确认**（无 jsdom/playwright），请 Lead 在真实界面按上面 3 步确认后归档截图。

### P2（中）· Android 窄代理未放行两个新接口，且 SPEC 承诺的降级未实现

- 事实：
  - 服务端（中枢）三个接口都过同一道 `requireAssistantAccess`，成员令牌实测可调（见 §3.2）。
  - 但 `mobile/android/app/src/main/java/com/engram/app/EngramLocalServer.kt:505-506` 的路由表仍只有 `POST /api/ideas/preview` 与 `POST /api/ideas`；`get("/{path...}")` 对 `api/` 前缀**显式 404**（同文件 `:651-658`）。
  - 因此 Android 上：`GET /api/ideas/:id/distill` → 404「接口不存在」；`POST /api/ideas/:id/distill/retry` → 404。`GET /api/jobs` 在本地服务里恒返回空数组（`:442`）。
- 实际影响（原文不丢，属体验缺口）：`trackIdeaDistill` 轮询永远拿不到状态 → 完成通知不弹；成品页恒显示「未提炼」、无「正在后台提炼…」细提示；侧栏的「提炼中/提炼失败」永不出现（数据源 `app.jobs` 在 Android 上恒空）；点「重新提炼」只会弹一条「暂时没法重新提交」的 info。
- 与 SPEC 的差距：SPEC 第 3 节末条同时写了「本次不改 Kotlin」和「前端在拿不到该接口时用『上次已知状态 + `/api/jobs` 里同 `payload.path` 的任务状态』推导」——**后半句在代码里没有实现**（`web/src/lib/ideaDistillFeed.ts:182-189` 拉取失败只返回 null 并继续轮询；`web/src/lib/ideaDistill.ts` 的行状态只读 `app.jobs`，而 Android 的 `app.jobs` 恒空）。
- 处置建议：本轮按 SPEC 只记录（合并说明/CHANGELOG 里明确「Android 端成品页暂不显示提炼状态、完成通知暂不弹」，下一步补 Kotlin 两条路由或补 `/api/jobs` 降级）。

### P3-L1（低）· 撞名 `-N` 分支下 frontmatter 标题 ≠ 文件名

- 复现（我自建脚本的撞名用例，实测 output）：
  `path=原始资料/灵感碎片/2026.10.01_同题撞名用例-2.md  frontmatter=2026.10.01_同题撞名用例`
- 触发条件：同一天两条灵感被模型拟出**同一个标题**（同文重记、或模型给出相同短标题）；第二条走 `renamePageSafely` 的 `pagePathTaken` 分支加 `-2` 后缀，而 `renamePageSafely` 仍把不带后缀的 `title` 写进 frontmatter（`server/src/lib/renamePage.ts:101-119`）。
- 性质：根因在既有 `renamePageSafely`（非本次新代码），但本次功能让它可达；当前不影响页面显示（展示标题去前缀后一致）、也不影响重试（第二次 `desired === title` 不再改名），属命名一致性缺口。SPEC「改名后 frontmatter 标题与文件名一致」在这条分支上不成立。
- 最小复现：见 §4.4 的撞名用例 / 下面这条命令：
  `node --import tsx .tmp-verify-idea/verify-invariants.ts`（第 4 节「撞名（-N 后缀）」两条断言）。

### P3-L2（低）· 通知文案/动作与 SPEC 4.2 的小偏差

| SPEC 4.2 | 实现 | 说明 |
| --- | --- | --- |
| `skipped-edit` 主动作「查看」 | `查看成品 →`（`ideaDistillFeed.ts:207`） | 与 done 复用同一按钮文案，无害但非冻结文案 |
| `failed` 主「再试一次」→「重新跟踪并提示『请在成品页点重新提炼』」 | 直接 `openIdeaPage(id)` 打开成品页（`:210-217`），无提示 | 行为上等价（成品页有「重新提炼」按钮），但没有 SPEC 说的提示语，也没走「重新跟踪」 |
| `failed` 未标 sticky | 实现为 `sticky: true`（`:143`） | 失败提示不会自动消失；属产品选择，与冻结文案不一致 |

### P3-L3（低）· `pending → running` 会弹两条同文案 info 通知

`notifyOnce` 按 `staged` 去重（`ideaDistillFeed.ts:200-204`），`pending` 与 `running` 是两个 key 但 `distillToastFor` 给的是同一条文案「正在后台提炼这条灵感」。正常时序：POST 返回 pending → 首次轮询收到 `pending` 弹一条 → 队列开跑后轮询收到 `running` 再弹一条相同文案。加上 `quickNote` 自己的「已记下，正在后台提炼」，一次记录在 1.5s 内可能出现 2-3 条相似提示（同屏上限 4 条，会把其他提示挤掉）。

### P4（信息）· 死导出 / 未接线的收尾钩子 / 口径重复

- `web/src/lib/ideaDistillFeed.ts:295` `export { dismissToast }` 全仓无人引用（`ToastHost.vue` 直接 import `notify`）。
- `resetIdeaDistill()`（注释写「仅供测试/登出清理」）在 `stores/auth.ts:32 logout()` 里没有被调用：登出后已存在的跟踪链最多再轮询 5 分钟（401 只会静默失败，不会弹错），影响极小。
- `EditorView.vue:793` 用字面量 `startsWith('原始资料/灵感碎片/')` 判定灵感页，服务端用 `rawSectionOf(rel)==='idea'`（`server/src/lib/rawSections.ts`）；当前一致，但目录口径有两份来源。
- `openFullEditor()` 会 `app.setReadingMode(false)`（`EditorView.vue:982`）：会话内其他页面（含 Wiki 页）不再默认进沉浸阅读。与既有 `createFirst()`/`quickNote()` 的口径一致，故只记为信息项；但与 SPEC 5「用一次会话内的开关实现（quietOverride）」的描述相比多了一次全局状态改动。

---

## 3. SPEC 逐条对照

### 3.1 `POST /api/ideas`（SPEC 2.1）— 通过

| 条目 | 结果 | 证据 |
| --- | --- | --- |
| 不带 `title`：落盘 + 入队，立即 200 | ✅ | 自建脚本：200 且 `{ok,id,path,title:'随手记',jobId,distilling:true}`；jobs 行 status=pending |
| `title` 兜底语义 | ✅ | 返回 `title: displayTitle(pageTitle)`（同名加序号时为「随手记 (2)」） |
| 带 `title`（含空串）：落盘即所见即所得，不入队 | ✅ | 自建脚本 + 仓内用例：`findIdeaDistillJob({id})` 为 undefined；空串退化成「随手记」 |
| `preview` 分支保留 | ✅ | 200 且不落盘（灵感碎片目录文件数不变）；前端已无调用点（见 §5） |
| 空正文 400 / 超长 413 文案不变 | ✅ | 复用 `ideaContent()`，仓内用例覆盖 |
| `hash` = 落盘后完整内容（含 frontmatter）sha256 | ✅ | 我用 `node:crypto` 独立算整文件 sha256，与 payload.hash 逐字节相等；只算正文得到的哈希不同（§4.2） |
| payload 含 `{id,path,hash,createdAt}` | ✅ | 自建脚本断言 |
| 入队后立即可查 | ✅ | GET distill 返回 pending + 同一 jobId |
| `jobId` 兜底（enqueue 去重时回当前任务 id / null） | ✅ | `enqueueIdeaDistill` 先按 path 找 active 任务（`jobQueue.ts:96-104`） |

### 3.2 `GET /api/ideas/:id/distill`（SPEC 2.2）— 通过

| 条目 | 结果 | 证据 |
| --- | --- | --- |
| 六种 staged | ✅ | 仓内 15 条路由用例全绿：pending/running/done/skipped-edit/failed/unknown 都有断言；`cancelled → failed` 也有 |
| `pending/paused → pending` | ✅ | `ideas.ts:103-112`；用例插 paused 行后映射为 pending（同组用例覆盖） |
| `done + result.staged=skipped-edit → skipped-edit` | ✅ | 用例断言 `distilled=false`、`reason=edited`、`error=null` |
| 无页面/无任务 → unknown，字段全空且不 404 | ✅ | 用例断言逐字段为空、未知 id 仍 200；脏载荷（非 JSON）也不抛 |
| `reason` 机器码 | ✅ | failed 给 `result.reason ?? 'error'`；skipped-edit 给 `edited`；其余为 null |
| `distilled` = done 时 true | ✅ | 用例断言 |
| running 时 title=当前页面标题、明细为空 | ✅ | 用例断言 pending/running 的 `fixes/pending/refined` 为空 |
| 权限 `requireAssistantAccess`（成员令牌可用） | ✅ | 仓内成员令牌用例（`createPeer`）三条接口全 200；我实跑该用例通过 |
| 范围限制（非灵感页不泄漏） | ✅ | 额外实现：Wiki/「原始资料/文档」页一律 unknown、retry 404（SPEC 未要求但更严，用例覆盖） |

### 3.3 `POST /api/ideas/:id/distill/retry`（SPEC 2.3）— 通过

- 读当前磁盘 → sha256 → 入队 ✅（payload.hash 与当前文件一致，用例断言）
- 同 path 已有 pending/running → 复用同一 jobId + `reused:true`，不产生第二条 ✅（仓内用例 + 我的入队去重脚本：pending/running/done 三种前置状态都验过）
- 未知 id / 文件不存在 → 404 `{error:'这条灵感已经不在了'}` ✅
- 终态任务后重试会**新入队**（`dedupeRecent:false` 生效，不被 60s 窗口吞）✅（我的脚本专门验了这条）

### 3.4 后台任务 `idea_distill`（SPEC 3）— 通过

- 五档阶段文案与进度 10/35/60/95 ✅（仓内用例逐条断言，含未知阶段兜底 50）
- 改写条件：两次 sha256 比对（读原稿、落笔前），不等 → `skipped-edit` + `reason=edited` + 只写日志 ✅
- 改写方式：`renamePageSafely(id, 日期前缀+ideaFileTitle(title), {syncH1:false, allowSamePath:true})` → `writePage(stripLeadingHeading(text).trim()+'\n')` → `enqueuePagePipeline(id)` ✅；`RenameError('标题未变化')` 视为不改名（用例覆盖），其他 RenameError → failed 原文保留
- 明细日志：`appendWikiLog('灵感提炼', …summarizeFixes…)` ✅（实测日志含「勘误 1 处：北子所→北自所」与「精炼 N→N 字」）
- 失败不删文件不改内容 ✅（draft 抛错 / 文件不存在 / 取消 / 无模型四种分支用例 + 我的 mtime 断言）
- 真实任务队列接线（jobs.ts → 执行器 → 状态回填）✅ —— 我用真队列跑了无模型凭据的端到端：job 变 `failed`、`job.error=「没接模型，已按原文记下」`、`payload.result.staged=failed / reason=no-model` 存活未被收尾覆盖、业务状态查询 `staged=failed / distilled=false / error` 正确、文件字节与 mtime 不变（§4.5）
- 取消语义（`context.signal` 透传，取消后绝不落笔）✅（用例覆盖模型前/模型后两种取消）

### 3.5 前端 lib 契约（SPEC 4.1-4.4）— 基本通过

- `notify.ts`：三个方法签名不变（返回 id 是无害增强）✅；全仓 `notify.*` 调用点没有一个传第二个参数的（grep `notify\.(success|error|info)\([^)]*,`：0 处）→ 既有调用点不受影响；sticky 不倒计时、同屏 4 条优先退非 sticky 最老 ✅（`notify.ts:49-70`）
- `ToastHost.vue`：无 title/actions 的旧通知仍走 `.toast-body > .toast-text`，样式未回归；带 title/actions 的通知新样式 ✅（SFC 编译通过）
- `ideaDistillFeed.ts`：`trackIdeaDistill`/`useIdeaDistill`/`IdeaDistillState` 与冻结签名一致 ✅；轮询 1.5s→5s、上限 5 分钟 ✅；同 id 跟踪幂等 ✅；通知文案与四种状态对得上（三处小偏差见 P3-L2）
- `ideaComposer.ts`：单态 `{open,content,busy,error,phase}` ✅；`SubmittedIdea{id,path,title,jobId}` ✅；`step/preview/draft/draftTitle/draftText/previewIdeaComposer/confirmIdeaComposer/backToEdit/canConfirmIdea/IdeaDraft/IdeaPreviewer` 已删且全仓无残留引用（只剩测试注释里的一行说明）✅；busy 拒绝关闭、queued 关框回传结果 ✅（含安卓返回键路径 `globalBackLayers.ts:49`）
- `IdeaComposer.vue`：约 1.2s 自动关框（`IDEA_QUEUED_AUTO_CLOSE_MS=1200`，watch phase）+ ✕/Esc/遮罩立即回传 ✅；按钮三拍文案与 SPEC 一致 ✅；`queued` 期间输入不可改 ✅
- `quickNote.ts`：① info「已记下，正在后台提炼」② `trackIdeaDistill` ③ 返回 `{id,path}` ✅（仓内 quickNote 用例 + 我的实跑）

### 3.6 纯净模式（SPEC 5）— **不通过**（P1）

| 条目 | 结果 |
| --- | --- |
| 只作用于 `原始资料/灵感碎片/**`、不依赖 `readingMode` | ✅ |
| 隐藏页头控件区/工具条/底部状态栏与右下三个入口 | ⚠️ topbar/editor-body/statusbar（含「来源/页面图谱/本页关联」三个右下入口）都隐藏了；**但 `.editor-area`（Vditor 编辑器）没隐藏 → P1** |
| 只留 返回+面包屑 / 标题（去日期前缀）/ 元信息 / 正文 / 折叠明细 / 底部四动作 | ✅（四动作齐全，`<details>` 明细按需渲染） |
| 编辑原地展开、退出回只读、保存后标「已手动修改」 | ✅（`quietEditing` + 快照取消 + `IDEA_MANUAL_EDITED_LABEL`） |
| 「在完整编辑器里打开」= 会话内开关 | ✅（`quietOverride`，换页/刷新复位）+ 见 P4 的全局 readingMode 副作用 |
| 提炼中细提示 + done 后热更新 | ✅（`quiet-banner` + `distillState.staged==='done'` 时 `loadPage`，`dirty` 时不覆盖） |
| 移动端同一套、动作一行横向可滚 | ✅（同一模板；`.quiet-actions{overflow-x:auto;white-space:nowrap}`） |

### 3.7 侧栏（SPEC 6）— 通过

`running → 小转圈+「提炼中」`、`failed → 「提炼失败」`、`done/pending/paused/cancelled 不标` ✅（纯函数用例 6 条全绿）；数据源 `app.jobs.active/recent` + `payload.path` 精确匹配 + 取 id 最大的一条 ✅（`Home.vue:310-315` 每 6s 轮询 `/api/jobs`）。
注：轮询间隔 6s，端上模型很快时「提炼中」可能整个生命周期都观察不到——口径正确，仅记录该时序特性。

---

## 4. 我实跑的命令与结果

> 全部在**主检出**的临时目录里跑（worktree 无 node_modules），未跑 `verify-feature.sh`/`pnpm install`；临时目录跑完已删除（§6）。

### 4.1 Web 全量（借贷主检出 node_modules）

```powershell
cd C:\WorkSpace\Engram\main\web
node --test ".tmp-verify-idea/src/**/*.test.ts"     # Lead 给的搬运法
# → 330 tests / 326 pass / 4 fail
```
4 条失败的性质（**均为环境噪音，非本次改动**）：
- 3 条 ENOENT：`mobileLayout.test.ts` 的安卓接线用例按 `mainRoot = 测试文件上溯 3 层` 读 `mobile/...`；搬运多了一层目录，`mainRoot` 落到 `main/web` ⇒ 找 `main/web/mobile` 必失败（唯一原因）。
- 1 条：`qrEncode.test.ts` 模块加载失败 `Cannot find package 'jsqr'` —— 借贷的 `main/web/node_modules` 里**从未安装过 jsqr**（`main/node_modules/.pnpm` 里也没有），与本次改动无关（`git status` 里 `qrEncode*` 未改动）。

**为证明前 3 条纯属路径噪音**，我另建了与仓库同形的目录（`repo/web/src` 副本 + `repo/mobile`、`repo/server` 目录联接 + `web/index.html`、`web/package.json`），再跑：

```powershell
cd C:\WorkSpace\Engram\main\web
node --test ".tmp-verify-idea/repo/web/src/**/*.test.ts"
# → 330 tests / 329 pass / 1 fail（只剩 jsqr 缺失这一条环境噪音）
```

### 4.2 本次改动直接相关的 Web 用例

```powershell
cd C:\WorkSpace\Engram\main\web
node --test ".tmp-verify-idea/repo/web/src/lib/ideaComposer.test.ts" `
             ".tmp-verify-idea/repo/web/src/lib/quickNote.test.ts" `
             ".tmp-verify-idea/repo/web/src/lib/ideaDistill.test.ts" `
             ".tmp-verify-idea/repo/web/src/lib/ideaDistillFeed.test.ts"
# → 33 tests / 33 pass / 0 fail
```

### 4.3 服务端新增/改动用例

```powershell
cd C:\WorkSpace\Engram\main\server
node --import tsx --test ".tmp-verify-idea/src/lib/ideaDistill.test.ts"      # → 10/10 pass
node --import tsx --test ".tmp-verify-idea/src/routes/ideas.test.ts"        # → 15/15 pass（含成员令牌三条接口）
```

### 4.4 我自建的不变量交叉验证脚本（28 通过 / 1 失败）

```powershell
cd C:\WorkSpace\Engram\main\server
node --import tsx .tmp-verify-idea\verify-invariants.ts
```

覆盖与结果：

| 不变量 | 结果 |
| --- | --- |
| 同 path 二次入队（payload 不同 / 任务已 running）复用同一 jobId，在跑任务数恒为 1 | ✅ 5 条断言全过 |
| 不同 path 不被互相吞；终态后重试=新任务 | ✅ |
| `payload.hash` == 我独立算的整文件 sha256；只算正文哈希不同 | ✅ |
| 新灵感 frontmatter（id/创建日期）+ `readPage().meta.title` == 文件名 | ✅ |
| `skipped-edit`：字节 + **mtime** 都不变、不调模型、不改名 | ✅（入队后手改、模型调用期间手改两种） |
| 改名：旧文件不残留、目录里只有一份、frontmatter 标题==文件名、pages 行同步、正文无 H1、日志含勘误+精炼 | ✅ |
| 真队列（无模型凭据）→ job failed + error 人话 + `payload.result` 存活 + 业务状态 failed + 原文/mtime 不变 | ✅ 5 条断言 |
| 撞名 `-N` 分支 frontmatter 标题 == 文件名 | ❌ → P3-L1 |

### 4.5 既有行为的相邻回归（服务端）

```powershell
cd C:\WorkSpace\Engram\main\server
node --import tsx --test ".tmp-verify-idea/src/jobs.test.ts" `
  ".tmp-verify-idea/src/lib/ideaNote.test.ts" ".tmp-verify-idea/src/lib/renamePage.test.ts" `
  ".tmp-verify-idea/src/routes/rawSections.test.ts" ".tmp-verify-idea/src/pipeline/indexFile.test.ts"
# → 43 tests / 43 pass / 0 fail
```

### 4.6 SFC 编译检查（node --test 不覆盖 .vue）

```powershell
cd C:\WorkSpace\Engram\main\web
node .tmp-verify-idea\check-sfc.mjs <IdeaComposer|ToastHost|Sidebar|FileRow|EditorView>.vue
# → 5 通过 / 0 失败（parse + compileScript + compileTemplate 全部无错）
```
模板编译产物核对（`check-quiet-gates`/`dump-gates3`）：见 P1 证据。

---

## 5. 死代码 / 未接线专项

- **前端调用了不存在的接口**：无。全仓 `api.get/post` 里涉及本次功能的只有 `/api/ideas`、`/api/ideas/:id/distill`、`/api/ideas/:id/distill/retry`、`/api/jobs`，四个服务端都存在。
- **`/api/ideas/preview` 已无前端调用点**（grep 0 命中）——按 SPEC 2.1 保留给脚本/老客户端；Android 本地服务仍代理它（老 APK 的旧 web 包仍会调），服务端行为未变 ✅。
- 实现但无人调用的导出（不影响功能，可清理）：`ideaDistillFeed.ts` 的 `export { dismissToast }`；`stopTrack`/`resetIdeaDistill` 仅测试调用（后者注释写「登出清理」但登出未接，见 P4）。
- `IDEA_DISTILL_KIND`（web）/ `IDEA_DISTILL_STAGES` / `IdeaDistillStaged|Reason|Options|Fix|Refined`（server）等为对外类型/常量，属合理 API 面，不算死码。
- `notify.success/error/info` 既有调用点全部兼容（无第二参数调用点；返回值由 void 变 number 是安全增强）✅。

---

## 6. 临时文件清理

验证用的临时物（均在主检出、非 worktree、不在 Git 里）：

1. `C:\WorkSpace\Engram\main\web\.tmp-verify-idea\`（`src` 副本、`repo` 同形布局、mobile/server 目录联接、SFC/模板检查脚本）
2. `C:\WorkSpace\Engram\main\server\.tmp-verify-idea\`（`src` 副本、`verify-invariants.ts`）
3. `%TEMP%\engram-verify-idea-*`（脚本内建的 DATA_DIR，脚本自己删；脚本异常那次我手工删过一遍）

跑完已全部删除（见收尾复核：`main` 与 worktree 的 `git status` 无新增未跟踪文件）。

---

## 7. 未覆盖风险（我没验到的地方）

1. **浏览器真实渲染**：无 jsdom/playwright，纯净模式的像素级表现（明暗两套、430/900/1440 三档无横向溢出、底部动作条横滚、`Vditor.preview` 渲染结果）全部未验证；P1 是按编译产物判定的，请以 Lead 的浏览器截图为准。
2. **build + typecheck**：按指示未跑 `verify-feature.sh`（Lead 正在 Docker 跑）；我用 `tsx` 实跑了服务端全部相关模块（能加载=语法/类型擦除层没问题），用 `vue/compiler-sfc` 编译了 5 个改动过的 SFC，但 `vue-tsc --noEmit` 级别的类型错误不在我的覆盖内。
3. **真实模型路径**：本机无模型凭据，done 分支的真实改写（模型返回值、`acceptIdeaPolish` 门禁、改名实际效果）由注入桩与仓内用例覆盖，缺少一次真模型端到端。
4. **Android 端真机**：只做了 Kotlin 路由表静态核对（P2），未构建 APK、未真机跑。
5. **并发/竞态**：`enqueueIdeaDistill` 在单进程 Node 里是同步 SELECT+INSERT，未做多进程/多实例并发验证（当前架构单实例，风险低）。
6. **`/api/jobs` recent LIMIT 20**：若库内任务量大，失败的 idea_distill 可能被挤出 recent 窗口导致侧栏徽标消失；未构造大规模场景验证。
7. `cancelled → failed` 的口径（SPEC 未明说，实现按 failed 处理）我只做了用例层面的确认，没有走一次真实「数据维护取消」流程。

---

## 8. Lead 收尾（本轮结论与已知限制）

**本轮交付口径（合并说明要照抄这段）**

- 本轮把「记灵感」的第二步确认去掉：按下即落盘（原文进 `原始资料/灵感碎片/`），勘误/精炼/拟标题由后台任务 `idea_distill` 做，完成弹**可点通知**，点开是**只读成品页**（灵感碎片专属的「纯净模式」，与编辑器的沉浸阅读解耦）。
- 已完成：P1 阻塞项、P3-L1（撞名 frontmatter 一致）、P3-L2/L3（通知去重与文案）、P4 死导出清理；Docker verify（build/typecheck/test）与真机预览在合并前由 Lead 再跑一遍并附截图。
- 未做（**已知限制，本轮不修**）：
  1. **Android 端**：本机 Ktor 服务的窄代理路由表只放行 `POST /api/ideas`（老兼容路径），未放行 `GET /api/ideas/:id/distill` 与 `POST retry`。手机端因此：灵感**能记下**（落盘照旧走中枢），但拿不到提炼状态 —— 不会弹「提炼完成」通知、成品页恒显示「未提炼」、侧栏没有「提炼中/失败」徽标。补两条 Kotlin 路由即可对齐桌面端，列入下一轮。
  2. **正文含 http 外链图片**的灵感：落盘后 `remoteImages` 会本地化图片并改写文件，导致提炼时的哈希比对不等 → 该条走 `skipped-edit`（内容安全、原文在，但这次不提炼）。纯文本灵感不受影响。
  3. 侧栏「提炼中」徽标最多滞后约 6 秒（数据源是 `Home.vue` 的 `/api/jobs` 轮询节奏）。
