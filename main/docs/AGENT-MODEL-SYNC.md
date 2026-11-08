# 内置 Agent 模型配置多端同步（agent-model-sync）

> 状态：本轮实现（2026-11-08）。目标版本 v1.6.x。分支 `feat/agent-model-sync`。
> 背景：用户报「视频理解模型的 API Key 多端同步没有生效」。现状：视频理解复用 dsh 控制台的模型配置
> （`$DSH_HOME/profiles/web/cordis.patch.yml` + `$DSH_HOME/.credentials.yaml`），而「模型 Key 与 Agent 配置」
> 按设计不进同步（`docs/USER-GUIDE.md` 原「同步范围之外」一节）。用户已确认：**要把内置 Agent 控制台的
> 模型配置（提供商 / 官方配置 / 默认模型 / 相关 API Key）纳入多端同步**，视频理解随之在每端可用。

## 目标

1. 任一端在「内置 Agent 控制台 → 模型」保存的配置（提供商、官方 DeepSeek 配置、默认模型、相关 API Key）
   随「多端同步」的**设置**分类下发到同步群组内其他设备（成员 ⇄ 中枢双向）。
2. 收到配置的一端把它写进本机 dsh 的模型配置，**聊天 Agent 与视频理解都直接用上**；
   对端没有本机 Key 时视频理解也能用（不依赖 dsh 写入成功，见「视频侧回退」）。
3. 修掉现存 bug：视频理解总开关 `video_config` 没登记进 `PREFERENCE_KEYS`，`stampPreference` /
   `recordLocalChange` 都静默失效，开关与 Key 都不同步；同时把旧版 `video_config` JSON 里的
   `baseUrl/apiKey/model/...` 清洗掉（否则一旦登记会把这些陈旧字段（含旧 Key）当设置同步出去）。

## 非目标

- 不同步插件 / Agent 预设 / 权限模式 / Session Log 等其它 dsh 设置（仍各端自配）。
- 不同步 dsh 的其它凭据（如 `client-connection/browser-session`）：**只同步模型提供商引用到的 Key**。
- Android 手机不持有模型 Key：手机不跑 dsh，视频提炼与聊天都在中枢执行（手机只经窄代理读状态、改中枢配置）。
  Kotlin 侧**不加**这些 preference key（未知 key 按现有逻辑跳过，属预期；在 ANDROID.md 写清楚）。
- 不做「删除提供商」的跨端删除语义：合并是**并集**，删除不同步（文档写明）。

## 数据契约

新增同步偏好项 key：`agent_model_config`（走既有 `preference` 管道；与 `video_config` 一样归属
`settings` 分类；分类关闭则不同步）。值是一个 **JSON 字符串**（preference `value`），结构：

```ts
interface SyncedAgentModelConfig {
  version: 1;
  /** 官方 DeepSeek 配置（llm-deepseek 命名空间的非密钥字段） */
  official: {
    apiKeyEnv: string;            // 默认 DEEPSEEK_API_KEY
    baseURL?: string;             // 空 = 官方地址
    maxTokens?: number;           // 0/缺省 = 不写
    models?: Array<{ id: string; name?: string; contextWindow?: number; inputModalities?: string[] }>;
  };
  /** 第三方 / 自定义提供商（llm-pi-ai 的 providers 映射，键=providerId） */
  providers: Record<string, {
    displayName?: string;
    api?: string;                 // 默认 openai-completions
    baseURL?: string;
    apiKeyEnv?: string;           // 缺省 = <ID>_API_KEY
    models: Array<{ id: string; name?: string; contextWindow?: number; input?: string[] }>;
  }>;
  /** 默认模型（agent-default-model） */
  default: { provider: string; model: string; reasoningEffort?: string };
  /** 只含上面 provider/official 引用到的 Key（ref → 明文），绝不出接口、不进日志 */
  keys: Record<string, string>;
}
```

- 大小上限：`value` ≤ 1MB（`mergePreference` 已有 1MB 限制，沿用；内部再限 256KB 防滥用）。
- 来源/时间戳用既有 preference meta（`sync_preference:agent_model_config` 里的 updatedAt/nodeId）。
- 只有本机确实读到了模型配置（providers 或 official 非空）才镜像；空配置不上传。

## 本机读取（源）

