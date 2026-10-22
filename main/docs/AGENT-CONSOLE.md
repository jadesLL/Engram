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

## 运行前提：桌面端必须用「真实 Node」拉 dsh（关键）

桌面端的内嵌 server 跑在 Electron 的纯 Node 模式里（`ELECTRON_RUN_AS_NODE=1`，`process.execPath`
是 Engram.exe）。dsh 启动时要用 `node-addon-require-builtin` 探测 V8 内部结构，而它只认
Electron **43 / 44 / 44.7 / 45** 的 V8 指纹；Engram 用的 Electron 36 直接被拒绝：

```text
dsh: host preparation failed: node-addon-require-builtin unsupported:
Unsupported/no-context (unsupported Electron runtime fingerprint: Node 22.19.0,
V8 13.6.233.17-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6))
```

于是控制台进程会「提前退出（code 1）」，聊天运行时同理（Docker 里 server 本身是真实 Node，不受影响）。

修复方式：**桌面端用真实 Node.js（>=20）拉起 dsh**，实现见 `server/src/assistant/agentNode.ts`：

- 安装包形态：`desktop/scripts/prepare-node-runtime.js` 生成 `desktop/node/node.exe`，
  electron-builder 通过 `extraResources` 放进 `resources/node/node.exe`；desktop 主进程解析后经
  `ENGRAM_NODE_BIN` 交给 server，server 校验版本（>=20）并把 `process.execPath` 指向它
  （聊天走的官方 SDK 把命令硬编码成 `process.execPath`，没有注入点，只能这样统一）。
- 源码模式：用系统 Node（PATH）或 `install-engram.ps1` 的便携 Node（`%LOCALAPPDATA%\engram\node`）。
- 打包注意：真实 Node 读不了 asar，所以 `desktop/package.json` 的 `asarUnpack` 增加
  `server/**`，dsh 入口在 `app.asar.unpacked/server/node_modules/@deepseek-ai/dsh/lib/bin.js`，
  server 侧 `bundledDshExecutable()` 负责把 asar 路径映射成真实路径。

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

桌面端另有一条必须单独走的验收（Electron 36 的纯 Node 模式不支持 dsh 原生模块，见上文「运行前提」）：
用隔离的 `ENGRAM_USER_DATA` / `ENGRAM_LOCAL_PORT` 启动真实 Electron 窗口，打开
设置 → Agent 与自动化 →「内置 Agent 控制台」，状态栏显示「运行中」且 iframe 加载出 DSH 原生界面；
server 日志里能看到 `[agent] dsh 运行时 Node：…`（节点为真实 Node）与 `dsh web: …` 启动行。
修复前这条路径会直接报「控制台进程提前退出（code 1）」并附带 Electron 指纹错误。
