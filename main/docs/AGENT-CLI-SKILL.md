# Agent 交互：CLI + skill（取代 MCP）实施契约

> 本文件是 `feat/agent-cli-skill` 的协作契约与实施说明。所有参与本任务的 Agent 先读完本文件再动手。
> 用户已确认：**彻底删除 MCP**（/mcp 端点、MCP SDK 依赖、所有客户端 MCP 配置写入），内置与外置 Agent 一律
> 通过 `engram` CLI + skill 读写知识库；只保留能跑 shell 的客户端；`ask_user` 用 `engram ask` 阻塞长轮询替代，
> 图片类内容由 CLI 落临时文件、Agent 用自己的图片工具读。

## 1. 目标状态

- 知识库能力面 = **REST API（服务端）** + **`engram` CLI（唯一 Agent 命令入口）** + **skill（安装到各客户端 skills 目录的说明书）**。
- 服务端不再有 `/mcp` 端点，不依赖 `@modelcontextprotocol/sdk`，不再往任何客户端写 `mcpServers` 配置。
- 内置 Agent（Engram 聊天抽屉里的 dsh）：$DSH_HOME/skills 下装 `engram` skill，PATH 里放 `engram` 包装脚本；
  其系统提示词改为「读写知识库只用 engram 命令」。
- 外置 Agent（Claude Code / Codex / dsh / ZCode / Kimi Code / WorkBuddy / Qoder）：设置页「一键接入」只装 skill + CLI 包装脚本，
  不再改客户端 MCP 配置。Kimi Work 插件入口下线（无 shell）。
- 内置 Agent 的「对话里弹选项」= `engram ask`：CLI POST 到服务端并阻塞等待用户点选，答复后同一轮继续。

## 2. 文件所有权（避免互相踩）

| 工作流 | 负责人 | 只改这些路径 |
| --- | --- | --- |
| A. CLI + REST | teammate `cli-surface` | `main/server/src/cli/**`、`main/server/src/routes/agentTools.ts`（新建）、`main/server/src/routes/guide.ts`、对应新测试 |
| B. 内置 Agent 运行时 | teammate `runtime-agent` | `main/server/src/assistant/**`、`main/server/src/lib/entityNameChecks.ts` |
| C. 接入/删除 MCP/内容 | teammate `access-content` | `main/server/src/lib/agentSkill.ts`+`cliShim.ts`+`agentAccess.ts`（新建）、`lib/customerResearchSkill.ts`、`lib/externalMcpConfig*.ts`、`lib/codexConfig*.ts`、`lib/dshConfig*.ts`、`lib/kimiWorkConfig.ts`、`lib/zcodeConfig.ts`、`routes/settings.ts`、`server/src/index.ts`、`server/src/mcp/**`（删除）、`server/package.json`、`pnpm-lock.yaml`、`content/**`、`lib/customerResearchSkill.test.ts`、`lib/codexConfig.test.ts`、`lib/dshConfig.test.ts`、`lib/externalMcpConfig.test.ts` |
| D. Web UI | teammate `web-ui` | `main/web/src/components/settings/AgentMcpSection.vue`→`AgentCliSection.vue`、`main/web/src/components/settings/AgentPanel.vue`、`main/web/src/lib/mcpTools.ts`→`cliReference.ts`、`lib/settingsDomains.ts`、`lib/capabilities.ts` 及相关测试 |
| E. 文档 | teammate `docs-writer` | `main/docs/AI-CONTENT-OPERATIONS.md`、`main/docs/CUSTOMER-RESEARCH.md`、`main/docs/AGENT-CONSOLE.md`、`main/README.md`、`main/docs/USER-GUIDE.md`（只动 Agent 接入相关段落）、根 `AGENTS.md`、`main/AGENTS.md` |
| Lead | lead | 契约、合并、Docker verify、真实验收、平台影响声明 |

跨工作流的接口一律以本文件的「契约」为准；需要改契约先找 Lead。`index.ts` 只由工作流 C 改（C 负责注册 A 新建的 `agentToolRoutes`）。

## 3. CLI 命令面（最终）

调用方式（运行时由服务端解析，写入 skill 与 shim）：

- 本机安装（桌面/源码）：`"<node>" "<server>/dist/cli/cli.js"`，并额外写 `%USERPROFILE%\.engram\bin\engram.cmd`（POSIX 为 `~/.engram/bin/engram`）；
- Docker 内：`node /app/server/dist/cli/cli.js`；
- 远程客户端：`node engram.js`（服务端 `GET /api/agent/cli` 提供 cli.js 源文件，用户下载后 `engram login`）。

