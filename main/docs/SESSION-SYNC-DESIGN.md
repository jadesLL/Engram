# 内置 Agent 会话多端同步 设计方案

> 状态：**设计稿（未实现）**。本文只描述方案，不改动任何代码。
> 基线：main 分支提交 `e6576e0`（v1.2.7 之后的未发布状态）。
> 结论速览：**技术上可行，且不需要改 dsh**；难点不在数据搬运（已有「证据账本」先例可抄），而在**归属权/单飞语义**与**老版本兼容**两处。

---

## 1. 摘要（TL;DR）

现状：内置 Agent 的会话（六张 `assistant_*` 表 + dsh 会话日志）**不参与**多端同步。设置页对用户是明示的：

> 同步范围：页面、附件图片、原始资料文件与证据账本。各端密码、令牌、**助手会话**、模型配置保持独立。
> —— `main/web/src/components/settings/SyncPanel.vue:173`

本方案要把「会话」变成同步群组里的**第三类一等对象**（与页面、文件并列），使：

- 任一端产生的会话，其余端**可见**（列表 + 历史 + 工具卡 + 子代理卡 + 提问记录）；
- 在**归属端**之外为**只读镜像**，不在镜像端执行任何 Agent 动作；
- 需要换设备接着聊时，走显式**「在此设备继续」= 归属权接管**，而不是让两端同时跑同一个会话。

不解决的事：不追求 dsh 原生会话跨端续接（`dsh_session_id` 不跨进程复用，见 §3.5），续聊上下文继续由 Engram 侧有界历史重建。

---

## 2. 目标与非目标

### 2.1 目标

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 会话可见性：A 端产生的会话，B 端能出现在会话列表并展开全部历史 | 三实例 e2e：A 发一轮 → B 的 `/api/assistant/sessions` 出现该会话且消息条数一致 |
| G2 | 只读安全：非归属端不得触发模型调用、工具执行或知识库写入 | 镜像端 `POST /runs` 返回 409/403，且不产生 dsh 进程、不写 `AIWorks/` |
| G3 | 可接管续聊：显式操作把归属权转到本端，转后本端能继续该会话 | 接管后在本端发一轮 → 原端可见新消息；原端若在跑，该轮被取消并标「归属权已转移」 |
| G4 | 不破坏现状：未升级的成员端/中枢继续按原样同步页面与文件 | 协议协商测试：模拟旧 peer，不得收到 session op，且页面同步全部通过 |
| G5 | 可诊断：同步详情里能看出「这个会话为什么没过来」 | 同步日志新增会话类事件（推/拉/跳过/被保留策略裁掉） |

### 2.2 非目标

- **不**同步 `DATA_DIR/dsh/**`（dsh 自己的会话日志）：跨端无意义且体积大。
- **不**下发模型 Key 与 Agent 配置（维持「各端独立配置」现状，见 `README.md:79` 的表述）。
- **不**做同一会话的实时双端协同（两端同时跑一轮）。这是明确的产品边界，不是技术妥协。
- **不**改 dsh 运行时（`main/server/src/assistant/dshRuntime.ts`）与提示词构建（`prompts.ts`）。
- **不**给 Android 做会话镜像（手机继续走「窄代理复用中枢 Agent」，见 §4.2 路径 1）。

---

## 3. 现状事实（设计约束，全部有代码依据）

### 3.1 同步数据面

