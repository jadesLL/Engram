# 灵感自动提炼（idea-distill）· 接口契约（冻结稿）

> **口径变更（2026-10-02，用户回调）**：第 5 节原先设计的「灵感纯净模式（只读成品页）」**已作废**。
> 用户要求灵感页**与其它页面完全一致**：落页走沉浸阅读、抬头「返回编辑」进完整编辑器、
> 页头 / 工具条 / 底部状态栏照常。现在只保留一行「后台提炼状态行」（ReadingPreview 的 `#status` 插槽：
> 提炼中 / 失败 + 重新提炼），提炼完成就地换稿。实现见 `EditorView.vue` 的 `ideaDistillBanner`
> 与 `components/ReadingPreview.vue` 的状态插槽；第 5 节其余内容只作历史记录保留。

本文件是并行开发的**唯一接口来源**。改这里必须同步通知 Lead；实现细节可以自行决定，但下面这些签名、字段名、状态值、文件归属不能各写一套。

工作目录：`C:\WorkSpace\Engram\worktrees\idea-distill\main`
分支：`feat/idea-distill`（worktree `worktrees/idea-distill`）

## 0. 产品行为（一句话）

写完灵感按下「记下来」→ **立即落盘**（原文、标题兜底）→ 后台任务勘误/精炼/拟标题/改名 → 完成后前端弹**可点通知** → 点开这份灵感页（普通页面：沉浸阅读 + 完整编辑器；提炼未完成时文档头挂一行状态）。不再有「看一眼再记」的二次确认。

## 1. 文件归属（写作用域，勿越界）

| 归属 | 文件 |
| --- | --- |
| Lead | `main/server/src/lib/ideaDistillState`（**已取消**：状态推导留在 `routes/ideas.ts`，见下方冻结点）、`main/server/src/routes/jobs.ts`（仅补 KIND_LABELS）、`main/web/src/lib/notify.ts`、`main/web/src/components/ui/ToastHost.vue`、`main/web/src/lib/ideaDistillFeed.ts`（+ 测试） |
| 后端 | `main/server/src/lib/ideaDistill.ts`（新）、`main/server/src/routes/ideas.ts`（含 `ideaDistillState()` 纯函数）、`main/server/src/routes/ideas.test.ts`、`main/server/src/jobs.ts`、`main/server/src/jobQueue.ts`、`main/server/src/lib/ideaDistill.test.ts`（新） |
| 前端-撰写 | `main/web/src/components/ui/IdeaComposer.vue`、`main/web/src/lib/ideaComposer.ts`、`main/web/src/lib/ideaComposer.test.ts`、`main/web/src/lib/quickNote.ts`（+ 测试） |
| 前端-阅读 | `main/web/src/views/EditorView.vue`、`main/web/src/components/Sidebar.vue`、`main/web/src/components/FileRow.vue`、`main/web/src/lib/ideaDistill.ts`（纯函数：任务→行状态）、`main/web/src/lib/ideaDistill.test.ts` |
| 验证 | `main/docs/IDEA-DISTILL-VERIFY.md` |

**已冻结的实现决定（2026-10-01，改动前先问 Lead）**：

