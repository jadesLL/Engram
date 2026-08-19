# 🧠 LLM Wiki（ExampleProject）— 个人知识大脑

一个 **LLM 原生** 的知识库系统：Markdown 文件是权威数据源，数据库只做检索引擎。资料写入即被 AI 自动消化（分块 / 向量化 / 实体抽取 / 建图谱 / 智能整理），查询时直接给你**带引用的答案**，而不是一堆文件列表。

架构设计参考了 [GBrain](https://github.com/garrytan/gbrain)（YC 总裁 Garry Tan 的知识大脑）：

| GBrain 机制 | 本系统实现 |
|---|---|
| `search` / `think` 双模式 | 混合检索（向量+BM25+RRF）/ LLM 综合回答 + 引用角标 + **差距分析** |
| 自布线知识图谱 | 保存时自动提取 `[[双链]]` 建边（零LLM），后台 LLM 抽取实体与类型化关系，图谱可视化 |
| Dream Cycle 夜间整理 | 智能整理定时任务：查重 / 死链 / 矛盾检测 / 待丰富 / 过期提醒 → 整理报告页 |
| MCP 开放接口 | Claude Code / Cursor 等 Agent 可直接挂载查询你的知识库 |
| Markdown 权威源 | 页面存为 `.md` 文件（含 frontmatter），DB 崩溃可从文件全量重建 |

## 功能总览

**知识库**

- 📄 **页面管理**：Markdown 编辑（即时渲染/分屏）、`[[双链]]` 自动补全与跳转、标签、页面类型
- 🗂 **实体模型**：侧边栏顶层分组「概念 / 实体 / 归档」，实体下 7 类（人物/客户/组织/地点/作品/产品/其他）；客户实体走「信捷模式」（按 ACS 框架综合梳理）
- 🕸 **知识图谱**：全局/单页关系图，自动生长，死链可视化
- 🔎 **混合搜索**：向量语义 + 全文关键词（中文优化）融合排序
- 📝 **Office / PDF / 图片**：Docker 版集成 ONLYOFFICE 在线协同编辑；.docx 在线渲染入索引；PDF.js 查看/缩放/搜索；图片缩放拖动旋转，扫描页与图片按需调用视觉模型 OCR

**AI 智能整理**

- ♻️ **提炼管线**：Map → Normalize → Plan → Critic → Compose → Verify 六阶段，自动从原始资料（md/txt/docx/xlsx/pptx/pdf/图片）提炼事实并组织成页面
- ✅ **证据门禁**：自动新建知识页要求两个不同原始资料来源（不采信 LLM 自报置信度）；单来源挂账待补，待审批准会重新组织、验证并展示差异
- 📋 **整理报告**：待决策（选择题卡片）/ 待入库清单 / 提醒三区，按对象聚合；已处理区保留记录、可重新处理；合并类慢操作异步入队带进度条
- 📊 **提炼看板**：原始资料按整理状态分组、侧边栏覆盖率角标、一键补齐失败/未整理/已变更的资料
- 🔀 **实体歧义审核**：同名/近似实体身份歧义扫描与批量处理——合并（可选保留方向与自定义最终名称）/ 重命名 / 标记误报
- 🤝 **页面合并**：右键合并重复页面，AI 综合模式重写全文、统一 H1、保留曾用名

**AI 助手与集成**

- ✨ **AI 辅助写作**：续写 / 润色 / 扩写 / 总结 / 翻译（流式输出）
- 🤖 **应用内 Agent**：`Ctrl+J` 打开工作台，多轮知识问答、引用与差距分析；页面修改等动作经风险审批执行，会话保存在服务端
- 💬 **飞书 IM**：设置页配置凭证，长连接（WebSocket）直连应用内 Agent，飞书里直接问答知识库
- 🔌 **MCP 接口**：把知识库变成外部 AI Agent 的"外脑"

**部署与多端**

- 📱 **多端访问**：NAS Docker 部署 + 任意浏览器（PWA）；Windows 桌面端（Electron，本地内嵌 / 远端连接双模式）

## 快速开始（Docker 部署）

```bash
git clone https://gitea.example.com/example/ExampleProject.git
cd ExampleProject/main
docker compose up -d --build
```

访问 `http://<主机IP>:8080`，初始登录密码由 `docker-compose.yml` 的 `DEFAULT_PASSWORD` 环境变量指定（请自行修改；登录后可在设置页修改）。

公开仓库未发布 Docker 镜像；自建部署请从源码构建：

```bash
# Docker 镜像未公开发布（原私有 Registry 不对外）
docker pull gitea.example.com/example/exampleproject/example-wiki:<版本>
docker compose -f docker-compose.pull.yml up -d
```

Windows 桌面端安装包从 [Releases](https://gitea.example.com/example/ExampleProject/releases) 下载（`LLM Wiki Setup <版本>.exe`），详见 [`main/desktop/README.md`](./main/desktop/README.md)。

## 数据目录

数据都在 `./data`（映射到容器 `/data`），备份 = 复制整个 `data/` 目录；DB 丢失后可从 brain/ 重建。

```
data/
├── brain/              # 权威源：Markdown 页面 + 原始文件
│   ├── 原始资料/        # 上传的资料；md/txt/docx/xlsx/pptx/pdf/图片可提取并进入整理管线
│   ├── Wiki/           # 知识库页面（目录结构固定，不可增删）
│   │   ├── 概念/        # 概念类页面
│   │   ├── 实体/        # 人物/客户/组织/地点/作品/产品/其他 七类子目录
│   │   ├── 查询/        # AI 问答保存结果
│   │   └── 归档/        # 归档页面
│   ├── AIWorks/        # AI 工作区（索引/整理日志/方案）
│   ├── assets/         # 编辑器粘贴的图片（系统目录，不出现在文件树）
│   └── .trash/         # 回收站（软删除）
└── wiki.db             # SQLite 索引（向量/FTS/图谱/配置）
```

> 目录结构是**固定**的：页面只能建在 Wiki 树内，文件只能上传到「原始资料」，不提供新建文件夹入口。
> PDF 优先本地提取内嵌文字；扫描页和图片在对话模型支持图片输入时自动复用，否则需在设置页单独配置"视觉模型"。每批自动 OCR 最多 100 页，超出或失败时会明确标记为部分完成。

## 配置 LLM

设置页 → LLM：**选服务商 → 填 API Key 即可**，其余参数（Base URL/模型/Embedding）自动填充并持久化。

内置预设：DeepSeek、通义千问（阿里百炼）、智谱 GLM、Kimi、豆包（火山方舟）、硅基流动、OpenAI、自定义兼容接口。

视觉模型是可选覆盖项。当前对话模型支持 OpenAI 兼容图片输入时无需重复配置；否则可以选择内置视觉模型或自定义模型。只有图片和 PDF 中没有足够内嵌文字的页面会发送给视觉模型。

> DeepSeek / Kimi 没有 Embedding 服务，系统会自动搭配「硅基流动 bge-m3」作为向量化渠道（有免费额度，单独填一个 Embedding Key 即可）。更换 Embedding 模型/维度后需点「重建全部索引」。
>
> 未配置 LLM 时系统仍可用：编辑、关键词搜索、图谱、智能整理（除 AI 项）均正常工作。

## 应用内 Agent

按 `Ctrl+J` 打开 Agent 工作台。会话保存在服务端，可跨浏览器继续；关闭抽屉或切换页面不会中断正在执行的任务。

- 搜索页"问 AI"、编辑器续写/润色/扩写/总结/翻译均使用同一会话与工具内核。
- 查询、读取和导航自动执行；页面修改、归档、删除、整理等动作会先展示目标或差异并等待确认。
- 合并、永久删除、索引重建等高影响动作需要额外确认；API Key、密码、MCP Token 和一键清除不向 Agent 开放。
- 任务完成后可选择把本轮对话沉淀到 `原始资料/对话/`，不会默认写入知识库。

## MCP 接入（Claude Code / Cursor）

设置页 → MCP → 生成 Token，然后在 Claude Code 中：

```bash
claude mcp add --transport http example-wiki http://<主机IP>:8080/mcp \
  --header "Authorization: Bearer <你的token>"
```

提供工具：`search`（混合检索）、`think`（综合问答）、`read_page`、`write_page`、`list_pages`、`save_chat`（沉积对话入原始资料）。

> 接入方须遵守 [`main/docs/AI-CONTENT-OPERATIONS.md`](./main/docs/AI-CONTENT-OPERATIONS.md)：写入知识内容前先读取 `Wiki/log.md`，完成后追加一条倒序记录。服务端会经 MCP `instructions` 下发同一条纪律。

## 本地开发

```bash
cd main
pnpm install
pnpm dev          # server :8080 + web :5173（代理到 8080）
pnpm build        # 构建全部
pnpm start        # 生产模式运行（server 托管 web/dist）
```

> 上述命令用于人工维护单一检出目录。Agent 的并行 worktree 不执行 `pnpm install`，统一按 [`main/WORKTREES.md`](./main/WORKTREES.md) 在 Docker 中验证和预览。

## 快捷键

`Ctrl+K` 搜索/提问 · `Ctrl+J` AI 助手 · `Ctrl+N` 新建页面 · `Ctrl+S` 保存 · `[[` 插入双链 · `Ctrl+Enter` 打开光标处双链

## 技术栈

Fastify + better-sqlite3（FTS5 + sqlite-vec）· Vue 3 + Vditor + vis-network · Electron（桌面端）· Docker 单容器（+ ONLYOFFICE）

## 版本与发布

- **更新日志**：[`CHANGELOG.md`](./CHANGELOG.md)——每个版本的全部新功能与变更；发版时由 CI 自动发布到 GitHub Release 正文
- **GitHub Release**：`v*` 标签自动构建，附 Windows 安装包（exe）、Docker 镜像包（tar.gz）与 sha256 校验
- **镜像**：`gitea.example.com/example/exampleproject/example-wiki:<版本>`（未公开发布；需要请自行构建）
- **发版流程**：详见 [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md)

## 文档索引

| 文档 | 内容 |
|---|---|
| [`main/AGENTS.md`](./main/AGENTS.md) | 开发 Agent 约定（worktree、验证、合并） |
| [`main/WORKTREES.md`](./main/WORKTREES.md) | Worktree 工作流与资源隔离规则 |
| [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md) | Gitea CI/CD、发版流程、镜像分发 |
| [`main/docs/AI-CONTENT-OPERATIONS.md`](./main/docs/AI-CONTENT-OPERATIONS.md) | AI 操作知识内容的纪律 |
| [`main/docs/LLM-FIRST-ARCHITECTURE.md`](./main/docs/LLM-FIRST-ARCHITECTURE.md) | LLM 优先架构设计 |
| [`main/desktop/README.md`](./main/desktop/README.md) | Windows 桌面端（双模式、打包） |