命令（`--json` 全局机器可读；`--url/--token/--allow-private` 全局临时连接）：

```
login --url <url> --token <token>        # 远程连接登记（本机服务启动时已自动登记 ~/.engram/config.json）
status                                    # 健康 + 连接 + 计数
config show                               # 当前连接（token 脱敏）
guide                                     # 《Agent 作业指南》全文
skill list                                # 内置 skill 元数据
skill show <name>                         # 内置 skill 全文
search <query> [--limit N]
pages list [--outdated] [--tag T] [--path P]
pages read <ref>
pages related <ref>
pages evidence <ref>
pages write <path> --title T [--type] [--tags a,b] [--evidence "路径::引文"]... [--file F|-]
pages rename <ref> --title T
pages move <ref> [--dir Wiki/实体] [--title T]
pages delete <ref> [--reason R]
pages asset <ref> [--out F]               # 正文 /media/... 图片：默认落临时文件并打印路径（JSON 含 path/mimeType）
files list [--pending] [--dir D]
files read <path> [--out F]               # 提取文本；--out 时把文本写入文件
files raw <path> [--out F]                # 原件字节；图片/二进制必须给 --out，默认落临时文件
files add <path> [--file F|-]             # create_raw_material：新建原始资料（stdin/文件为正文）
inbox list [--status all|pending|converted|adopted] [--limit N]
inbox read <path> [--out F]               # 文本直出；图片/Office 文字层按服务端结果，图片落文件
inbox raw <path> --out F                  # 原件字节（图片）
inbox add <path> [--file F|-]             # add_inbox_file（文本原件）
inbox write <path> [--file F|-] [--title T] [--note N]   # write_inbox_markdown（转换产物）
inbox convert <path>                      # convert_inbox_item（服务端管道，可能数分钟；HTTP 超时 >= 10 分钟）
chat save [--identifier I] [--project P] [--append] [--file F|-]
names check <名称> [--page R] [--note N]
names propose <id> [--full-name F] [--source S] [--note N]
names list [--status pending|open|unresolved|all]
names audit
names answer <id> --allow|--deny [--note N]
research begin --customer C [--scope knowledge-web|knowledge-only] [--save] [--save-mode new|overwrite] [--overwrite-path P] [--client X] [--timezone TZ]
research submit --task <taskId> [--file F|-]    # 报告 JSON（identity/sections/sources/save/saveMode/overwritePath）
ask --data '<json>' [--file F|-] [--timeout-ms N]  # 内置 Agent：{questions:[{id?,question,header?,options?:[{label,description?}],multiSelect?}],timeoutMs?}；--json 仅作全局输出格式，不作 payload
```

- 删除 `mcp-config` 子命令。
- 文本输出保持人类可读（与旧 MCP 工具结果同口径）；`--json` 输出结构化。
- 出错：stderr 打原因，退出码非 0（2=用法/配置错误，1=服务端拒绝/失败）。
- CLI 不新增第三方依赖（Node 22 全局 fetch / FormData）。

## 4. 新增 REST 端点契约（工作流 A 实现，全部在 `routes/agentTools.ts`，auth = `requireAuth`）