1. 提炼结果存在 **`jobs.payload.result`**（JSON 文本），不新增表/列；它只服务「提炼明细 + staged」的展示，最终状态以页面与文件为准。
2. `jobQueue.ts` 导出 `IDEA_DISTILL_KIND` / `IdeaDistillJobPayload` / `findIdeaDistillJob({id?,path?,activeOnly?})` / `enqueueIdeaDistill(payload)` / `saveIdeaDistillResult(jobId, result)`；同 path 有 pending/running 时复用其 id；`enqueueIdeaDistill` 用 `dedupeRecent:false`（否则「重新提炼」会被 60 秒去重窗口吞掉）。
3. 状态推导的唯一纯函数：`routes/ideas.ts` 的 `ideaDistillState(page, job)`——`pending/paused→pending`、`running→running`、`done + result.staged=skipped-edit → skipped-edit`、`done→done`、`failed/cancelled→failed`、无页面/无任务→`unknown`（unknown 时字段全空且**不** 404）。
4. 「重新提炼」= `POST /api/ideas/:id/distill/retry`：读当前磁盘内容 → sha256 → 入队；未知 id/文件不存在 404 `{error:'这条灵感已经不在了'}`；复用现有任务时返回 `reused: true`。
5. 撰写对话框：落盘成功进 `queued`（按钮「已记下，正在后台提炼」），**约 1.2s 后自动关框**并把结果回传给调用方（用户在这段时间内点 ✕/Esc/遮罩也立即回传）；不做「等用户点关闭」。
6. （已作废）原「纯净模式」只作用于 `原始资料/灵感碎片/**` 且与 `app.readingMode` 解耦；现在**不再有专属形态**，灵感页跟着 `app.readingMode` 走（默认沉浸阅读）。


## 2. 服务端接口

### 2.1 `POST /api/ideas`（改语义：落盘 + 入队，不等模型）

请求：`{ content: string }`（20 000 字上限不变）

成功 200：

```json
{
  "ok": true,
  "id": "<page id>",
  "path": "原始资料/灵感碎片/2026.10.01_随手记.md",
  "title": "随手记",
  "jobId": 123,
  "distilling": true
}
```

- `title`：落盘实际用的标题（未提炼前是兜底标题 `随手记`；若正文首句能给出非空标题也可用首句，二者都可，前端只当"当前标题"用）。
- `jobId`：后台任务 id；`enqueue()` 因去重返回 `undefined` 时，回**当前同 path 的 pending/running 任务 id**；实在没有就 `null`，前端靠 `/api/ideas/:id/distill` 兜底。
- 兼容：旧客户端仍传 `title` 字段 → 落盘即所见即所得，**不**入队提炼（保留这条路，手机端老版本/脚本在用）。
- 校验错误口径不变：空正文 400 `{error:'还没有写内容'}`；超长 413（沿用现有文案）。
- 落盘：复用 `writeIdeaNote({ title: '随手记', content: 原文, note: '' })`（正文原样进文件，`stripLeadingHeading` 照旧）。
- 入队 payload 必须包含：`{ id, path, hash, createdAt }`。
  - `hash`：**落盘后**磁盘上该文件完整内容（含 frontmatter）的 sha256，用 `node:crypto`。
  - 入队后立即可查状态。

### 2.2 `GET /api/ideas/:id/distill`（新增）

```json
{
  "ok": true,
  "staged": "skipped-edit",
  "jobId": 123,
  "jobStatus": "done",
  "title": "京东四向车电机过载要求",
  "path": "原始资料/灵感碎片/2026.10.01_京东四向车电机过载要求.md",
  "distilled": true,
  "fixes": [{ "wrong": "天狼事业布", "right": "天狼事业部", "kind": "知识库既有写法" }],
  "pending": [],
  "refined": { "applied": true, "before": 96, "after": 72 },
  "error": null,
  "reason": null
}
```

- `staged`（**状态唯一口径**）：
  - `pending`：任务还没跑（含 jobId 为空、任务在队列里）；
  - `running`：正在提炼；
  - `done`：提炼完成并已改写；
  - `skipped-edit`：正文在提炼期间被用户改过 → 跳过改写（不算失败）；
  - `failed`：提炼失败（`error` 给一句人话，`reason` 给机器码）；
  - `unknown`：文档不存在或任务记录缺失（接口仍 200，前端按"没有提炼记录"处理）。
- `reason` 机器码（仅 `failed`/`skipped-edit` 时有意义，可空）：
  `no-model` / `too-long` / `same` / `too-verbose` / `rejected` / `edited` / `missing` / `error`。