| 事实 | 位置 |
|---|---|
| 同步只有四种 op：`page \| file \| delete \| move` | `main/server/src/sync/store.ts:15` |
| oplog 表 + 全局 revision 发号（`settings.sync_seq`） | `main/server/src/sync/store.ts:17-57` |
| 中枢提交只写 oplog + 页面版本快照 + 广播 | `main/server/src/sync/hub.ts:249-280` |
| 中枢 `applyPush` 只认四种 kind，**未知 kind 直接抛错** | `main/server/src/sync/hub.ts:331-467` |
| 成员端应用远端 op：四个 `if`，**无 else 分支**——未知 kind 静默跳过，但第 474 行照常 `setCursor(seq)` **推进水位** | `main/server/src/sync/client.ts:421-474` |
| 路径原语 `safeJoin` 把一切路径钉死在 `BRAIN_DIR` 内，越界抛「路径无效」 | `main/server/src/lib/vault.ts:25-33` |
| 全量对账清单只 walk brain，条目 = `{kind: page\|file, path, hash, revision, distilled}` | `main/server/src/routes/sync.ts:469-525` |
| 唯一随同步走的「数据库行」是证据账本四表（`source_versions`/`ingest_runs`/`ingest_facts`/`page_contributions`），按来源路径**快照物化 + 精确状态替换** | `main/server/src/sync/rows.ts:38-53`、`main/server/src/routes/sync.ts:458-463` |
| 数据面 17 条路由全部在 `/api/sync/*`，无任何会话端点 | `main/server/src/routes/sync.ts:164-463` |
| 自愈：水位只前进不越过失败项、文件待补拉队列、推送指数退避、15 分钟周期全量对账 | `main/server/src/sync/client.ts:765-973` |

**关键推论（兼容性红线）**：新 op 类型对**旧成员端**是**静默丢数据**（跳过 + 推进水位，事后只有「页面/文件清单」的 15 分钟对账能兜底，而它不看会话），对**旧中枢**是**硬报错**（push 被 400 拒绝）。因此协议协商是 M1 的**必需项**，不是优化项。

### 3.2 会话数据落在哪

| 事实 | 位置 |
|---|---|
| `BRAIN_DIR = DATA_DIR/brain`（同步面）；`DB_FILE = DATA_DIR/wiki.db`（会话所在） | `main/server/src/config.ts:11,17` |
| 六张表建在同一 `wiki.db`：`assistant_sessions/messages/runs/tool_calls/subagents/questions` | `main/server/src/lib/db.ts:462-577` |
| 后补列：`assistant_sessions.chat_anchor_id/dsh_session_id/title_source`、`assistant_runs.usage` | `main/server/src/lib/db.ts:594-600` |
| 内置 dsh 的 `DSH_HOME = DATA_DIR/dsh`（会话日志在 `$DSH_HOME/sessions/*/session.v3.jsonl.zstd`） | `main/server/src/assistant/config.ts:49-51`、`dshRuntime.ts:166,176` |
| 全仓 `assistant_*` 引用面：`assistant/**`、`lib/db.ts`、`jobs.ts`、`pipeline/inboxConversation.ts`；**`sync/**`、`routes/sync.ts` 零引用** | 全仓 grep 130 处命中，无一处落在 `sync/`、`routes/sync.ts`；`DSH_HOME`/`bundledDshHome`/`dsh_session_id` 47 处同样不落在 `sync/` |

### 3.3 现有会话表结构与写入频率特征

| 表 | 关键列 | 同步设计要点 |
|---|---|---|
| `assistant_sessions` | `id/title/summary/archived/created_at/updated_at` + `dsh_session_id/title_source/chat_anchor_id` | 元数据小、变更少；**新增归属列** |
| `assistant_messages` | `id/session_id/run_id/role/content/metadata/created_at` | **append-only**，天然便宜；`metadata.kind === 'reasoning'` 的推理段体积大（`routes/assistant.ts:225` 沉淀时也跳过它） |
| `assistant_runs` | `status/step_count/context/usage/error/ingested_path/completed_at` | 一轮一行，终态收敛；`context` 是界面上下文 JSON（小） |
| `assistant_tool_calls` | `name/arguments/risk/status/preview/result/undo` | 每次工具调用两行写入；`arguments/result` 可能很大 |
| `assistant_subagents` | `label/mode/status/stop_reason/result/activity` | **`activity` 每个子代理事件都 UPDATE**（`repository.ts:869,901`）→ 绝不能逐事件同步 |
| `assistant_questions` | `header/question/options/status/selected/answered_at` | 行少；只同步终态即可 |

### 3.4 单飞与并发现状