```
POST /api/agent/ask              body {questions, timeoutMs?} → {ok, reason, questions[], timeoutMs}
                                 阻塞到用户答复/超时/本轮结束（复用 assistant/questions.askUserQuestions）
GET  /api/agent/skills           → {skills:[{name,title,description,whenToUse,version}]}（作业手法 SKILLS + 安装型 engram / engram-customer-research）
GET  /api/agent/skills/:name     → {name,title,description,whenToUse,version,body} | 404（安装型正文把 {{ENGRAM}} 回显为通用 engram 命令）
GET  /api/agent/pages/tree?outdated=&path=&tag=   → {text}   # 与旧 list_pages 完全相同口径（规则版本标注/裁剪）
GET  /api/agent/pages/related?titleOrId=          → relatedPageData JSON | 404
GET  /api/agent/asset?path=/media/<parentId>/<file> → 图片字节（Content-Type 按扩展名）；SVG/非法引用回 JSON 错误
GET  /api/agent/file?path=<原始资料路径>&mode=text|raw → mode=text: {kind:'text',text}（md→页面正文；其余→files.text；无文字层给可读提示）；mode=raw: 原字节（二进制/图片）
GET  /api/agent/inbox/items?status=&limit=        → listInboxItems() 结果
GET  /api/agent/inbox/item?path=&mode=text|raw    → mode=text: {kind:'text',text}；mode=raw 或图片: 二进制 + Content-Type
POST /api/agent/inbox/add        {path, content}  → addInboxFile 结果
POST /api/agent/inbox/write      {path, markdown, title?, note?} → writeInboxMarkdown 结果
POST /api/agent/inbox/convert    {path}           → convertInboxItem / convertVideoInboxItem 结果（可能数分钟）
POST /api/agent/raw-material     {path, content}  → createRawMaterial 结果
POST /api/agent/research/begin   {customer, scope?, save?, saveMode?, overwritePath?, client?, timeZone?} → beginCustomerResearch 结果
POST /api/agent/research/submit  {taskId, ...report} → submitCustomerResearch 结果
GET  /api/agent/cli              → cli.js 源码（text/javascript；供远程客户端下载）
GET  /api/agent/info             → {url, cli:{command, shimPath, nodePath, scriptPath}, configPath, tokenName}
```

- 业务错误按 4xx + `{error}` 返回（沿用各 pipeline 的 Error 类 status）；`ask` 的 no_active_run 走 200 + reason。
- 复用现有内核函数（pipeline/agentWrite、agentDelete、pageEvidence、graphCache、inboxConvert、inboxAdd、rawMaterial、research/customerResearch、assistant/questions），**不要复制实现**。
- `GET /api/agent/cli` 读 `dist/cli/cli.js`（从 `import.meta.url` 推 `../cli/cli.js`），不存在时 500 说明。

## 5. 运行时上下文与 shim（工作流 C）

新建 `server/src/lib/cliShim.ts`：

```ts
export interface CliRuntime { nodePath: string; scriptPath: string; command: string; shimPath: string; available: boolean; error?: string }
/** 解析本机可用 CLI：node = ensureAgentNodeRuntime().path（失败退回 process.execPath）；
 *  script = <dist>/cli/cli.js（dist 相对本文件 ../cli/cli.js；不存在时 available=false）；
 *  command = 带引号的 "<node>" "<script>"；shimPath = <home>/.engram/bin/engram(.cmd) */
export function resolveCliRuntime(home?: string): CliRuntime;
/** 写 shim（幂等）：Windows engram.cmd（@echo off + "%node%" "%script%" %*），POSIX sh 脚本 chmod 755 */
export function writeCliShim(home?: string): string;
/** 本机接入统一入口（内置 Agent 启动 / 外置一键接入共用）：确保 shim + skill 安装，返回状态 */
export function ensureLocalAgentCli(): { cli: CliRuntime; env: NodeJS.ProcessEnv };
```

- dsh 环境：`PATH = <shimDir><delimiter><原 PATH>`（内置 Agent 直接 `engram status` 即可）。
- 桌面端 node 走 `ensureAgentNodeRuntime()`（resources/node/node.exe）；Docker/源码走 process.execPath。

## 6. skill 内容与安装（工作流 C）

单一来源：`server/src/content/agentSkill.ts`
- `ENGRAM_SKILL`（name `engram`）：何时用 + 完整命令参考 + 纪律（只写 Wiki/、证据门禁、原始资料只新建、收集箱非知识库、
  save_chat 须用户指示、删除=回收站、改名保持 ID、内置 Agent 用 `engram ask`、外部 Agent 用自带提问）；
  正文用占位符 `{{ENGRAM}}` 表示调用命令，安装时替换成 `resolveCliRuntime().command` 或 `engram`（PATH 可用时）。
- `CUSTOMER_RESEARCH_SKILL`（name `engram-customer-research`）：入口 skill，只说明何时用 + `engram research begin/submit` 用法。
- 安装目标（`lib/agentAccess.ts`，沿用旧检测口径，去掉所有 mcpServers 写入）：