- `distilled`：是否已有润色稿落地（`done` 时 true）。
- 一条灵感从未提炼过：`staged:'unknown'`、其余字段给空值，**不要 404**（前端省一次异常分支）。
- 任务还在跑（没有 `result`）时：`title` 给**当前页面标题**（还没改名前的「随手记」），`fixes/pending/refined` 给空。前端在 `running` 阶段不读这些字段。
- 权限：沿用 `requireAssistantAccess`（与 `/api/ideas` 同一道门，手机端成员令牌可用）。

### 2.3 `POST /api/ideas/:id/distill/retry`（新增）

对一条已落盘的灵感**重新入队**一次提炼：

- 读当前磁盘内容 → 算 sha256 → `enqueueIdeaDistill({ id, path, hash, createdAt })`；
- 返回 `{ ok: true, jobId, reused: boolean }`：同 path 已有 pending/running 时**不重复入队**，返回现有 jobId 且 `reused: true`；
- 未知 id / 文件不存在 → 404 `{ error: '这条灵感已经不在了' }`；
- 权限同上。

## 3. 后台任务 `idea_distill`

- `handlers.idea_distill` 注册在 `main/server/src/jobs.ts`；执行体写在新文件 `main/server/src/lib/ideaDistill.ts`。
- payload：`{ id: string; path: string; hash: string; createdAt?: string }`。
- 执行体输入输出（供单测直接调）：

```ts
export interface IdeaDistillInput {
  id: string;
  path: string;
  /** 入队时磁盘内容的 sha256；用来判断用户在提炼期间改没改 */
  hash: string;
}
export interface IdeaDistillResult {
  staged: 'done' | 'skipped-edit' | 'failed';
  /** done 后是路径（标题变了会改名） */
  path: string;
  title: string;
  fixes: { wrong: string; right: string; kind: string | null }[];
  pending: string[];
  refined: { applied: boolean; before: number; after: number; reason?: string };
  reason?: string;
  error?: string;
}
export async function distillIdeaNote(
  input: IdeaDistillInput,
  options?: { draft?: (content: string) => Promise<IdeaNoteDraft>; onProgress?: (stage: string, detail?: string) => void }
): Promise<IdeaDistillResult>;
```

- 阶段与 `update({stage, progress, detail})` 文案：`读取原稿`(10) → `勘误专名`(35) → `精炼正文`(60) → `拟标题`(80) → `写入成品`(95)。detail 用人话短句。
- 改写条件：**当前磁盘内容 sha256 === payload.hash** 才改写；不等 → `staged:'skipped-edit'`、`reason:'edited'`，只写操作日志，文件一个字节不动。
- 改写方式：
  1. 若 `draft.title` 非空且与当前页面标题不同 → `renamePageSafely(id, ideaFileTitle(draft.title), { syncH1: false, allowSamePath: true })`，拿 `result.path`；
     注意原始资料的标题是 `YYYY.MM.DD_标题` 形态（含日期前缀），传入的 newTitle 必须是**带日期前缀的完整标题**，日期沿用文件名里已有的前缀，例：`2026.10.01_京东四向车电机过载要求`。
     `renamePageSafely` 抛 `RenameError('标题未变化')` 视为"不用改名"，继续下一步。
  2. `writePage(rel, stripLeadingHeading(draft.text).trim() + '\n', {})` 写正文（保留 frontmatter，不碰标题字段）；
  3. `enqueuePagePipeline(id)`（索引/图谱边）；`emit('page-changed', { path, id })` 由 `writePage` 内部已发，不必重复。
- 明细写操作日志：`appendWikiLog('灵感提炼', '「<标题>」（<路径>）（勘误 N 处：a→b…；精炼 96→72 字）')`，口径参考 `lib/ideaNote.ts` 的 `summarizeFixes`/`summarizeRefine`（可直接复用它们，别另写一份）。
- 失败：不删文件、不改内容；`staged:'failed'`，`error` 一句人话（如 `没接模型，已按原文记下`），`reason` 用 ideaNote 的 `refined.reason`（`no-model` 等）。
- 任务 progress/失败信息同时写进 `jobs`（handler 内部 update 即可，执行器会自动落 failed/done）。
- 手机端不新增接口：窄代理只要把 `GET /api/ideas/:id/distill` 一起转（Kotlin 侧路由表见 `main/mobile`，**本次不改 Kotlin**，在杭州报告里说明手机端当前用轮询降级：前端在拿不到该接口时用"上次已知状态 + `/api/jobs` 里同 payload.path 的任务状态"推导）。

