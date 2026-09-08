<p align="center">
  <img src="main/docs/brand/logo-lockup.svg" alt="Engram" width="440" />
</p>

# Engram — 个人知识大脑（外部 Agent 驱动）

一个**不内置任何 AI** 的自托管知识库：Markdown 文件是权威数据源，Engram 负责存储、文档解析、关键词检索与**确定性写入门禁**；读、写、提炼、综合、问答全部由你选用的外部 Agent（ZCode / Codex / Claude Code / Kimi / Cursor 等）通过 **MCP** 或 **CLI** 完成。模型与费用始终掌握在你自己的 Agent 订阅里，知识库零 API Key。

## 工作流

```
你导入资料 ──► Engram 存储并提取文本层（PDF 文字层 / Office / md）
                    │
外部 Agent ◄───────┤  MCP 9 工具 或 engram CLI（同一 Bearer Token）
（ZCode/Codex/…）   ▼
              按指南作业：Map→Normalize→Retrieve→Plan→Critic→Compose→Verify→Commit
                    │
              write_page 带证据引文 ──► 服务端逐字校验 + 两来源门禁 + 记入证据账本
```

- **《Agent 作业指南》三端同源**：MCP `kb_guide` 工具、`GET /api/guide`、`engram guide` 输出同一份方法论（页面契约、八阶段作业流程、证据规则），Agent 接上就能按既有逻辑干活。
- **CLI 优先、逐份串行**：能跑 shell 的 Agent 优先用 CLI（MCP 兜底用于图像直读等场景）；收到提炼指令先用 `files list --pending` 自动索引待提炼清单，逐份提炼、写完一份再下一份。
- **规则版本化，旧库可升级**：提炼规则带版本号（`GUIDE_VERSION`），Agent 每次写页服务端把版本记入页面索引元数据（只进索引库，不写正文）；规则升级后用 `pages list --outdated`（CLI）或 `list_pages` 传 `outdated=true`（MCP）列出落后的概念/实体页（原始资料只读不改），按最新指南逐页重写覆盖即完成旧库升级。
- **质量由确定性门禁兜底**：引文逐字校验（编造即拒绝）、新建概念/实体页两来源门禁（≥2 个不同原始资料路径各 1 条引文，或单路径 ≥2 条）、每次写入自动记入 `Wiki/log.md` 操作日志与证据账本（编辑器「来源证据」抽屉可逐条复核）。

## 功能总览

### 🧠 面向 Agent 的 MCP 接口（9 工具）

设置页生成 Token（`Authorization: Bearer`，MCP/CLI/REST 三用），streamable HTTP 端点 `/mcp`：

| 工具 | 说明 |
|---|---|
| `search` | 关键词检索（Wiki 页面 + 原始资料提取文本，FTS5 BM25） |
| `list_pages` / `read_page` | 目录树（页面带提炼规则版本；`outdated=true` 只列落后页面） / 按标题或 ID 读页面全文 |
| `page_evidence` | 读页面证据账本（来源、版本、事实与逐字引文） |
| `list_raw_files` / `read_raw_file` | 原始资料清单（含提取状态与「已提炼」标记；`pending=true` 只列未提炼文件）与读取；图片返回原图（image 内容）供视觉 Agent 自行识别 |
| `write_page` | 写页面；新建概念/实体页必须带 `evidence` 过两来源门禁，引文服务端逐字校验 |
| `save_chat` | 对话沉积到 `原始资料/对话/` |
| `kb_guide` | 下发《Agent 作业指南》全文 |

**各 Agent 接入**：设置 → MCP 集成 内置 ZCode / Codex / Claude Code / Kimi / 通用的配置片段一键复制；ZCode 另有「Agent 接入」页一键注册。Claude Code 示例：

```bash
claude mcp add --transport http engram http://<主机IP>:18080/mcp \
  --header "Authorization: Bearer <你的token>"
```

### ⌨️ engram CLI（零依赖，Node 22）

`node server/dist/cli.js <command>`（Docker 内 `docker exec engram node dist/cli.js`；桌面端 `ELECTRON_RUN_AS_NODE=1 Engram.exe app.asar/server/dist/cli.js`）。命令覆盖 `login / status / import / files list|read / search / pages list|read|write|evidence / chat save / guide / mcp-config`，全部支持 `--json` 供 Agent 消费；`files list --pending` 只列未提炼文件（提炼作业索引用）；`pages list --outdated` 只列提炼规则版本落后于当前指南的概念/实体页（规则升级后重提炼用）；私网/环回目标经 `login` 显式登记后放行（出网校验协议/云元数据阻断/DNS rebinding 防护）。

### 📄 页面编辑与管理