`server/src/lib/videoModel.ts` 已有「按缩进读 patch」的解析器（`parseDshProviders`、
`parseCredentialRefs`、`findTopLevelEntry`、`unquoteScalar`）。**新建 `server/src/lib/agentModelConfig.ts`**，
复用/扩展它们（可把通用解析函数导出后复用，别复制两份）：

- 提供商：`profiles/web/cordis.patch.yml` 顶层 `llm-pi-ai` 的 `config.providers.*`
  （每个 provider 读 displayName / api / baseURL / apiKeyEnv / models[{id,name,contextWindow,input}]）。
- 官方：顶层 `llm-deepseek` 的 config（apiKeyEnv / baseURL / maxTokens / models）。
- 默认模型：顶层 `agent-default-model` 的 config（provider/model/reasoningEffort）。
- Key：`.credentials.yaml` 的 `refs`，**只取** `official.apiKeyEnv` 与各 provider 的 apiKeyEnv（缺省推导
  `<ID>_API_KEY`）。取不到本地 ref 时可回退同名环境变量（与 `resolveVideoModel` 同口径）。
- 纯读文件、不启动 dsh；读不到就当空（不抛）。JSON 解析失败按空配置。

## 本机写入（收到对端配置时）

**直接改 dsh 的两个文件**（不在同步回调里起 dsh 进程，避免 origin / 权限耦合）：

1. `profiles/web/cordis.patch.yml`：只处理三个顶层条目
   - `llm-pi-ai`：`config.providers` 与远端合并（同 id 远端胜；本机独有保留）；
   - `llm-deepseek`：远端有值才覆盖对应字段（baseURL / maxTokens / models / apiKeyEnv）；
   - `agent-default-model`：远端有值才覆盖 provider/model/reasoningEffort。
   其余顶层条目、注释、缩进逐字保留（复用 `findTopLevelEntry` + 行列替换；写入前备份
   `cordis.patch.yml.engram-bak`，同一次写覆盖旧备份）。
2. `.credentials.yaml`：只重写顶层 `refs:` 段（保留 `version`/`records` 等其它段），
   合并后 refs 用块状 map 输出（`REF: 'value'`，值用单引号并把 `'` 转义成 `''`）；
   同样写前备份 `.credentials.yaml.engram-bak`。
3. 写完后若控制台在运行（`consoleStatus().running`）调用 `restartConsole()` 让 dsh 重读配置；
   聊天运行时的配置指纹（`agentSettingsStateFingerprint` 含这两个文件）变化会让它下一轮自动重开。
4. 写入失败：记同步 warn（`sync/eventLog`），把 payload 暂存到设置 `agent_model_sync_pending`
   （JSON），下次镜像/启动/打开面板时重试；不得抛出把同步轮打断。

## 合并与回声抑制

- 合并 = **并集**：本机 ∪ 远端；同 provider id / 同 key ref 远端胜；official/default 远端有值才覆盖；
  `keys` 并集。删除不传播。
- 回声抑制：维护设置 `agent_model_sync_digest` = 最近一次「已知内容」的 sha256（稳定序列化）。
  - 镜像前：读本机配置 → 若 digest 与存储值相同 → 不写偏好、不入队。
  - 应用远端后：把合并结果写回设置 `agent_model_config`（value = 合并后 JSON），把
    `sync_preference:agent_model_config` 的 updatedAt 设为 `max(Date.now(), 远端updatedAt+1)`、
    nodeId 设为本机，再写 `agent_model_sync_digest` = 合并结果 digest；
    **仅当合并结果 ≠ 远端 payload（本机有独有内容）时**再 `recordLocalChange` 推一次（收敛一次即停）。
- 收到偏好（`mergePreference` 返回 true 且 key 为 `agent_model_config`）后异步应用：不阻塞同步轮；
  同一时刻只跑一个应用（进程内 mutex），失败留 pending 重试。

## 触发点

镜像（本机 → 偏好）：
1. 服务启动后（`server/src/index.ts` 同步客户端初始化之后，延迟约 3~5 秒跑第一次，再每 5 分钟轮询一次；
   `instrumentation` 性质，异常只记日志）；
2. `GET /api/settings/video-config`（手机窄代理也会打到这里 → 中枢顺带镜像）；
3. `GET /api/agent-console/models` 与三个保存接口（`PUT /api/agent-console/models/default|official|providers/:id`）
   成功后（BFF 已拿到明文 Key，保存即镜像）；
