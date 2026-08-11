# 🧠 LLM Wiki — 个人知识大脑

一个 **LLM 原生** 的知识库系统：Markdown 文件是权威数据源，数据库只做检索引擎。文档写入即被 AI 自动消化（分块 / 向量化 / 实体抽取 / 建图谱），查询时直接给你**带引用的答案**，而不是一堆文件列表。

架构设计参考了 [GBrain](https://github.com/garrytan/gbrain)（YC 总裁 Garry Tan 的知识大脑）：

| GBrain 机制 | 本系统实现 |
|---|---|
| `search` / `think` 双模式 | 混合检索（向量+BM25+RRF）/ LLM 综合回答 + 引用角标 + **差距分析** |
| 自布线知识图谱 | 保存时自动提取 `[[双链]]` 建边（零LLM），后台 LLM 抽取实体与类型化关系，图谱可视化 |
| Dream Cycle 夜间整理 | 定时任务：查重 / 死链 / 矛盾检测 / 待丰富 / 过期提醒 → 整理报告页 |
| MCP 开放接口 | Claude Code / Cursor 等 Agent 可直接挂载查询你的知识库 |
| Markdown 权威源 | 页面存为 `.md` 文件（含 frontmatter），DB 崩溃可从文件全量重建 |

## 功能总览

- 📄 **页面管理**：Markdown 编辑（即时渲染/分屏）、`[[双链]]` 自动补全与跳转、标签、页面类型
- ✨ **AI 辅助写作**：续写 / 润色 / 扩写 / 总结 / 翻译（流式输出）
- 🤖 **应用内 Agent**：多轮知识问答、引用与差距分析，并可经风险审批调用页面、资料、整理、报告和任务能力
- 🔎 **混合搜索**：向量语义 + 全文关键词（中文优化）融合排序
- 🕸 **知识图谱**：全局/单页关系图，自动生长，死链可视化
- 📋 **Dream Cycle**：每晚自动整理知识库，产出可操作的整理报告
- 📝 **Word 预览**：.docx 在线渲染，文本自动入索引（AI 可读）；其他格式调系统程序打开
- 🖼 **PDF / 图片**：PDF.js 在线查看、缩放、缩略图与搜索；图片支持缩放、拖动和旋转，文字型 PDF 本地提取，扫描页和图片按需调用支持图片输入的模型
- ✅ **证据门禁**：自动新建知识页要求两个不同原始资料来源；待审批准会重新组织、验证并展示差异
- 🔌 **MCP 接口**：把知识库变成外部 AI Agent 的"外脑"
- 📱 **多端**：NAS Docker 部署，Windows 桌面端（Tauri）+ 安卓/任意浏览器访问

## 快速开始（NAS Docker 部署）

```bash
git clone <本仓库>  # 或下载源码解压
cd Wiki知识库
docker compose up -d --build
```

访问 `http://<NAS的IP>:8080`，使用初始密码登录：**`CHANGE_ME_PUBLIC_SNAPSHOT_PLACEHOLDER`**
（可在 `docker-compose.yml` 中用环境变量 `DEFAULT_PASSWORD` 自定义；登录后可在设置页修改）

数据目录：`./data`（映射到容器 `/data`）

```
data/
├── brain/              # 权威源：Markdown 页面 + 原始文件
│   ├── 原始资料/        # 上传的资料；md/txt/docx/xlsx/pptx 可提取文本并进入整理管线
│   ├── Wiki/           # 知识库页面（目录结构固定，不可增删）
│   │   ├── 概念/        # 概念类页面
│   │   ├── 实体/        # 人物/组织/事物
│   │   ├── 查询/        # AI 问答保存结果
│   │   └── 归档/        # 归档页面
│   ├── AIWorks/        # AI 工作区
│   │   ├── index/
│   │   ├── log/        # Dream Cycle 每日整理日志
│   │   └── scheme/
│   ├── assets/         # 编辑器粘贴的图片（系统目录，不出现在文件树）
│   └── .trash/         # 回收站（软删除）
└── wiki.db             # SQLite 索引（向量/FTS/图谱/配置）
```

> 目录结构是**固定**的：页面只能建在 Wiki 树内，文件只能上传到「原始资料」，
> 不提供新建文件夹入口。备份 = 复制整个 `data/` 目录；DB 丢失后可从 brain/ 重建。
>
> 当前 AI 整理支持 Markdown、TXT、DOCX、XLSX、PPTX、PDF，以及 PNG/JPEG/WebP/GIF/SVG 图片，
> 并递归处理「原始资料」子目录。PDF 优先本地提取内嵌文字；扫描页和图片需要在
> 当前对话模型支持图片输入时会自动复用；否则需要在设置页单独配置“视觉模型”。每批自动 OCR 最多 100 页，超出或失败时会明确标记为部分完成。

## 配置 LLM

设置页 → LLM：**选服务商 → 填 API Key 即可**，其余参数（Base URL/模型/Embedding）自动填充并持久化。

内置预设：DeepSeek、通义千问（阿里百炼）、智谱 GLM、Kimi、豆包（火山方舟）、硅基流动、OpenAI、自定义兼容接口。

视觉模型是可选覆盖项。当前对话模型支持 OpenAI 兼容图片输入时无需重复配置；
否则可以选择内置视觉模型或自定义模型。只有图片和 PDF 中没有足够内嵌文字的页面会发送给视觉模型。

> DeepSeek / Kimi 没有 Embedding 服务，系统会自动搭配「硅基流动 bge-m3」作为向量化渠道
> （有免费额度，单独填一个 Embedding Key 即可）。
> 更换 Embedding 模型/维度后需点「重建全部索引」。
>
> 未配置 LLM 时系统仍可用：编辑、关键词搜索、图谱、Dream Cycle（除 AI 项）均正常工作。

## 应用内 Agent

按 `Ctrl+J` 打开 Agent 工作台。会话保存在服务端，可跨浏览器继续；关闭抽屉或切换页面不会中断正在执行的任务。

- 搜索页“问 AI”、编辑器续写/润色/扩写/总结/翻译均使用同一会话与工具内核。
- 查询、读取和导航自动执行；页面修改、归档、删除、整理等动作会先展示目标或差异并等待确认。
- 合并、永久删除、索引重建等高影响动作需要额外确认；API Key、密码、MCP Token 和一键清除不向 Agent 开放。
- 任务完成后可选择把本轮对话沉淀到 `原始资料/对话/`，不会默认写入知识库。

## 多端访问

- **Windows / 安卓浏览器**：直接访问 `http://<NAS的IP>:8080`，安卓可"添加到主屏幕"（PWA）
- **Windows 桌面端**：见 `desktop/README.md`（Tauri 壳，支持"用系统程序打开"远程文件）
- **外网访问**：建议配合 NAS 的反向代理（NPM/Traefik）+ HTTPS；或 Tailscale/组网工具

## MCP 接入（Claude Code / Cursor）

设置页 → MCP → 生成 Token，然后在 Claude Code 中：

```bash
claude mcp add --transport http example-wiki http://<NAS的IP>:8080/mcp \
  --header "Authorization: Bearer <你的token>"
```

提供工具：`search`（混合检索）、`think`（综合问答）、`read_page`、`write_page`、`list_pages`、`save_chat`（沉积对话入原始资料）。

> 接入方须遵守 [`docs/AI-CONTENT-OPERATIONS.md`](./docs/AI-CONTENT-OPERATIONS.md)：写入知识内容前先用 `read_page` 读取 `Wiki/log.md`，完成后用 `write_page` 追加一条倒序记录。服务端会经 MCP `instructions` 下发同一条纪律。

## 本地开发

```bash
pnpm install
pnpm dev          # server :8080 + web :5173（代理到 8080）
pnpm build        # 构建全部
pnpm start        # 生产模式运行（server 托管 web/dist）
```

> 上述命令用于人工维护单一检出目录。Agent 的并行 worktree 不执行 `pnpm install`，统一按 [`WORKTREES.md`](./WORKTREES.md) 在 Docker 中验证和预览。

> **Windows 开发注意**：若 `pnpm install` 后 better-sqlite3 未编译（本机无 Python/VS Build Tools），
> 可从 npmmirror 下载预编译二进制放到
> `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node`。
> Docker 部署不受影响（镜像内自动源码编译）。

## 快捷键

`Ctrl+K` 搜索/提问 · `Ctrl+J` AI 助手 · `Ctrl+N` 新建页面 · `Ctrl+S` 保存 · `[[` 插入双链 · `Ctrl+Enter` 打开光标处双链

## 技术栈

Fastify + better-sqlite3（FTS5 + sqlite-vec）· Vue 3 + Vditor + vis-network · Tauri v2 · Docker 单容器