- **Markdown 编辑器**（Vditor）：即时渲染 / 分屏切换、大纲、全屏、`Ctrl+S`、中文输入法组字保护；图片粘贴自动入 `assets/`
- **`[[双链]]`**：输入 `[[` 补全，点击跳转；改名自动重定向全部引用
- **页面类型系统**：概念 / 实体七子类（人物/客户/组织/地点/作品/产品/其他），类型即目录，头部下拉切换自动移动
- **来源证据抽屉**：每页的原子事实 + 原文逐字引文 + 来源版本时间线，AI 写的内容可溯源、可核对
- **回收站**（软删除）、标签、本页关联（双链邻居/实体关系）、阅读模式

### 🕸 知识图谱

全局图 / 单页局部图（vis-network 力导向），按类型着色、死链红色节点；保存页面自动提取 `[[双链]]` 建边（零成本、零模型）。

### 📎 附件与在线预览

- **ONLYOFFICE 在线协同编辑**（Docker 版，JWT 鉴权），docx/xlsx/pptx 浏览器编辑保存，带版本快照回滚
- **PDF 查看器**：缩略图/搜索/跳页；「原文 / 提取文本」双视图
- **图片查看器**：缩放旋转拖动
- 文档文本层自动进入检索索引；图片与无文字层的扫描 PDF 不做内置 OCR——外部 Agent 用 `read_raw_file` 读原图自行识别

### 📱 多端与部署

- **多端实时同步（同步群组）**：把多台设备组成一个同步群组——选一台做**中枢**（建议常开的 NAS Docker 版，唯一需要可被访问的设备），其他设备用中枢签发的绑定令牌加入。页面、附件图片、原始资料文件与证据账本**秒级双向同步**，字符级三方合并（非重叠编辑自动融合；同位置冲突以先到方为准，后到方完整内容保存到 `AIWorks/同步冲突/` 不丢失）。每端都是完整本地库：**离线照常工作**，各端 Agent 各连本地 MCP 互不影响，重连自动补同步（设置 → 多端同步）
- **NAS Docker**：单容器 + ONLYOFFICE；**Android APP** 远程客户端；**Windows 桌面端**（Electron 本地模式内嵌后端 / 远端模式凭令牌连 NAS，托盘驻留、自动更新）
- **IPv6 直连优先 + Cloudflare 隧道兜底**、内置 HTTPS（ACME/DNS-01）、内置 DDNS（Cloudflare API）
- **应用内自更新**：Docker 网页一键升级；桌面端全自动更新
- 设置页 9 大面板：账户、MCP 集成、Agent 接入、多端同步、桌面端连接、软件更新、DDNS 直连、存储空间、数据管理

## 下载与安装

三种使用方式，按机器选择：

**Windows 桌面端 · 安装包**（给非开发机器）