| 事实 | 位置 |
|---|---|
| 「同会话单飞」的判据是**本端** `assistant_runs` 表 | `main/server/src/assistant/repository.ts:497`（`runningRunForSession`） |
| 冲突返回 409，前端提示 | `main/server/src/routes/assistant.ts:130-136` |
| 排队（`status='queued'`）也只看本端表 | `repository.ts:543`、`routes/assistant.ts:200` |

→ 结论：**没有任何跨端互斥**。若把消息直接双向复制而不管归属，两端会各自认为自己在跑同一会话。这是本方案的核心设计点（§7）。

### 3.5 续聊为什么不受「dsh 日志不同步」影响

| 事实 | 位置 |
|---|---|
| 运行时池：一个 Engram 会话一个 dsh 进程；运行时回收/重启后**换新的 dsh 会话 id** | `main/server/src/assistant/dshRuntime.ts:76-84,186` |
| 原因：SDK 的 `session/prompt` 走 getOrCreate，对已持久化 id 直接抛 `session "…" already exists`（**没有 adopt 分支**） | 同上注释 |
| 上下文衔接靠 Engram 自己的有界历史：**最近 8 条合并消息 × 每条 1200 字** | `main/server/src/assistant/prompts.ts:68-81` |

→ 所以只要**消息表**到了对端，接管后就能接着聊；dsh 会话日志缺失不影响正确性，只影响端内的前缀缓存命中率。

### 3.6 客户端角色矩阵（谁连谁的后端）

| 入口 | Agent 在哪跑 | 会话在哪 | 备注 |
|---|---|---|---|
| 浏览器打开中枢 | 中枢 | 中枢 `wiki.db` | — |
| Android 聊天抽屉（已绑定） | **中枢**（`/api/assistant/**` 窄代理） | 中枢 | `EngramLocalServer.kt:307-344,447-458`；`agentMode=hub`（`:104`） |
| Android 未绑定 | 无（`agentMode=unavailable`） | — | — |
| Windows 桌面端 | 本机内嵌 server（18180） | 本机 `wiki.db` | 旧「远端模式」已移除并清理遗留令牌：`desktop/main.js:95-107` |
| 成员端（任何形态） | 本机（若配了 Key） | 本机 | 会话按本机各存一份 |

---

## 4. 方案选型

### 4.1 候选

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| **A. 归属唯一 + 只读镜像 + 显式接管** | 会话有 `owner_node_id`，各端复制只读副本；换端继续要显式接管 | 中（新增一类同步对象 + 租约） | **推荐** |
| B. 会话记录单向归档（一次性导入/导出） | 「把中枢会话拉到本端」按钮，落成本地只读历史 | 低 | 可作为 M0 过渡，但不满足 G3 |
| C. 全端可跑同一会话 | 每端都能跑，消息双向合并 | 高：重复执行工具、重复写知识库、合并语义地狱 | **不建议** |
| D. 维持现状（都连中枢） | 不改代码，PC 用浏览器打开中枢 | 零 | 现状够用时的正解，但解决不了「桌面端本地库的会话」 |

### 4.2 为什么推荐 A

1. **Agent 运行有物理前提**：跑一轮需要模型 Key、MCP 进程、dsh 运行时、以及**写知识库的权限**——这些都只存在于某一台机器上。让「会话」跟着「能跑它的人」走，语义最简单。
2. **单飞可以退化成现状**：归属唯一时，「同会话单飞」就是归属端本地的 `runningRunForSession`，不需要分布式锁；非归属端根本不允许发起。
3. **冲突面收敛**：唯一需要裁决的写操作是「接管」，其他都是 append-only 的复制。
4. **有先例可抄**：证据账本的「按 id 快照物化 + 精确状态替换」已经证明「DB 行可以随同步走」而不破坏现有游标语义。

---

## 5. 数据模型与镜像范围

### 5.1 新增列 / 新增行（`lib/db.ts` 迁移，沿用 `ensureColumn` 模式，见 `db.ts:594-600`）

