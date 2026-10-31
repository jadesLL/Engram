# 内置 Agent 控制台：Engram 原生界面 + DSH 配置后端

> 2026-10-23 起：控制台从「iframe 嵌 DeepSeek Harness 网页」改为 **Engram 原生整页**（模型 / 插件 / Agent 预设 / 高级），
> 配置数据仍由随包 dsh 进程持有，服务端 BFF 通过 DSH 自己的 HTTP RPC 读写。
> 聊天抽屉界面保持不变；设置页保留「内置 Agent 控制台」入口卡。

## 为什么做这个

内置 Agent 由随包依赖 `@deepseek-ai/dsh` 驱动。之前把 DSH 的 Web 界面直接塞进 iframe：

- 在桌面端「在新标签打开」会被 Electron 的主进程收口到系统浏览器（没有 Engram 登录 cookie），显示「未授权」；
- 网页的交互、主题、滚动与 Engram 割裂，手机上更是没法用；
- DSH 设置里大量条目（外观、字号、快捷键、发送行为……）只服务于 DSH 自己的聊天界面，Engram 不用，却全都被搬进了设置页。

现在改成「Engram 按 DSH 的版式重画一份配置界面」，只复刻影响聊天 Agent 行为的部分：
模型（提供商 / 密钥 / 模型目录）、插件（内置插件配置 + 实验性插件开关 + 插件清单）、Agent 预设、高级（Session Log、诊断）。
DSH 仍是唯一配置真源：控制台里改的模型/插件，聊天抽屉下一轮对话直接生效，不存在两套配置。

## 架构

```text
浏览器（Vue3 原生页面 /settings/agent-console）
  │  Engram 登录态 / MCP token（桌面、网页）或同步成员令牌（手机经窄代理）
  ▼
Fastify：/api/agent-console/* BFF（routes/agentConsole.ts）
  │  ① 服务端用浏览器 Host/Origin 向 dsh 兑换 dsh-auth cookie（内存持有，token 不出服务端）
  │  ② POST 127.0.0.1:<dsh web port>/api/<endpoint>，{type:"client-request",rpcId,method,payload:{args}} 信封
  ▼
随包 dsh web 进程（assistant/agentConsole.ts 的 ensure/restart/stop + 空闲 30 分钟回收）
  └─ 与聊天抽屉共用 profile / 凭据 / bundle 列表 → 控制台改动下一轮对话生效
```

- 传输层：`main/server/src/assistant/agentConsoleRpc.ts`（token→cookie 兑换、Host/Origin 围栏、401 重兑换一次、错误归一化、revision 冲突映射 409）；
- 业务层：`main/server/src/routes/agentConsole.ts`（owner / MCP token / 同步成员令牌；归一化 DSH 的 settings / credentials / llm / pluginManager / agentPresets 返回）；
- 前端：`main/web/src/views/AgentConsoleView.vue` + `components/agentConsole/*` + `lib/agentConsoleApi.ts`；设置页入口卡在 `components/settings/AgentConsolePanel.vue`（不再有 iframe）；
- 原来同源反向代理 `/agent-console/*`（含 WebSocket）与 iframe 路径仍保留在服务端，供诊断/兜底和兼容，但默认界面不再使用。

## 接口（owner / MCP token / 同步成员令牌）