1. 从发行仓库 [engram-dist Releases](https://gitea.example.com/example/engram-dist/releases) 下载 `Engram Setup <版本>.exe`（只放产物不含源码；私有仓库，需已授权账号）
2. 双击安装；数据在 `%APPDATA%\@engram\desktop`，与源码版互通
3. 更新：应用内 设置 → 软件更新 → 「检查更新」，自动下载并静默安装

**Windows 桌面端 · 源码版**（自用开发机，推荐）

1. 从 [engram-dist Releases](https://gitea.example.com/example/engram-dist/releases) 下载源码版安装器 `Engram-source-setup.exe`（或取仓库内 `main/scripts/install-engram.ps1` 用 PowerShell 运行），双击后全自动：下载便携 Git/Node/pnpm（免管理员，装在 `%LOCALAPPDATA%\engram`）→ 克隆源码（公开仓库无需凭据）→ 构建桌面端 → 生成桌面快捷方式并启动
2. 日常双击桌面「Engram」= 增量拉最新源码重建启动；应用内「检查更新」同样增量拉源码更新——合 main 即更新，无需等发版

**Docker（服务器 / NAS）**：见下方「快速开始（Docker 部署）」；更新可在 设置 → 软件更新 一键拉镜像重建（需挂载 docker.sock）。

> Android APK 随发版附于 engram-dist Releases。

## 快速开始（Docker 部署）

```bash
git clone https://github.com/jadesLL/Engram.git
cd Engram/main
docker compose up -d --build
```

访问 `http://<主机IP>:18080`。初始密码：`DEFAULT_PASSWORD` 环境变量非空时用其值；留空时首次登录页面直接设置。

公开仓库未发布 Docker 镜像；自建部署请从源码构建：

```bash
# Docker 镜像未公开发布（原私有 Registry 不对外）
# 需要镜像请自行构建：docker compose -f main/docker-compose.yml up -d --build
docker compose -f docker-compose.pull.yml up -d
```

Windows 桌面端安装包从 [engram-dist Releases](https://gitea.example.com/example/engram-dist/releases) 下载（`Engram Setup <版本>.exe`），更多安装方式见上文「下载与安装」。

> 想从源码自行构建，见 [`main/docs/BUILDING.md`](./main/docs/BUILDING.md)。

## 数据目录

数据都在 `./data`（映射到容器 `/data`）；DB 丢失后可从 brain/ 重建。

**备份/恢复**：设置 → 数据管理 → 「导出备份」一键打包整库（`wiki.db` + `brain/`）为 zip 下载；「从备份恢复」上传备份 zip 并输密码后暂存，重启服务生效（桌面端本地模式自动重启，Docker 版重启容器）。旧数据会保留一代（`wiki.db.pre-restore` / `brain.pre-restore`）便于手动回退。桌面端还可在设置里自定义数据保存位置（类 Obsidian 仓库位置，更换时旧数据自动迁移），Docker 版数据位置由 compose 卷挂载决定。

**本地服务端口**（桌面端本地模式）：设置 → 数据管理 → 「本地服务端口」可修改内嵌后端监听端口，默认 18180（与 Docker 版 18080 互不冲突）；改动前自动预检端口占用，应用后内嵌服务以新端口重启，配置存桌面端 `config.json`。Docker 版端口仍由 compose 映射控制。

```
data/
├── brain/              # 权威源：Markdown 页面 + 原始文件
│   ├── 原始资料/        # 上传的资料与对话沉积；文本层提取后可被检索
│   ├── Wiki/           # 知识库页面（概念/实体七子类/查询/归档/关系，目录固定）
│   ├── AIWorks/        # 系统区（log/log.md 操作日志、index/index.md 索引、scheme/relationships.md 关系库；服务端自动生成，不参与检索）
│   ├── assets/         # 编辑器粘贴的图片
│   └── .trash/         # 回收站（软删除）
└── wiki.db             # SQLite（FTS 索引/图谱/配置/证据账本）
```

> 目录结构固定：页面只能建在 Wiki 树内，文件只能上传到「原始资料」。

## 让 Agent 开始干活

1. 设置 → MCP 集成 → 生成 Token；复制对应 Agent 的接入片段（或 CLI `login` 保存连接）
2. Agent 侧获取作业方法论：MCP `kb_guide` / `engram guide`
3. 按指南作业即可——收到提炼指令先自动索引待提炼清单（`files list --pending`），逐份提炼、写页带 `evidence` 引文，门禁与服务端日志自动兜底；提炼过的源文件在侧栏自动标「已提炼」

> 接入方纪律详见 [`main/docs/AI-CONTENT-OPERATIONS.md`](./main/docs/AI-CONTENT-OPERATIONS.md)；MCP `instructions` 会下发浓缩版。

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

`Ctrl+K` 搜索 · `Ctrl+N` 新建页面 · `Ctrl+S` 保存 · `[[` 插入双链 · `Ctrl+Enter` 打开光标处双链

## 技术栈

Fastify + better-sqlite3（FTS5）· Vue 3 + Vditor + vis-network · Electron（桌面端）· Docker 单容器（+ ONLYOFFICE）

## 版本与发布

- **更新日志**：[`CHANGELOG.md`](./CHANGELOG.md)——每个版本的全部新功能与变更；发版时由 CI 自动发布到 GitHub Release 正文
- **GitHub Release**：`v*` 标签自动构建，附 Windows 安装包（exe）、Android 安装包（apk）、Docker 镜像包（tar.gz）与 sha256 校验；Release 挂在发行仓库 [example/engram-dist](https://gitea.example.com/example/engram-dist)（只放产物不含源码），发版是显式动作，仅按需执行
- **源码模式通道**：自用机器不依赖发版——合 main 后即可通过桌面快捷方式或应用内「检查更新」增量拉源码更新（见「下载与安装」）
- **镜像**：`gitea.example.com/example/engram/engram:<版本>`（未公开发布；需要请自行构建）
- **发版流程**：详见 [`main/docs/BUILDING.md`](./main/docs/BUILDING.md)；CI/CD 维护见 [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md)

## 文档索引

| 文档 | 内容 |
|---|---|
| [`main/AGENTS.md`](./main/AGENTS.md) | 开发 Agent 约定（worktree、验证、合并） |
| [`main/WORKTREES.md`](./main/WORKTREES.md) | Worktree 工作流与资源隔离规则 |
| [`main/docs/BUILDING.md`](./main/docs/BUILDING.md) | 构建与部署指南（安装包生成、发版、部署） |
| [`main/docs/GITEA-CI.md`](./main/docs/GITEA-CI.md) | Gitea CI/CD、发版流程、镜像分发 |
| [`main/docs/IPV6.md`](./main/docs/IPV6.md) | IPv6 直连优先 + 隧道兜底（部署、DDNS、路由器放行） |
| [`main/docs/AI-CONTENT-OPERATIONS.md`](./main/docs/AI-CONTENT-OPERATIONS.md) | 外部 Agent 操作知识内容的纪律总纲 |
| [`main/desktop/README.md`](./main/desktop/README.md) | Windows 桌面端（双模式、打包） |