```sql
-- 归属与同步水位（本端权威列；镜像行由同步写入）
ALTER TABLE assistant_sessions ADD COLUMN owner_node_id   TEXT NOT NULL DEFAULT '';  -- 空=本端原生（归属本端）
ALTER TABLE assistant_sessions ADD COLUMN origin_node_id  TEXT NOT NULL DEFAULT '';  -- 首次创建来源端
ALTER TABLE assistant_sessions ADD COLUMN mirror_revision INTEGER NOT NULL DEFAULT 0; -- 该会话最近一次镜像 revision
ALTER TABLE assistant_sessions ADD COLUMN mirrored        INTEGER NOT NULL DEFAULT 0; -- 1=本端只是镜像

-- 删除墓碑：会话删除后本端留一行，防止对账时被旧副本"复活"
CREATE TABLE IF NOT EXISTS assistant_session_tombstones(
  session_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT ''
);
```

> 现有 `settings` 表里已有 `sync_node_id`（`sync/store.ts:38-45`），归属端标识直接复用它，不另造节点 id。

### 5.2 镜像范围（逐表）

| 表 | 镜像 | 处理 |
|---|---|---|
| `assistant_sessions` | ✅ 全字段 | 但 `dsh_session_id` **仅作展示/排障**，镜像端**永不**用它接管 |
| `assistant_messages` | ✅ 除推理段 | 默认**跳过** `metadata.kind === 'reasoning'`（体积最大、价值最低，且沉淀时本就被排除）；只同步 `role/content/metadata(裁剪)/created_at` |
| `assistant_runs` | ✅ 终态优先 | `status/step_count/error/usage/completed_at/context/ingested_path`；镜像端**不会**出现 `running` 态（见 §8.2） |
| `assistant_tool_calls` | ⚠️ 摘要 | `name/risk/status/created_at/updated_at` + `result` 截断（默认 2 KB）；**不同步** `arguments`/`undo` 全量（改传截断摘要） |
| `assistant_subagents` | ⚠️ 摘要 | 生命周期字段 + `result` 截断；`activity` **只同步收工后的最终值**（折叠为「N 步」），不逐事件同步 |
| `assistant_questions` | ✅ 只同步终态 | `pending` 不镜像（提问是「本轮阻塞」的，镜像端答了也没用）；`answered/expired/cancelled` + `selected/custom` 同步 |

### 5.3 明确不同步

- `DATA_DIR/dsh/**`（会话日志）。
- 模型 Key、`agent_config`、`settings` 表（**注意**：整库备份会连 `sync_hub_url/token/node_id` 一起搬，见 §11.3）。
- 正在流式生成的中间态（`assistant_messages` 的流式段落只在轮次收口后落库，天然满足）。

---

## 6. 同步协议扩展

设计取向：**不改现有四种 op 的语义**，新增一类并列对象，走「清单 + 按 id 取快照」的拉模型（与证据账本同构），避免污染 `sync_oplog` 的游标语义。