## 4. 前端 lib 契约

### 4.1 `main/web/src/lib/notify.ts`（Lead 实现，其他人直接用）

```ts
export type ToastKind = 'success' | 'error' | 'info';
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** 主要动作（按钮）与次要动作（文字链接）两种样式 */
  primary?: boolean;
}
export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** 标题行（可选）：有标题时 text 作为正文第二行 */
  title?: string;
  actions?: ToastAction[];
  /** true = 不自动消失（完成通知），只能点动作或点关闭 */
  sticky?: boolean;
  /** 整张卡片可点（点它等同于第一个动作） */
  clickable?: boolean;
}
export function pushToast(item: Omit<ToastItem, 'id'> & { duration?: number }): number;
export function dismissToast(id: number): void;
export const toastState: { items: ToastItem[] };
export const notify: {
  success(text: string): number;
  error(text: string): number;
  info(text: string): number;
};
```

- 现有三个方法签名**保持不变**（返回 id 是无害增强），既有调用点不用改。
- `sticky: true` → 不倒计时；非 sticky 才设 3.2s/5.2s/3.6s。
- 同屏最多 4 条：超了**优先退掉非 sticky 的最老一条**，sticky 的留到最后。

### 4.2 `main/web/src/lib/ideaDistillFeed.ts`（Lead 实现，前端两处调用）

前端订阅提炼结果、弹通知的唯一入口：

```ts
/** 开始跟踪一条刚记下的灵感（落盘返回后调用）。内部轮询 /api/ideas/:id/distill，最多约 5 分钟。 */
export function trackIdeaDistill(input: { id: string; path: string; jobId?: number | null; title?: string }): void;
/** 页面读「提炼中 → 完成」状态用；返回 reactive 的当前状态（无数据时 staged='unknown'） */
export function useIdeaDistill(id: string): { current: IdeaDistillState };
export interface IdeaDistillState {
  staged: 'unknown' | 'pending' | 'running' | 'done' | 'skipped-edit' | 'failed';
  title: string;
  path: string;
  fixes: { wrong: string; right: string; kind: string | null }[];
  pending: string[];
  refined: { applied: boolean; before: number; after: number; reason?: string } | null;
  error: string | null;
  reason: string | null;
}
```

- 通知文案（Lead 定稿，前端不用另写）：
  - `running`：info，标题「正在后台提炼这条灵感」，正文「勘误专名 · 精炼正文 · 拟标题，做完会再提醒你一次。」，非 sticky。
  - `done`：success，**sticky + clickable**，标题「灵感已提炼完成」，正文 `《标题》· 精炼 96→72 字 · 勘误 2 处`（没有的段落省略）；动作：主「查看成品 →」（打开 `原始资料/灵感碎片` 里那份文件的纯净模式），次「稍后再看」（关掉通知）。
  - `skipped-edit`：info，sticky，标题「灵感已提炼，但你改过正文」，正文「已保留你手改的版本，没有覆盖。」+ 主「查看」（同样进这份灵感页）。
  - `failed`：error，标题「这条灵感没能提炼」，正文用 `error`；动作：主「再试一次」（重新 `POST /api/ideas/:id/distill/retry` 暂不做 → 改成重新跟踪并提示「请在成品页点重新提炼」），次「知道了」。
- 打开的方式：`router.push('/page/' + id)`——就是普通页面（默认沉浸阅读，抬头「返回编辑」进编辑器）。

### 4.3 `main/web/src/lib/ideaComposer.ts`（前端-撰写）