4. 本机应用完远端配置后（由上面的 digest 抑制）。

应用（偏好 → 本机）：
- `sync/client.ts` 应用远端 op（`preference` 分支）后、`sync/hub.ts` 处理成员 push（`preference` 分支）
  并 `mergePreference` 成功后，调用 `onAgentModelPreferenceApplied(key, updatedAt)`。

## 视频侧回退（本次报障的直接修复）

- `server/src/lib/videoConfig.ts` 的 `videoModelConfig()`：先用 `resolveVideoModel(bundledDshHome())`
  读本机；**缺 Key（或本机根本没有 dashscope 提供商）时**，从同步设置 `agent_model_config` 里取
  `providers.dashscope` + `keys[apiKeyEnv]`（找不到 dashscope 再看含 `qwen3.8-omni-flash` 的 provider）补上。
- `videoConfigStatus()` 增加 `keySource: 'local' | 'synced' | 'none'`（可选 `keyFromNode`：偏好 meta 的 nodeId），
  前端据此显示「Key 来自多端同步（本机控制台未配置）」。
- 开关同步：`PREFERENCE_KEYS` 增加 `'video_config'`；`routes/settings.ts` 与 `routes/videoConfig.ts` 现有
  `stampPreference`/`recordLocalChange` 就此生效；读取时把旧 `video_config` JSON 归一化成
  `{ enabled }` 再存（清掉旧 apiKey 等字段），**先归一化再 stamp/同步**。

## 安全与文案

- 任何接口都不回显 Key（沿用 `hasKey` / `keySource`）；同步日志只记「同步设置「内置 Agent 模型配置」」，
  不记值（`opText.preferenceLabel` 新增该 key 的中文名）。
- 设置 → 多端同步 → 同步内容 的「设置」分类说明补一句：包含内置 Agent 的模型配置与 API Key（明文随群组下发）。
- 文档同步：`docs/AGENT-CONSOLE.md`（模型配置多端同步）、`docs/USER-GUIDE.md`（原「同步范围之外」一节与
  视频理解模型怎么配）、`docs/ANDROID.md`（手机不持有模型 Key）、`docs/PLATFORM-PARALLEL-DEV.md`
  （sync preference 新 key + 平台影响）、根 `README.md` 功能总览、`docs/MOBILE-SYNC-LEDGER.md`（如需要）。

## 平台影响

- 服务端 + Web：`平台影响: B,F`。Android：**无 Kotlin 改动**（手机不跑 dsh、不落模型 Key，preference 未知 key
  按现有逻辑跳过），在 ANDROID.md 与提交信息里写明。Windows/Docker 同源。

## 测试清单

- `lib/agentModelConfig.test.ts`：读 patch/凭据（含 flow map 与块状 refs）；合并并集/远端胜；写 patch 保留其它条目与注释；
  写 refs 保留 records；digest 稳定；坏输入不抛。
- `sync/agentModelSync.test.ts`：镜像写偏好 + 入队 + digest 抑制重复；应用远端写文件并写回偏好；本机独有内容只回推一次；
  写入失败记 pending。
- `lib/preferences.test.ts` / `sync/categories.test.ts`：新增 key 在 `settings` 分类下允许；关闭分类不允许；`video_config` 同。
- `lib/videoConfig.test.ts`：本机无 Key + 同步配置有 Key → `configured` 且 `keySource='synced'`；本机有 Key → `local`。
- `sync/sync.e2e.test.ts`：两端偏好互推 `agent_model_config`（对齐既有 preferences 用例，注意 e2e 里不写真实文件可
  用临时 DSH_HOME/ENGRAM_DATA_DIR）。
- Web：`web/src/lib/videoPanel.test.ts`（新增）锁 `keySource` 文案分支；`settingsLayout.test.ts` 补同步分类说明断言。

## 验收

- `bash main/scripts/verify-feature.sh agent-model-sync` 通过（Docker 内 build + typecheck + test）。
- 预览环境实测：桌面端（本机已有 DashScope Key）→ 合成两个 DSH_HOME 的单元测试覆盖真实写入；
  预览里打开 设置 → 视频理解模型 截图（状态 + Key 来源）；同步详情能看到「同步设置「内置 Agent 模型配置」」。
