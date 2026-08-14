# ExampleProject IM 桥接服务（@example-wiki/bridge）

把飞书 / 企业微信的聊天消息桥接到 [ExampleProject](..) 个人知识大脑，经 MCP 端点（`/mcp`）调用知识库能力。ExampleProject 本体零改动——只生成一个 MCP token。

## 工作方式

```
飞书/微信用户 ──消息──▶ 开放平台 ──webhook(签名)──▶ 桥接服务 ──MCP tools/call──▶ ExampleProject /mcp
                                                          ◀──带引用的答案──
              ◀──消息回发── 开放平台 ◀──API 发送── 桥接服务
```

桥接服务是独立 Fastify 进程，对外暴露：

| 路由 | 作用 |
|---|---|
| `GET /healthz` | 健康检查 |
| `POST /feishu/webhook` | 飞书事件订阅回调：验签 → 解密 → 立即 ack 200 → 异步处理 |
| `POST /notify` | ExampleProject 出站通知（阶段三）：任务终态/Dream 报告 → 转发飞书消息 |

聊天意图路由：

- `保存…` / `记录…` → MCP `save_chat`（沉积到 `原始资料/对话/` 并入队提炼）
- `读取 X` / `查看 X` → MCP `read_page`（按标题读页面全文）
- 其他 → MCP `think`（带引用与差距分析的知识库综合回答，拼入会话上下文）

飞书要求回调快速 200，因此签名校验与解密同步完成后立即 ack，真正的 MCP 调用与回发在后台异步进行；先回「🔍 正在检索知识库…」再补发答案。

## 为什么手写 MCP 客户端而非用 SDK

ExampleProject 的 MCP 服务端是无状态的（`sessionIdGenerator: undefined`，每请求新建实例）：`validateSession` 对所有请求放行、`Protocol._onrequest` 无初始化门禁，因此直接 `POST tools/call` 即可，无需 `initialize` 握手。响应以 SSE 返回（`event: message\ndata: {json}\n\n`），客户端流式读取到匹配 id 的响应后立即返回并 abort keepalive 流。零外部 MCP 依赖（仅 fastify）。

## 配置

复制 `.env.example` 为 `.env` 并填写：

| 变量 | 必需 | 说明 |
|---|---|---|
| `WIKILLM_MCP_URL` | 是 | ExampleProject MCP 端点，如 `http://example-wiki:8080/mcp` |
| `WIKILLM_MCP_TOKEN` | 是 | MCP Bearer token（`lwiki_…`，ExampleProject Settings 里生成） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书用 | 自建应用凭证 |
| `FEISHU_ENCRYPT_KEY` | 否 | 事件订阅加密密钥；配置后校验签名 + AES 解密 |
| `FEISHU_VERIFY_TOKEN` | 否 | 事件订阅校验 token；配置后校验 `header.token` |
| `NOTIFY_OPEN_ID` | 否 | 出站通知目标 open_id（阶段三） |

## 飞书应用配置

1. 飞书开放平台创建自建应用，取得 App ID / App Secret。
2. 「权限管理」开通 `im:message`（接收与发送消息）。
3. 「事件与回调」→ 订阅 `im.message.receive_v1`，回调地址填 `https://<bridge-host>:8090/feishu/webhook`。
4. 配置 Encrypt Key / Verification Token（建议开启加密）。
5. 发布版本并审核。

## 运行

```bash
# Docker（推荐，离线构建）
cd main/bridge && docker compose up -d --build

# 本机开发（需已装 pnpm 与依赖）
cd main/bridge && pnpm dev
```

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm test       # SSE 解析单测
pnpm build      # 编译到 dist/
```

## 阶段路线

- **阶段一（当前）**：飞书单向问答 + save_chat 沉积 + read_page 读取，经 MCP，ExampleProject 零改动。
- **阶段二**：企业微信（5 秒超时异步、AES-XML）适配。
- **阶段三**：ExampleProject 任务终态 / Dream 报告主动推送（`/notify`），可选补 MCP `job_status` 工具。