### 6.1 端点

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/sync/sessions` | GET | `requireSyncAccess` | 会话清单：`[{sessionId, title, updatedAt, ownerNodeId, originNodeId, messageCount, maxCreatedAt, contentHash, archived, mirrored}]`；支持 `?since=<revision>` 增量 |
| `/api/sync/session` | GET | `requireSyncAccess` | 按 `?id=<sessionId>` 取**整会话快照**（元数据 + 消息 + 轮次 + 工具卡 + 子代理 + 提问），带 `revision` 与 `hash` |
| `/api/sync/session` | POST | `requireSyncAccess` | 推送本端会话快照（仅**归属端**可推；中枢校验 `owner_node_id`） |
| `/api/sync/session/delete` | POST | `requireSyncAccess` | 会话删除（只允许归属端发起），广播 tombstone |
| `/api/sync/session/takeover` | POST | `requireSyncAccess` | 归属权转移（见 §7.3） |
| `/api/sync/status` | GET | `requireAuth` | **新增能力位**：`protocol: 2`、`features: { sessionSync: true, maxSessionBytes: N }` |

### 6.2 事件与水位

- SSE：新增事件类型 `session`（载荷 `{sessionId, revision, hash, op: 'upsert'|'delete'|'takeover'}`）；成员端收到后**按 hash 决定是否拉快照**（与文件的 `pullFileIfChanged` 同构，`client.ts:436-446`）。
- 会话**不复用** `sync_oplog` 的 `seq` 游标，改用每会话 `mirror_revision`；全量对账时用清单的 `contentHash` 比对（同 `buildSnapshotEntries` 的思路）。
- 理由：会话写入频率远高于页面，塞进同一 oplog 会让页面同步的游标裁剪（`OPLOG_KEEP=5000`，`store.ts:11`）被会话刷爆，把页面变更挤出保留窗口 → 触发不必要的全量对账。

### 6.3 兼容与协商（M1 必需）

1. 中枢在 `/api/sync/peers` 与成员表（`sync_peers`）里记录**对端 protocol 版本**（首次握手时写入，`/api/sync/status` 暴露给成员）。
2. 中枢向成员广播/下发 session 事件前先查该成员支持位：**不支持则不发**（否则旧端会「静默跳过 + 推进水位」，见 §3.1）。
3. 新成员向旧中枢推 session：中枢 `applyPush` 会抛未知 kind（`hub.ts:467`）→ 成员端把这种 400 识别为「中枢版本过旧」并给出人话提示（例：`中枢版本不支持会话同步，请先更新中枢`），并**暂停 session 推送**避免每次重试刷日志。
4. 建议同时给 `/api/sync/status` 增加 `protocol` 字段，让新旧双方都能一眼判定能力（不改旧字段，纯增量）。

---

## 7. 归属权与单飞（本方案的核心）

### 7.1 模型

```
                  ┌──────────────────────────────┐
                  │            中枢 (NAS)         │
                  │  权威 revision / 会话清单/租约  │
                  └───────────┬──────────────────┘
              session upsert  │  session upsert
        ┌─────────────────────┴─────────────────────┐
        │                                           │
   ┌────┴─────┐                               ┌─────┴────┐
   │ 桌面端 A  │                               │ 桌面端 B  │
   │ 归属端    │  ── 只读镜像 ──▶  B 可见全部历史 │ 只读镜像  │
   │ 跑 dsh    │  ◀── 接管请求 ──  B 点「在此设备继续」│ 不跑 dsh │
   └──────────┘                               └──────────┘