| id | 客户端 | 检测 | skill 根 |
| --- | --- | --- | --- |
| claude | Claude Code | ~/.claude | ~/.claude/skills |
| codex | Codex | $CODEX_HOME 或 ~/.codex | ~/.agents/skills |
| dsh | DeepSeek Harness | $DSH_HOME 或 ~/.dsh | <home>/skills |
| zcode | ZCode | ~/.zcode 或引擎路径 | ~/.zcode/skills |
| kimi-code | Kimi Code CLI | $KIMI_CODE_HOME 或 ~/.kimi-code | <home>/skills |
| workbuddy | WorkBuddy | ~/.workbuddy / ~/.workbuddy-ai（环境变量优先） | <配置目录>/skills；**存在的变体目录全部维护** |
| qoder | Qoder | ~/.qoder / ~/.qoder-cn | <配置目录>/skills；**存在的变体目录全部维护**（国内版客户端只读 ~/.qoder-cn） |

- `AgentAccessStatus = { id, title, installed, skillsInstalled, skillPath, skillPaths, cliAvailable, cliCommand }`；
  `registerAgentAccess(id)` / `unregisterAgentAccess(id)` 只写/删带 `<!-- engram-managed -->` 标记的 skill 目录与同标记的旧入口 skill；
  同名非 Engram 管理的 skill 拒绝覆盖（沿用旧 `assert...Writable` 语义）。多套变体目录时 `skillPaths` 全部列出、全部写入。
- 老版本装过的 `engram-customer-research` 入口（带旧标记前缀 `<!-- engram-managed-customer-research:`）升级时可覆盖，注销要清掉。
- 旧版本 Engram MCP 条目在一键接入 / 移除接入时一并清理（`lib/agentLegacyConfig.ts`，只删本方内容、其余配置逐字保留）：
  Codex `$CODEX_HOME/config.toml` 的 `[mcp_servers.engram]` 表、dsh `$DSH_HOME/cordis.patch.yml` 的 mcp-engram 条目、
  WorkBuddy `<配置目录>/mcp.json`、Qoder `<配置目录>/settings.json`（两个变体都清）、Kimi Code `<KIMI_CODE_HOME>/mcp.json`；
  顺带清掉写错目录的旧 skill（WorkBuddy `~/.codebuddy/skills`、Codex `$CODEX_HOME/skills`）。
  清理是顺带收尾：坏 JSON / 无写权限静默跳过，不影响接入结果。

settings 路由（工作流 C，`routes/settings.ts`）：
```
GET  /api/settings/agent-access                 → { clients:[AgentAccessStatus], cli:CliRuntime, configPath, skillCommand }
POST /api/settings/agent-access/register        {id} → 注册结果
POST /api/settings/agent-access/unregister      {id} → 注销结果
GET  /api/settings/agent-tokens                 → {tokens}（沿用 mcp_tokens 表，仅 UI 文案改「Agent 令牌」）
POST /api/settings/agent-tokens                 {name}
DELETE /api/settings/agent-tokens/:id
GET  /api/settings/agent-cli-source             → cli.js 源文件下载（远程接入）
```
删除旧端点：`zcode-status/register/unregister`、`dsh-*`、`codex-*`、`{target}-status/register/unregister`（workbuddy/qoder/kimi/kimiwork）、`customer-research-skill`。
保留 `mcp-tokens` 旧路径做别名？**不留**，前端同步改；表名 `mcp_tokens` 暂不改（迁移风险，注释说明为 Agent 令牌）。

## 7. 内置 Agent 运行时（工作流 B）

- `agentPatch.ts`：删除 MCP 覆盖层（`agentPatchText/writeAgentPatch/engram.cordis.yml`），只保留 `chatPatchText/writeChatPatch`；
  增加升级清理：删 `<home>/engram.cordis.yml`、清 `<home>/cordis.patch.yml` 里含 `mcp-engram` 的条目（沿用旧逻辑）。
- `dshRuntime.ts`：acquireRuntime 时调用 `ensureLocalAgentCli()`（工作流 C 提供）→ PATH 注入 shim 目录 + 安装 skill；
  不再传 `mcpPatch`（patches 只剩 chatPatch）；`ensureAgentToken` 不再需要（token 由 ~/.engram/config.json 提供）。
- `agentConsole.ts`：控制台 dsh 进程 env 同样注入 PATH shim（同一个 home 的 skill 自动可用）。
- `prompts.ts`：内置 Agent 指令整段改写——读写知识库只用 `engram` 命令（列出常用命令）；方法论用 `engram guide`，
  按需手法用 `engram skill list/show`；需要用户拍板用 `engram ask`（唯一场景=公司全名核验）；
  图片用 `engram pages asset/files raw --out` 落文件后用自己的图片读取工具看；收集箱/证据门禁/日志纪律保持原口径。
