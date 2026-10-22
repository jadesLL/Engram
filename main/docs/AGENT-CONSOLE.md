# 内置 Agent 控制台：复用 DeepSeek Harness 的插件与模型设置

> 分支 feat/agent-dsh-console。聊天抽屉界面保持不变；设置页多一个「内置 Agent 控制台」。

## 为什么做这个

内置 Agent 由随包依赖 `@deepseek-ai/dsh` 驱动，但 Engram 自己画了一套「API 地址 / 协议 / 模型 / Key」
表单。用户的实际反馈是：那套表单又丑又难用，而且**没有地方设置插件**——dsh 本身已经有成熟的
「插件」页与「设置 → 模型 / 内置插件」页，应该直接复用，而不是再维护一套。

## 方案（已验证）

把 DeepSeek Harness 的原生 Web 界面嵌进 Engram 设置页，并且让**控制台与聊天 Agent 共用同一个
dsh profile**，这样控制台里改的模型/插件直接作用于聊天：

1. **控制台进程**：`dsh --profile web --no-open --port <随机> --public-url <Engram origin>/agent-console/ --trusted-host <origin host>`。
   dsh 的 web profile 就是原生网页界面（左栏「插件」、右下「更多 → 设置」里的模型/内置插件/Agent 预设）。
2. **同源反向代理**：Engram 把 `/agent-console/*`（含 WebSocket `/agent-console/api/remote.mux`）
   原样转发到 127.0.0.1:<端口>，**不重写 Host / Origin / Cookie**（dsh 的浏览器信任围栏按 origin
   校验，重写会被 403）。这样桌面端、局域网 IP、DDNS / HTTPS 反代下行为一致，也不会有混合内容问题。
3. **聊天运行时复用同一 profile**：SDK 以 `profile: 'web'` 启动，并叠加一层聊天专用覆盖层
   （`engram-chat.cordis.yml`：插入 sdk 应用的 stdio JSON-RPC 服务，关掉 webserver / web-runtime /
   hmr / session-title-llm）。于是模型配置（profile patch）、插件开关（bundle 列表）、凭据文件
   由控制台与聊天共用。
4. **配置变更自动生效**：聊天运行时的配置指纹包含 profile patch / bundle 列表 / 凭据文件内容，
   控制台改完后下一轮对话会自动重开运行时（不用重启 Engram）。
5. **旧配置兼容**：Engram 旧版存的 `apiKey` 继续作为 `DEEPSEEK_API_KEY` 注入（dsh 模型页也会显示
   检测到环境变量）；旧的 `settings.yaml` 与它被导入到 profile patch 的模型路由条目在升级时清理。
   标题自动命名、收集箱转换等「服务端工具类」模型调用仍读旧配置（保留兼容，不影响聊天 Agent）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/assistant/console` | 控制台状态；默认确保启动，返回 `iframePath`（同源路径，含一次性 token）。owner 鉴权。 |
| POST | `/api/assistant/console/restart` | 重启（换访问地址 / 界面连不上时用） |
| POST | `/api/assistant/console/stop` | 停止（空闲 30 分钟也会自动停） |
| GET | `/api/assistant/status` | 额外返回 `agentVersion` / `profile` / `console{running,error}` |

代理路由 `/agent-console/*` 与 WebSocket 升级也在服务端注册（`assistant/agentConsoleProxy.ts`），
必须早于静态文件托管注册。

## 前端

- 设置 → Agent 与自动化 →「内置 Agent（聊天抽屉）」卡片：只保留运行时状态 + 一行摘要
  （`dsh <版本> · profile web`）+「配置模型与插件」跳转；
- 新增「内置 Agent 控制台」分组：状态栏（运行中/未启动/启动失败 + 启动时间 + dsh 版本）、
  刷新 / 重启 / 停止 / 在新标签打开，下面就是 DSH 原生界面的 iframe（高度 `min(76vh, 820px)`）。

## 验证

Docker verify（build+typecheck+test）+ 隔离预览：控制台进程能在容器里拉起、iframe 通过同源代理
正常加载 DSH 界面（插件页、设置 → 模型都能点到）、聊天运行时在该 profile 上完成 SDK 握手。