- 状态机收敛为单态：`{ open, content, busy, error, phase: 'writing' | 'saving' | 'queued' }`。
- `openIdeaComposer()` 返回 `SubmittedIdea | null`，`SubmittedIdea` 字段改为：

```ts
export interface SubmittedIdea {
  id: string;
  path: string;
  title: string;
  jobId: number | null;
}
```

- 删除 `step/preview/draft/draftTitle/draftText/previewIdeaComposer/confirmIdeaComposer/backToEdit/canConfirmIdea/IdeaDraft/IdeaPreviewer`。
- 保留 `canSubmitIdea/computeMaximumChars` 类的纯函数与 `IDEA_MAX_CHARS`。
- 取消语义：`busy`（正在落盘）时不允许取消；`queued`（已落盘）后取消/关闭 = 正常关闭且**回调结果**（不能丢结果）。

### 4.4 `main/web/src/lib/quickNote.ts`（前端-撰写）

`createIdeaNote()` 行为改为：

1. 打开对话框 → 落盘 → 返回 `{ id, path, jobId, title }`；
2. 调 `trackIdeaDistill(...)` 开始跟踪：**「正在后台提炼」与「提炼完成」两条通知都由跟踪层发**，本层不再自己弹 toast（真机验收里「已记下」与「正在后台提炼」曾同时挂在右上角）；
3. 返回值保持 `{ id, path }` 兼容调用方（Home.vue / EditorView.vue 的跳转逻辑不改）。

## 5. 前端阅读（历史设计，已作废）

- ~~「纯净模式」= `原始资料/灵感碎片/**` 的页面~~（**已作废**，2026-10-02 用户要求灵感页与其它页面一致）：**隐藏**页头控件区（分类下拉/标签/更新于）、工具条、底部状态栏与右下三个入口；只留：顶部返回 + 一行面包屑细字、标题（**展示时去掉 `YYYY.MM.DD_` 前缀**）、元信息行（记录时间 · 分类 · 字数 · 提炼状态）、正文、折叠「提炼明细」、底部动作（编辑改一改 / 重新提炼 / 复制正文 / 在完整编辑器里打开）。
- 编辑动作在**原地展开**（标题 input + 正文 textarea），不走 `app.readingMode` 的整页阅读视图；退出编辑回只读。
- 「在完整编辑器里打开」不再需要：灵感页本来就是完整编辑器形态，抬头「返回编辑」即可。
- 提炼中打开：顶部一条细提示「正在后台提炼…」，正文显示当前文件内容；状态变 `done` 后就地热更新（用 4.2 的 `useIdeaDistill`，内容更新走现有 `app.pageVersion` 触发的重载）。
- 移动端（≤640px）同一套：动作收成一行横向可滚，不新增页面。

## 6. 侧栏

- 灵感碎片行状态：`running` → 行尾小转圈 + 文字「提炼中」；`failed` → 「提炼失败」；`done` 不额外标（与既有「已提炼/提取」徽标口径不冲突，避免双标）。
- 数据来源：`useAppStore().jobs.active/recent` 里 `kind === 'idea_distill'` 的任务，按 `payload.path` 精确匹配文件行；状态用任务 `status`（`pending/running/done/failed`）映射，映射函数写成纯函数放 `main/web/src/lib/ideaDistill.ts`（前端-阅读 新增；不要和 4.2 的 `ideaDistillFeed.ts` 混）。

## 7. 验收口径（Lead 最终跑）

- `bash main/scripts/verify-feature.sh idea-distill`：build + typecheck + test 全绿。
- 真实路径：写灵感 → 立刻见到成功提示 → 通知出现（可点）→ 点开就是普通灵感页（沉浸阅读，可返回编辑）。
- 提炼期间改正文 → 状态 `skipped-edit`（手改版保住）。
- 断模型凭据 → `failed` + 「再试一次」入口可见（不丢原文）。
- 明暗两套 + 430/900/1440 三档无横向溢出。