- `questions.ts`：保留内核；删除「MCP 工具」措辞，改「`engram ask` / POST /api/agent/ask」；`formatAskOutcome` 文本保留（CLI 直接输出）。
- `dreamCycle.ts`：注释与任务文本里的 MCP 措辞改 CLI；确认它下发的任务文本不依赖 mcp__engram__*。
- `entityNameChecks.ts`：描述文本里的 `ask_user`/`entity_name_check` 等改 `engram ask`/`engram names check` 等（内置 vs 外部口径保留）。
- 相关测试同步改（agentPatch.test、dshRuntime.test、questions.test、dreamBoard.test 等）。

## 8. 删除清单（工作流 C）

- 删 `main/server/src/mcp/` 整个目录（含 4 个测试）。
- `index.ts`：删 `mcpRoutes` import/register；注册 `agentToolRoutes`。
- `server/package.json`：删 `@modelcontextprotocol/sdk`（zod 若仅 `research/customerResearch.ts` 用则保留；实际上 research 用了 zod → **保留 zod**）。
- `pnpm-lock.yaml`：同步删掉 server importer 的 `@modelcontextprotocol/sdk` 与对应 package 条目（保持 `pnpm install --frozen-lockfile` 可过）。
- `desktop/scripts/prepare-desktop.js` 里「zod 固定版本因为 MCP SDK」的注释/逻辑同步修正（zod 仍被 server 用则保留 pin，只改注释）。
- `lib/externalMcpConfig.ts`、`codexConfig.ts`、`dshConfig.ts`、`kimiWorkConfig.ts` 删除（逻辑并入 `agentAccess.ts`）；`zcodeConfig.ts` 只保留引擎探测/路径（若无人用则删）。
- `content/agentGuide.ts`：整篇按 CLI 口径改写（`engram ...` 命令而不是 MCP 工具名），`GUIDE_VERSION` **不 bump**（不改抽取口径）。
- `content/skills/*`：正文里的 MCP 工具名改 CLI 命令。
- `content/customerResearch.ts`：`CUSTOMER_RESEARCH_TRIGGER/BRIDGE` 改 `engram research begin/submit` 口径。
- 旧 `lib/customerResearchSkill.ts` 删除（并入 `lib/agentSkill.ts`）。

## 9. Web UI（工作流 D）

- `AgentMcpSection.vue` → `AgentCliSection.vue`：客户端卡片（检测/已接入状态、一键接入、移除接入）、Agent 令牌管理、
  远程接入说明（下载 cli.js + `engram login`）、客户调研入口 skill 复制、命令参考表入口。
- `lib/mcpTools.ts` → `lib/cliReference.ts`：`CLI_COMMANDS: {command,group,summary,notes}[]`（覆盖第 3 节全部命令）；
  AgentPanel 的「查看工具」改「查看命令」。
- `settingsDomains.ts` / `capabilities.ts` / `AgentPanel.vue`：MCP 文案改 CLI/skill；搜索/研报等说明同步。
- 测试：`mcpTools` 引用、`platformParity.test.ts` 若校验设置域文案则同步。

## 10. 文档（工作流 E）

- `AI-CONTENT-OPERATIONS.md`：MCP 全改 CLI+skill（含接入方式、动手前后、实际执行位置）。
- `CUSTOMER-RESEARCH.md`：外部 Agent 一节改 `engram research begin/submit` + 各客户端 skill 路径表。
- `README.md` / `USER-GUIDE.md`（Agent 接入/外部 Agent 段落）：改 CLI+skill 接入步骤；Kimi Work 下线。
- 根 `AGENTS.md` 规则 8（MCP ask_user → `engram ask`）、`main/AGENTS.md` 作用边界、`AGENT-CONSOLE.md` 涉及 MCP 的段落。
- 不确定就少写：不编造命令；以本文件第 3/4 节为准。

## 11. 验收要求

- `bash main/scripts/verify-feature.sh agent-cli-skill` 必须通过（Docker 内 build+typecheck+test，断网）。
- 不得在宿主机 `pnpm install`；不得新增联网依赖。
- 提交信息末行写 `平台影响: B,F`（服务端+web；Windows/Docker 同源、Android 复用 web 构建）。
- 真实验收（Lead）：preview 容器里用真实 CLI 跑 status/search/pages/inbox/research begin，并验证内置 Agent（dsh）能
  通过 `engram` 命令访问知识库、`engram ask` 能弹窗并返回；截图/终端画面发给用户。