> v1.5.1 起：Android 绑定中枢后，手机本机服务用同步成员令牌窄代理 18 条 `/api/agent-console/*`（以及视频配置 / 梦境 / 指南），手机只做配置界面，dsh 进程与 Key 都在中枢。`/agent-console/*` 同源反代仍是 owner-only（新界面不再使用）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent-console/status` | 控制台状态；默认确保 dsh web 已启动 |
| POST | `/api/agent-console/restart` / `stop` | 重启 / 停止后台 dsh 控制台 |
| GET | `/api/agent-console/models` | 归一化模型视图：默认模型、DeepSeek 官方卡、自定义提供商、可添加的声明式提供商、协议列表 |
| PUT | `/api/agent-console/models/default` | 保存默认模型（provider/model[/reasoningEffort]，带 expectedRevision） |
| PUT | `/api/agent-console/models/official` | 保存 DeepSeek 官方 Key / API 地址 / 模型目录 / 最大输出 token |
| PUT/DELETE | `/api/agent-console/models/providers/:id` | 新增/编辑/删除第三方或自定义提供商（含密钥） |
| POST | `/api/agent-console/models/discover` | 调 `llm/discoverModels` 探测可用模型 |
| GET | `/api/agent-console/plugins` | 插件卡（子智能体/网页搜索/Agent 循环/终端）+ 实验性插件 + 插件清单 |
| PATCH | `/api/agent-console/plugins/config/:cardKey` | 保存某个内置插件配置卡（web-search 的开关与动态字段在服务端归一化） |
| PATCH | `/api/agent-console/plugins/toggle` | 实验性插件/插件包开关（setBundleEnabled / setPluginEnabled） |
| GET | `/api/agent-console/presets` | Agent 预设列表 + 当前默认 |
| PUT | `/api/agent-console/presets/default` | 设为默认（settings.update `agent-preset-registry`.selectedDefault） |
| GET | `/api/agent-console/presets/:id` | 读一个预设的 YAML 组合（agentPresets/read） |
| GET | `/api/agent-console/advanced` | Session Log 开关 + 诊断信息 |
| PUT | `/api/agent-console/advanced/session-log` | 保存 Session Log 上传开关 |
| GET | `/api/agent-console/settings/:ns` | 兜底：按 namespace 读原始设置视图（schema+value+revision） |

所有写接口都带 `expectedRevision`（读视图里返回），DSH 报修改冲突时 BFF 映射为 409，页面刷新后重试。

## 手机端（Android）：经中枢窄代理远程配置（v1.5.1）

- **能力位**：`GET /api/runtime/capabilities` 的 `features.agentConsole` / `features.videoConfig` 在桌面与 Docker 恒为 true；Android 本机服务在「已绑定中枢」时为 true，未绑定为 false（设置页「Agent 与自动化」整域隐藏，直接访问 `/settings/agent-console` 显示「请先在 多端同步 绑定中枢」）。`agentAdmin` 在手机上仍为 false：外部接入 / MCP Token 不出现。
- **路由**：`EngramLocalServer.kt` 新增 18 条 `/api/agent-console/*` 窄代理 + `GET/PUT /api/settings/video-config` + 4 条 `/api/assistant/dream*` + `GET /api/guide`；均先过本机登录态，再以同步成员令牌转发中枢（`proxyAgent` / `proxyHub`）。
- **鉴权**：BFF 的 preHandler 从 `requireAuth` 改为 `requireAssistantAccess`（owner / MCP token / 同步成员令牌）；`/agent-console/*` 反代与旧 iframe 路径仍 owner-only。
- **安全**：手机能改中枢的模型 / 插件 / 预设 / 视频网关，但读不到任何 Key 明文（`credentials/describe` 只回 configured）；详见 `docs/ANDROID.md` 的「Agent 与自动化配置」。

## DSH 侧用到的 Remote endpoint

- 设置：`settings/describe|update|mutate|replace`
- 凭据：`credentials/describe|set|unset`（密钥只写不读，返回只有 configured/writable）
- 模型：`llm/listProviders|listConfigurableProviders|discoverModels`、`session/modelCatalog`
- 插件：`pluginManager/listBundles|listPlugins|setBundleEnabled|setPluginEnabled`、`pluginInventory/list`
- 预设：`agentPresets/list|read|select`
- 关键命名空间：`agent-default-model`、`llm-deepseek`、`llm-pi-ai`、`agent-preset-registry`、`subagent`、`agent-loop`、`web`/`web-search-deepseek`/`web-deepseek-api`、`pwsh-sandbox`（Linux 为 `bash-sandbox`）、`session-log-deepseek`

## 运行前提：桌面端必须用「真实 Node」拉 dsh（未变）

桌面端的内嵌 server 跑在 Electron 的纯 Node 模式里（`ELECTRON_RUN_AS_NODE=1`，`process.execPath` 是 Engram.exe）。
dsh 的 `node-addon-require-builtin` 只认 Electron 43/44/44.7/45 的 V8 指纹，Electron 36 直接被拒绝：

```text
dsh: host preparation failed: node-addon-require-builtin unsupported:
Unsupported/no-context (unsupported Electron runtime fingerprint: ...)
```

于是控制台进程「提前退出（code 1）」，聊天运行时同理（Docker 里 server 本身是真实 Node，不受影响）。
修复保持在 `server/src/assistant/agentNode.ts`：安装包带 `resources/node/node.exe`，源码模式用系统/便携 Node；
真实 Node 读不了 asar，所以 `desktop/package.json` 的 `asarUnpack` 含 `server/**`，dsh 入口在
`app.asar.unpacked/server/node_modules/@deepseek-ai/dsh/lib/bin.js`（`bundledDshExecutable()` 负责映射）。
原生控制台只改「浏览器这一侧的 UI」，这条运行时约束不变。

## 前端落位

- 路由：`/settings/agent-console`（`Home.vue` 的 `isActive('/settings')` 前缀匹配，自动保留 `settings-open` 布局）；
- 设置页：`AgentConsolePanel.vue` 只留状态条 + 「打开控制台」+ 刷新/重启/停止（桌面端不显示「在新标签打开」，因为 Electron 会把 window.open 交给系统浏览器）；
- 页面两栏：左侧「模型 / 插件 / Agent 预设 / 高级」，右侧对应面板；浅深主题、窄屏横向 tab；
- 文案照 DSH 简体中文（插件卡名称、提示语等），配色/字体用 Engram 主题变量。

## 验证

- Docker verify（build+typecheck+test）通过；隔离预览里打开 设置 → Agent 与自动化 →「内置 Agent 控制台」：
  状态「运行中」、四个分组可切换、模型页能读到 DeepSeek 提供商与模型目录、插件页 4 张配置卡和实验性开关可读写、
  预设页能切默认；控制台进程重启后页面能自动恢复（BFF 会重新兑换 cookie）。
- 桌面端另有一条必须单独走的验收（真实 Node 拉 dsh）：用隔离的 `ENGRAM_USER_DATA` / `ENGRAM_LOCAL_PORT`
  启动真实 Electron 窗口，打开原生控制台，状态栏「运行中」且能保存模型；server 日志有
  `[agent] dsh 运行时 Node：…resources\\node\\node.exe` 与 `dsh web: …` 启动行。