```

- 每个会话有**唯一归属端**（`owner_node_id`）。归属端负责：跑 Agent、写消息、写工具卡、收口轮次。
- 其余端持**只读镜像**：能看到全部历史与运行状态（标注「在中枢运行中」），会话列表带「镜像」徽标，输入框禁用，改标题/删除入口隐藏。
- 中枢只是**权威中转与裁决者**：转发行、裁决接管、维护 tombstone；它自己不"拥有"会话，除非它本来就是归属端。

### 7.2 单飞

| 场景 | 行为 |
|---|---|
| 归属端正在跑，镜像端打开该会话 | 显示「A 端正在运行 · 第 N 步」，输入框禁用 |
| 镜像端尝试 `POST /runs` | 服务端**直接 409**（判据：`mirrored=1` 或 `owner_node_id ≠ 本端 node_id`），不进 dsh |
| 归属端自己重复提交（现状） | 保持现有的本端单飞/排队语义（`repository.ts:497`、`routes/assistant.ts:200`） |
| 两个镜像端同时点「接管」 | 中枢按先到先得裁决，后到方收到 409 + 当前归属端信息 |

### 7.3 接管协议

1. B 端 `POST /api/sync/session/takeover {sessionId}`。
2. 中枢检查：
   - 会话存在且归属为 A（否则 409）；
   - **A 端是否有活跃 run**：有 → 两种策略二选一（决策点 D4）：
     - **D4-a（推荐）**：先请 A 端取消（中枢记 `takeover_pending`，A 端在自己的轮询/SSE 里看到后取消当前轮、回执终态），再落权；B 端显示「等待 A 端收尾」。
     - **D4-b**：立即落权，A 端下一轮自己发现失去归属并取消；风险是 A 端可能已产生半轮输出。
3. 中枢把 `owner_node_id` 改为 B、bump revision、广播 `session{takeover}`。
4. A 端收到广播：若本端有活跃 run → **取消**该 run，终态 `cancelled`，`error='归属权已转移到 <B 的设备名>'`；此后本端退化为镜像。
5. B 端收到广播：`mirrored=0`，输入框解禁；下一轮以**镜像到的消息**重建上下文（`prompts.buildTask` 的有界历史），dsh 侧另起新会话 id（天然如此，无需改造）。

> 为什么接管后一定能续聊：§3.5。dsh 不需要"认领"远端会话 id。

### 7.4 归属端离线时的行为（决策点 D5）

- 归属端离线（如笔记本合盖）时，镜像端看到「归属端离线 · 最后在线 X 分钟前」。
- 是否允许在归属端离线时**直接接管**（不需要它回执）？建议允许，但加确认弹窗（因为离线端的未同步输出可能丢失）。M2 里实现为策略开关。

---

## 8. 冲突与一致性规则

### 8.1 消息层（append-only）

- 去重键：`assistant_messages.id`（UUID，天然不冲突；两端各自生成不会撞）。
- 合并：取并集，按 `(created_at, id)` 排序；同一 `run_id` 的连续助手段落由 `metadata.step/segment` 保序（沿用现有「按步分段落库」约定，见 `routes/assistant.ts:216-220`）。
- 不产生「冲突副本」概念：消息不覆盖，只追加。

### 8.2 轮次层

- `status` 收敛：镜像端**永不**写入 `running`；收到 `running` 的行统一显示为 `mirrored-running`（展示态，不入库或入库但标注 `owner_node_id`）。
- 终态优先级：`completed > cancelled > error`（同一 run 若两端都有行，取 `updated_at` 较新者；实测中两端不会同时写同一 run，因为只有归属端能跑）。
- **禁止行为**：镜像端不得把镜像 run 标为失败/取消（那是归属端的职责），避免"隔空改状态"。

### 8.3 会话层

| 操作 | 规则 |
|---|---|
| 改标题 / 归档 | **仅归属端**；镜像端 UI 隐藏入口（后端同时拒绝，不只靠 UI） |
| 删除 | 仅归属端；广播 tombstone；镜像端删本地行但**留 tombstone 行**，防止对账被旧快照复活（对照现有 `stale` 机制，`routes/sync.ts:539-557`） |
| 归属转移 | §7.3 |
| `updated_at` 相同 | 按 `(owner_node_id, revision)` 决出；绝不静默丢，日志里记一行 |

### 8.4 与「沉淀」的关系

`沉淀对话到原始资料`（`routes/assistant.ts:208-239`）产出的是 `原始资料/对话/**` 的**页面**，走现有页面同步（`lib/vault.ts:397` 的 `notifySyncChange('page', ...)`）——**保持不动**。本方案只补上「会话对象本身」的同步；两者不互相依赖。

---

## 9. 体积与保留策略

| 项 | 默认值（建议） | 依据 |
|---|---|---|
| 镜像会话窗口 | 最近 **90 天** 或最近 **50 个会话**（取小，可配） | 会话表是全库写入最碎的表 |
| 单会话快照上限 | **4 MB**（超过则只镜像最近 N 条消息 + 提示"历史已截断"） | 防止一条超长对话拖垮对账 |
| 工具卡 `result` | 截断 **2 KB** | `arguments/undo` 不同步 |
| 子代理 `activity` | 只同步收工后的最终值（折叠计数） | 逐事件同步会被 `repository.ts:869,901` 的 UPDATE 放大 |
| 推理段 | **默认不同步**（开关） | 决策点 D2；需实测占比后再定默认值 |
| 传输触发 | 轮次收口 + 会话元数据变更 | 不在流式过程中同步 |

**体积守门**：会话清单与快照都带 `bytes`，单轮超过 `maxSessionBytes` 直接跳过并记日志（不重试到成功为止），避免自愈机制把大快照反复重传。

---

## 10. 分期落地

### M1 · 只读镜像（最小可用、风险最低）

- 数据模型 + 迁移（§5.1）、协议协商（§6.3）、清单与快照端点（§6.1）、成员端拉取与镜像写入。
- 会话列表显示别端会话 + 「镜像」徽标；输入框禁用；标题/删除入口隐藏。
- **不含**接管；镜像端不能续聊。产出口径：`README`、`CHANGELOG`、`SyncPanel.vue` 的「同步范围」文案要改（把"助手会话保持独立"改成"助手会话只读镜像，续聊需接管"）。
- 验收：G1、G4、G5 + 离线增长补齐 + 删除传播。

### M2 · 接管续聊

- 租约/接管（§7.3）、归属端取消联动、离线接管策略（D5）。
- 会话列表加「在此设备继续」按钮；归属端徽标显示设备名。
- 验收：G2、G3 + 双端同时接管的裁决 + 归属端运行中被接管。

### M3 · 体验与收敛

- 推理段开关、保留窗口可配、同步详情里按会话的事件解释（"这个会话为什么没过来"）、体积仪表。
- 可选：`GET /api/sync/sessions?explain=` 给出被裁原因。

---

## 11. 改动面清单

### 11.1 服务端（主要工作量）

| 文件 | 改动 |
|---|---|
| `main/server/src/lib/db.ts` | 新增列 + tombstone 表（`ensureColumn` 迁移模式） |
| `main/server/src/sync/sessions.ts`（**新**） | `collectSessionSnapshot(sessionId)` / `applySessionSnapshot(snap)` / `listSessionManifest()` / 体积裁剪 —— 对照 `sync/rows.ts` 写法 |
| `main/server/src/routes/sync.ts` | 5 个新端点 + 能力位 + tombstone |
| `main/server/src/sync/hub.ts` | `takeover` 裁决、tombstone 广播、按成员能力过滤下发 |
| `main/server/src/sync/client.ts` | 会话拉取循环（对照 `pullFileIfChanged`）、SSE `session` 事件、未知能力时暂停推送 |
| `main/server/src/sync/store.ts` | 会话镜像水位（若不复用 oplog，则只加 settings 键） |
| `main/server/src/assistant/repository.ts` | 归属判定与只读守卫；`mirrored` 行的写入路径 |
| `main/server/src/routes/assistant.ts` | 归属守卫（409）、接管端点挂载、能力位读取 |

### 11.2 前端

| 文件 | 改动 |
|---|---|
| `main/web/src/stores/chat.ts` | 会话来源/归属字段透传 |
| `main/web/src/components/ChatDrawer.vue` | 镜像徽标、只读态、接管按钮、归属端设备名 |
| `main/web/src/components/settings/SyncPanel.vue` | 「同步范围」文案更新（**必改**，否则用户口径与行为不符） |
| `main/web/src/lib/syncLog.ts` | 会话类事件的展示文案 |

### 11.3 明确不改

- `main/server/src/assistant/dshRuntime.ts`、`prompts.ts`（续聊机制沿用）。
- `main/mobile/**`（手机继续走代理；如要做镜像，另立 M4）。
- `main/desktop/**`。
- `DATA_DIR/dsh/**` 的搬运与备份策略。

---

## 12. 验收与测试

### 12.1 单测（`node:test`，跟随现有风格）

| 用例 | 断言 |
|---|---|
| 快照幂等 | 同一快照应用两次，行数/内容不变；不产生重复消息 |
| 消息去重 | 两端各有一条同 id 消息 → 合并后一条 |
| 只读守卫 | `mirrored=1` 时 `POST /runs` → 409，且不创建 dsh 运行时 |
| tombstone | 删除后对账拉回旧清单，不得复活会话 |
| 体积裁剪 | 超限会话只镜像尾部 N 条并标记 `truncated` |
| 能力协商 | 模拟旧 peer：清单里出现 session 项但**不推送**、且页面同步不受影响 |

### 12.2 端到端（对照现有 `sync/sync.e2e.test.ts` 的三实例 worker 模式）

1. A 端建会话并跑一轮（用假模型）→ B 端出现，消息数一致，B 端只读。
2. B 端点接管 → A 端（有活跃 run 时）收到取消、终态带原因；B 端能发下一轮；A 端看到新消息。
3. 中途断网：B 端离线期间 A 端新增 20 条消息 → B 端重连后补齐（走清单 hash 比对）。
4. 删除传播：A 端删会话 → B 端行消失且不复活。
5. **回归**：现有 4 种 op 的 e2e 全部保持通过（这条是硬门槛）。

### 12.3 界面验收（按仓库规则截图直发）

- 会话列表里出现别端会话 + 镜像徽标；
- 打开镜像会话：历史完整、输入框禁用并说明原因；
- 接管确认弹窗 → 接管成功后的输入框解禁；
- 同步详情里能看到会话类事件（含被保留策略裁掉的解释）。

---

## 13. 风险与决策点

### 13.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 旧成员端静默丢会话（水位推进） | 用户以为在同步，实际没有 | §6.3 能力协商 + 中枢按能力过滤；**M1 必须做**，不能推迟 |
| 会话数据量失控 | 全量对账变慢、同步日志被刷 | §9 保留窗口 + 截断 + 体积守门 |
| 用户误以为"两端能同时聊" | 操作困惑 | 镜像态明示（徽标 + 输入框禁用文案 + 归属端设备名）；文档口径同步更新 |
| 接管时半轮输出丢失 | 数据观感差 | 默认 D4-a（先收尾再交接）+ 接管记录写进会话系统行 |
| 备份/恢复把 A 的同步绑定带到 B（现状固有） | 节点 id 冲突、误导性观感 | 不属于本方案，但建议在「备份与恢复」卡片加一句提示（可另立小任务） |

### 13.2 待用户拍板的决策点

| 编号 | 问题 | 建议默认 |
|---|---|---|
| D1 | 归属唯一 + 只读镜像（方案 A）还是全端可跑（D 拒绝）？ | A |
| D2 | 推理段是否镜像？ | 默认不同步，开关可开 |
| D3 | 保留窗口（90 天 / 50 会话 / 4 MB 单会话） | 按建议值，可配 |
| D4 | 接管时归属端在跑：先收尾还是立即落权？ | 先收尾（D4-a） |
| D5 | 归属端离线时允许直接接管吗？ | 允许 + 二次确认 |
| D6 | 手机端是否也做镜像？ | 不做，继续代理 |
| D7 | 默认开还是默认关？ | 默认**开只读镜像**，接管永远需显式操作 |

---

## 14. 附录：本文引用到的关键代码索引

```
同步核心
  main/server/src/sync/store.ts:15,17-57           op 类型与 oplog/revision
  main/server/src/sync/hub.ts:249-280,331-467      提交与 applyPush（未知 kind 抛错）
  main/server/src/sync/client.ts:421-474           成员端应用 op（未知 kind 静默跳过+推进水位）
  main/server/src/sync/client.ts:436-446,765-973   文件按需拉取与自愈
  main/server/src/sync/rows.ts:38-53               证据账本快照（本方案的写法模板）
  main/server/src/routes/sync.ts:469-525,539-557   全量清单与 stale 路径
  main/server/src/lib/vault.ts:25-33               safeJoin 越界保护

会话数据
  main/server/src/lib/db.ts:462-577,594-600        六张表与其后补列
  main/server/src/config.ts:11,17                  BRAIN_DIR / DB_FILE
  main/server/src/assistant/config.ts:49-51        DSH_HOME = DATA_DIR/dsh
  main/server/src/assistant/repository.ts:497      本端单飞判据
  main/server/src/routes/assistant.ts:130-136,200  409 与排队
  main/server/src/routes/assistant.ts:208-239      沉淀（走页面同步，不受本方案影响）

续聊能力
  main/server/src/assistant/dshRuntime.ts:76-84,186  不跨进程复用 dsh 会话 id
  main/server/src/assistant/prompts.ts:68-81         有界历史（8 × 1200 字）

客户端与口径
  main/web/src/components/settings/SyncPanel.vue:173  「同步范围」用户可见文案
  main/mobile/.../EngramLocalServer.kt:104,307-344,447-458  手机 = 中枢代理
  main/desktop/main.js:95-107                        桌面端远端模式已移除
```
