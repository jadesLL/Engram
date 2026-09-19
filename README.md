<p align="center">
  <img src="main/docs/brand/logo-lockup.svg" alt="Engram" width="440" />
</p>

# Engram — 个人知识大脑（确定性内核 + Agent 驱动）

一个**内核不内置任何 AI** 的自托管知识库：Markdown 文件是权威数据源，Engram 负责存储、文档解析、关键词检索与**确定性写入门禁**；读、写、提炼、综合、问答由 Agent 通过 **MCP** 或 **CLI** 完成——既可以用你已有的外部 Agent（ZCode / Codex / Claude Code / Kimi / Cursor 等），也可以用 Engram **随包内置的 Agent**（内嵌 DeepSeek Harness 的聊天抽屉，配一把你自己的模型 Key 即可开口）。两条路都走同一套 MCP 工具与证据门禁；不配 Key 时内置 Agent 不出网，知识库依旧零 API Key。

## 工作流

```
你导入资料 ──► Engram 存储并提取文本层（PDF 文字层 / Office / md）
                    │
外部 Agent ◄───────┤  MCP 15 工具 或 engram CLI（同一 Bearer Token）
（ZCode/Codex/…）   ▼
              按指南作业：Map→Normalize→Retrieve→Plan→Critic→Compose→Verify→Commit
                    │
              write_page 带证据引文 ──► 服务端逐字校验 + 两来源门禁 + 记入证据账本
```

- **《Agent 作业指南》三端同源**：MCP `kb_guide` 工具、`GET /api/guide`、`engram guide` 输出同一份方法论（页面契约、八阶段作业流程、证据规则），Agent 接上就能按既有逻辑干活。
- **内置 skill 按需下发**：服务端内置作业手法（`skill_list` 列清单、`skill_guide` 取全文），如纪要转 Markdown、入库纪律；skill 版本独立于指南版本，改 skill 不把已有页面标为规则落后。
- **CLI 优先、逐份串行**：能跑 shell 的 Agent 优先用 CLI（MCP 兜底用于图像直读等场景）；收到提炼指令先用 `files list --pending` 自动索引待提炼清单，逐份提炼、写完一份再下一份。
- **规则版本化，旧库可升级**：提炼规则带版本号（`GUIDE_VERSION`），Agent 每次写页服务端把版本记入页面索引元数据（只进索引库，不写正文）；规则升级后用 `pages list --outdated`（CLI）或 `list_pages` 传 `outdated=true`（MCP）列出落后的概念/实体页（原始资料只读不改），按最新指南逐页重写覆盖即完成旧库升级。
- **质量由确定性门禁兜底**：引文逐字校验（编造即拒绝）、新建概念/实体页两来源门禁（≥2 个不同原始资料路径各 1 条引文，或单路径 ≥2 条）、每次写入自动记入 `Wiki/log.md` 操作日志与证据账本（编辑器「来源证据」抽屉可逐条复核）。
- **全自动、不打断**：作业全流程不问用户——资料里查不到的先自查全库，仍无定论就按证据取最可信写法落页，并在正文标注「待核实」与依据（不编造、不空等），后续资料补齐再收敛；客户/公司页按 v3 契约写「概览」「核心机型」与「名称口径」，标题用工商全名、别名收在名称口径里。

## 功能总览

### ✨ 内置 Agent（聊天抽屉）

- **随包内置、开箱即用**：DeepSeek Harness（dsh）作为依赖随桌面端与 Docker 镜像一起发，无需另外安装；左栏点亮 ✨ 打开聊天抽屉，输入问题即可
- **选中文字就地提问**：在文件预览（txt / Markdown / HTML / PDF 与图片的提取文本 / Office 简化预览）、页面阅读视图与编辑器里选中任意文字，右击选「在 Agent 中提问」，聊天抽屉随即打开、光标已在输入框，选中的原文与所在文件/页面作为上下文一起送给 Agent（顶部以「文件：…」「选中 N 字」chip 显示，点 × 即清除）；同一菜单里的「在知识库中搜索」照旧
- **右侧并排 / 满窗全屏**：抽屉可一键在「右侧并排」与「满窗铺满内容区」之间切换（满窗只铺满正文区，左侧图标栏与文件树保持可见可用；桌面端标题栏与窗口按钮照常可用），选择记在本地，下次打开沿用；满窗下按 `Esc` 或点「收回右侧」即可还原
- **只读沙箱 + 仅经 MCP 工具**：Agent 的工作目录是数据目录下的空壳 `data/dsh/workspace`，不是知识库目录；知识库的读写全部经 `mcp__engram__*` 工具，因此 `write_page` 的证据逐字校验、两来源门禁与操作日志照常生效
- **单列转录、执行记录可展开**：对话流与 dsh 同构——用户消息、Agent 正文、工具调用（检索 / 读页 / 写页…）按发生顺序排成一条单列流；工具调用默认收起为一行摘要（工具名 + 参数 + 状态），点开即看完整参数与完整结果（等宽滚动，不截断），失败自动展开；助手正文在该步提交后整段到达；可随时「停止」，可把一轮对话「沉淀到原始资料」供后续提炼
- **自己的 Key、自己的账**：模型与 Key 填在 设置 → Agent 接入 → 内置 Agent（Key 仅存本机数据库，运行时经环境变量注入，不写进配置文件的明文里）；不填就不能对话，Engram 其余功能完全不受影响
- **API 地址可自定义**：地址留空走 DeepSeek 官方（`api.deepseek.com`）；填中转站或自建网关（`openai-completions` / `openai-responses` / `anthropic-messages` 三种协议）即改用该地址与它自己的模型名——地址与模型清单写进内置 dsh 的 `data/dsh/settings.yaml`（dsh 的 `llm-pi-ai` 自定义 provider 路由，不含 Key），改完下一次对话即生效（池里的旧运行时按旧路由跑，会自动重开）
- **会话与桌面/Docker 一致**：会话与消息存本机库（`assistant_*` 表），dsh 自身的会话日志随 `data/dsh/` 走持久卷，续聊不丢上下文

### 🧠 面向 Agent 的 MCP 接口（15 工具）

在 设置 → Agent 接入 →「其他 Agent（MCP 接入）」生成 Token（`Authorization: Bearer`，MCP/CLI/REST 三用），streamable HTTP 端点 `/mcp`：

| 工具 | 说明 |
|---|---|
| `search` | 关键词检索（Wiki 页面 + 原始资料提取文本，FTS5 BM25）；中文 bigram 分词 + 错字兜底 + 同义词扩展 |
| `list_pages` / `read_page` | 目录树（页面带提炼规则版本；`outdated=true` 只列落后页面，`path`/`tag` 按路径前缀与标签过滤） / 按标题或 ID 读页面全文 |
| `related_pages` | 读页面图谱关联（入链/出链邻居与实体关系，与编辑器「相关页面」同一数据） |
| `page_evidence` | 读页面证据账本（来源、版本、事实与逐字引文） |
| `list_raw_files` / `read_raw_file` | 原始资料清单（含提取状态与「已提炼」标记；`pending=true` 只列未提炼文件）与读取；图片返回原图（image 内容）供视觉 Agent 自行识别 |
| `write_page` | 写页面（只允许 `Wiki/` 下）；新建概念/实体页必须带 `evidence` 过两来源门禁，引文服务端逐字校验 |
| `rename_page` | 重命名页面：文件随标题移动、`[[旧标题]]` 双链自动重定向，页面 ID 与图谱边保持不变 |
| `move_page` | 移动页面到 `Wiki/` 树内其他目录（页面 ID 与图谱边保持不变，可顺带改标题） |
| `delete_page` | 单页软删除入回收站（可恢复，按标题 / ID / 路径定位）；只允许 `Wiki/` 下的页面，`原始资料/` 与 `AIWorks/` 拒删，无永久删除/清空回收站能力 |
| `save_chat` | 对话沉积到 `原始资料/对话/`（**须用户明确指示**才可调用） |
| `kb_guide` | 下发《Agent 作业指南》全文 |
| `skill_list` / `skill_guide` | 内置作业 skill：先列清单（名称 / 用途 / 何时用 / 版本），需要时再取某份全文。skill 与指南同级但按需获取，版本独立于 `GUIDE_VERSION`，改 skill 不触发全库「规则落后」 |

**各 Agent 接入**：设置 → Agent 接入 一个面板搞定——「接入目标」选 ZCode 桌面端 / Codex CLI / DeepSeek Harness（dsh）可一键注册；选「其他 Agent」显示 MCP Server 地址、Token 管理与 Codex / Claude Code / Kimi / 通用配置片段一键复制；面板底部「查看工具」（默认收起，点「展开全部」查看）逐条列出现有 MCP 工具（功能、参数、要点与 CLI 等价命令）。

| 一键接入目标 | 写入位置 | 说明 |
|---|---|---|
| ZCode 桌面端 | `~/.zcode/cli/config.json` | 检测本机安装与登录状态，注册/移除知识库 MCP |
| Codex CLI | `~/.codex/config.toml`（`[mcp_servers.engram]`） | 只维护 Engram 这一个 TOML 表，其余配置、注释与其他 `[mcp_servers.*]` 条目原样保留；重启 Codex 会话生效 |
| DeepSeek Harness（dsh） | `$DSH_HOME/cordis.patch.yml` | 对整个 patch 层注册，对所有 dsh profile 生效 |

一键注册只对本机安装的客户端落地（需与 Engram 桌面版同一台电脑）；Docker/远程部署时让 Agent 用「其他 Agent」的 MCP 片段或 `engram login` 连接。Claude Code 示例：

```bash
claude mcp add --transport http engram http://<主机IP>:18080/mcp \
  --header "Authorization: Bearer <你的token>"
```

### ⌨️ engram CLI（零依赖，Node 22）

`node server/dist/cli/cli.js <command>`（Docker 内 `docker exec engram node dist/cli/cli.js`；桌面端 `ELECTRON_RUN_AS_NODE=1 Engram.exe app.asar/server/dist/cli/cli.js`）。**本机服务零配置**：服务端启动时自动把本机地址与专用 token 登记到 `~/.engram/config.json`（地址随实际端口自适应，不写死；用户手动 `login` 保存的配置优先、不被覆盖），CLI 开箱即用，远程服务再手动 `login` 一次。命令覆盖 `login / status / import / files list|read / search / pages list|read|write|delete|evidence / chat save / ask / questions / guide / mcp-config`，全部支持 `--json` 供 Agent 消费；`pages read/evidence/delete` 接受 `pages list` 返回的页面 ID（UUID）、标题或页面路径；`pages delete` 只把 `Wiki/` 下的页面移入回收站（软删除，`原始资料/`、`AIWorks/` 拒删）；`files list --pending` 只列未提炼文件（提炼作业索引用）；`pages list --outdated` 只列提炼规则版本落后于当前指南的概念/实体页（规则升级后重提炼用）；私网/环回目标经 `login` 显式登记后放行（出网校验协议/云元数据阻断/DNS rebinding 防护）。

### 📄 页面编辑与管理

- **Markdown 编辑器**（Vditor）：即时渲染 / 分屏切换、大纲、全屏、`Ctrl+S`、中文输入法组字保护；图片粘贴自动入 `assets/`；顶部条面包屑 + 保存状态点 + 保存按钮 + 按文件的「自动保存」开关（默认开，关闭后仅手动保存/Ctrl+S）、标题与正文列对齐、统一描边工具栏图标、底部状态栏（字数 / 模式 / 来源 / 图谱）；深色模式下原生下拉/滚动条随主题变色
- **`[[双链]]`**：输入 `[[` 或工具栏按钮唤起补全弹窗（跟随光标、↑↓ 选择、回车插入），编辑态虚线下划线标识，点击跳转；改名自动重定向全部引用
- **页面类型系统**：概念 / 实体五子类（人物/客户/组织/项目/其他），类型即目录，头部下拉切换自动移动
- **来源证据抽屉**：每页的原子事实 + 原文逐字引文 + 来源版本时间线，AI 写的内容可溯源、可核对
- **回收站**（软删除，Agent 经 MCP `delete_page` / CLI `pages delete` 删除同样只入回收站）、标签、本页关联（双链邻居/实体关系）、沉浸阅读（**打开页面默认进入阅读视图**，需编辑时点「返回编辑」；正文字号 1px 连续可调，8–48px，点字号可直接下拉选择；标题左侧箭头可按节收放（H2–H4，收起时连同子节一起折叠，状态仅当前会话））
- **双链往返**：点双链/本页关联跳转后，阅读工具栏与编辑顶栏出现「返回上一页」（Alt+←），可沿跳转链路逐级回退；鼠标扫过该按钮即下拉列出链路上所有可返回的页面名称（栈顶在最前，标注「上一页 / 第 N 层」），点任意一层直接跳回，其余记录仍可继续逐层返回；从侧栏、搜索等处跳转会清空该链路
- **中文搜索增强**：全文索引按 bigram 分词（单字也能命中）；**错字兜底**——词表内做编辑距离 ≤1 的邻居扩展（「部属」→「部署」）；**同义词扩展**——设置 → 数据管理 → 搜索同义词（默认折叠，内置常用词表），每行一组逗号分隔，查询命中组内任一词即一并检索

### 🕸 知识图谱

全局图 / 单页局部图（vis-network 力导向），按类型着色、死链红色节点；保存页面自动提取 `[[双链]]` 建边（零成本、零模型）。

### 📎 附件与在线预览

- **ONLYOFFICE 在线协同编辑**（Docker 版，JWT 鉴权），docx/xlsx/pptx 浏览器编辑保存，带版本快照回滚
- **PDF 查看器**：缩略图/搜索/跳页；「原文 / 提取文本」双视图
- **图片查看器**：缩放旋转拖动
- 文档文本层自动进入检索索引；图片与无文字层的扫描 PDF 不做内置 OCR——外部 Agent 用 `read_raw_file` 读原图自行识别
- 索引、关系图更新与文档解析作为系统维护在后台自动完成，不显示通用任务队列；耗时的文档解析进度只在对应文件旁就地展示

### 📱 多端与部署

- **多端实时同步（同步群组）**：把多台设备组成一个同步群组——选一台做**中枢**（建议常开的 NAS Docker 版，唯一需要可被访问的设备），其他设备用中枢签发的绑定令牌加入。页面、附件图片、原始资料文件与证据账本**秒级双向同步**（含「已提炼」标记：账本随全量对账按来源路径补齐，后加入或离线较久的设备不会停在「A 端已提炼、B 端仍显示未提炼」），字符级三方合并（非重叠编辑自动融合；无法融合的冲突按**修改时间最新者胜**：普通页面中被取代的旧版本以「原名-时间」重命名保留在原目录供人工核对后删除，AI 工作区直接以最新为准覆盖、不产生任何新文件）。每端都是完整本地库：**离线照常工作**，各端 Agent 各连本地 MCP 互不影响，重连自动补同步（设置 → 多端同步；成员端侧栏「知识库」标题行右侧有**一键同步**按钮，点一下立即触发全量对账并直接提示完成/失败）。同步链路带**自愈能力**：远端变更应用失败自动断流重放（水位只前进不越过失败项）、文件拉取失败进待补拉队列周期重试、推送失败指数退避重试、每 15 分钟周期全量对账兜底；设置页「运行状态」内置**同步事件日志**（连接/补拉/重试/对账），排查「同步不动了」不用再猜
- **密文统一掩码**：软件内所有密码、令牌、密钥（登录密码、修改密码、同步绑定令牌、成员令牌、MCP/CLI 令牌、Cloudflare API Token 等）默认中间带星掩码显示，点击眼睛/文本即可查看完整明文，再点恢复掩码
- **NAS Docker**：单容器 + ONLYOFFICE；**Android APP** 内置本地知识库与成员同步（断网可编辑）；**Windows 桌面端**（Electron 内嵌本地后端，托盘驻留、自动更新）
- **IPv6 直连优先 + Cloudflare 隧道兜底**、内置 HTTPS（ACME/DNS-01）、内置 DDNS（Cloudflare API）
- **应用内自更新**：Docker 网页一键升级；桌面端全自动更新；**同步成员端可远程更新中枢**——桌面端绑定多端同步后，设置 → 软件更新直接对所连服务器检查/拉镜像/重建容器（SSE 进度 + 代等恢复 + 失败自动回滚），无需登录服务器网页，同步连接即授权（更新源凭据读写仍仅服务器 owner）
- 设置页 6 大面板：账户与外观、Agent 接入、多端同步（含 DDNS 直连）、软件更新、存储空间、数据管理

### 🎨 界面

- **Windows 11 Fluent 设计语言**：全局控件统一为 Fluent 令牌（4px 控件圆角 / 8px 卡片圆角、白底 + 底缘深描边文本框、聚焦 2px 强调色底线），覆盖登录、侧栏、编辑器、设置七大面板与沉浸阅读视图
- **浅色 / 深色双主题**：阅读视图工具栏可一键切换，主题选择持久记忆
- **侧栏批量折叠 / 拖拽导入**：知识库侧栏一键全部收起/展开（含实体子类，状态记忆）；原始资料分区支持从资源管理器直接拖入文件导入（桌面端与 Docker 网页版一致）
- **Windows 桌面端导入只收 Markdown**：桌面端（Windows）原始资料导入仅接受 `.md` / `.markdown`，文件选择器默认只列 Markdown；拖入其他格式会被拦下并逐个点名提示，同时告诉用户出路——「其他格式请先用外置 Agent 转成 Markdown 再导入」（ZCode / Codex / Claude Code 经 MCP 读写本库）。Docker 网页版、CLI（`engram import`）不受此限，服务端接口本身不限格式；把文件直接拷进仓库的 `原始资料` 目录也会被启动扫描补齐提取

## 下载与安装

三种使用方式，按机器选择：

**Windows 桌面端 · 安装包**（给非开发机器）

1. 从 [Engram Releases](https://github.com/jadesLL/Engram/releases) 下载 `Engram Setup <版本>.exe`
2. 双击安装；数据在 `%APPDATA%\@engram\desktop`，与源码版互通
3. 更新：应用内 设置 → 软件更新 → 「检查更新」，自动下载并静默安装

**Windows 桌面端 · 源码版**（自用开发机，推荐）

1. 从 **[源码版安装器（固定链接，永远最新）](https://github.com/jadesLL/Engram/releases/download/installer-latest/Engram-source-setup.exe)** 下载 `Engram-source-setup.exe`（或取仓库内 `main/scripts/install-engram.ps1` 用 PowerShell 运行），双击后全自动：下载便携 Git/Node/pnpm（免管理员，装在 `%LOCALAPPDATA%\engram`）→ 克隆源码（公开仓库无需凭据）→ 构建桌面端 → 生成桌面快捷方式并启动。该链接固定指向最新引导器、**不绑版本号**——装机逻辑（clone 地址、pnpm 版本等）更新后单独重发布即可，不必等发版（见 [GITEA-CI.md](main/docs/GITEA-CI.md)）
2. 日常双击桌面「Engram」直接启动（Engram 品牌图标，无更新窗口）；更新走应用内 设置 → 软件更新 → 「检查更新」（增量拉源码重建重启），或手动运行 `main/scripts/update-from-source.ps1`——合 main 即更新，无需等发版
3. 更新是全自动的：**依赖清单真变化时应用内会自己装依赖**（`pnpm install`，含 desktop/server 运行时依赖与 better-sqlite3 的 Electron 原生模块），不需要再去终端跑脚本；判断依据是「依赖指纹」（lockfile/workspace 配置 + 各 package.json 的依赖字段），`appId` 之类的元信息改动不会误报。源码模式默认**自动检查更新**（启动后检查一次，之后每 8 小时复查），发现新提交时只弹系统通知 + 设置页提示，更新时机仍由你点「更新并重启」决定，不会自动重启。**例外**：本次更新要换 Electron 运行时时（如 Electron 35 → 36），应用内会交接给 `update-from-source.ps1` 并在退出后打开一个更新控制台窗口完成（同步依赖 → 构建 → 自动启动）——因为运行时不能在应用自己还在跑的时候替换（Windows 删不掉正在使用的 `electron.exe`，pnpm 剪枝只会删一半，留下解析不到应用的残骸）
4. 源码模式怎么确认「更新到了哪一版」：设置 → 账户与外观 → 「应用版本」显示 `版本号 · 提交号 · 提交日期`（工作区有未提交改动时提交号带 `-dirty`），软件更新页右上角同样带提交号，「检查更新」显示本地 → 远端提交号对比。**版本号只在正式发版时变，提交号随每次更新变**，以提交号判断是否已更新到最新代码（与 Docker 镜像、安装包的版本号语义一致）
5. 卸载：应用内 设置 → 软件更新 → 「卸载 Engram」，自动停止应用、删除桌面快捷方式与整个安装目录；知识库数据 `%APPDATA%\@engram\desktop` 默认保留，确认不要可勾选一并删除。也可手动运行 `main/scripts/uninstall-engram.ps1`。全局 pnpm 不受影响

**Docker（服务器 / NAS）**：见下方「快速开始（Docker 部署）」；更新可在 设置 → 软件更新 一键拉镜像重建（需挂载 docker.sock）。镜像构建期会把提交号烤入 `/app/GIT_SHA`（release.yml 自动传，本地构建可 `ENGRAM_GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build`），因此设置 → 应用版本 显示 `版本号 · 提交号`，一眼能看出当前跑的是哪次构建。

Docker 版同样支持**跟主分支不发版更新**：设置 → 软件更新 → 高级选项 → 更新通道选 `main`，之后每次 main 推送 CI 都会重推 `:main` 镜像，点「立即更新」即拿到主分支最新代码（版本号不变，看提交号判断）；发版前的测试就靠这条通道，验证完切回 `latest`。默认通道 `latest` 只跟正式发版。

**Android 本地优先版**：APK 内置同一套 Vue 界面、仅监听 `127.0.0.1` 的本地服务、Markdown 文件库和 SQLite 索引。首次启动可直接建立空库离线使用，之后在 设置 → 多端同步 填中枢地址和成员令牌；冷启动、回到前台、本机修改或手动对账时执行一轮同步，进入后台即取消网络请求并保留待推队列。Android 只作为成员端，不提供 Agent/MCP、ONLYOFFICE 在线编辑、中枢管理、DDNS/TLS 或服务器更新。APK 为按需发版产物，详见 [Android 文档](main/docs/ANDROID.md)。

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

**NAS 部署**（极空间 / 群晖 / 威联通等）用 `main/docker-compose.nas.yml`：宿主端口可调（默认 18080）、JWT 密钥走同目录 `.env`、卷名固定，只需 compose + `.env` 两个文件，无需克隆仓库。完整步骤与坑位见 [`main/docs/BUILDING.md`](./main/docs/BUILDING.md) 的「方式四：NAS 部署」。

Windows 桌面端安装包从 [Engram Releases](https://github.com/jadesLL/Engram/releases) 下载（`Engram Setup <版本>.exe`），更多安装方式见上文「下载与安装」。

> 想从源码自行构建，见 [`main/docs/BUILDING.md`](./main/docs/BUILDING.md)。

## 数据目录

数据都在 `./data`（映射到容器 `/data`）；DB 丢失后可从 brain/ 重建。

**备份/恢复**：设置 → 数据管理 → 「导出备份」一键打包整库（`wiki.db` + `brain/`）为 zip 下载；「从备份恢复」上传备份 zip 并输密码后暂存，重启服务生效（桌面端自动重启，Docker 版重启容器）。旧数据会保留一代（`wiki.db.pre-restore` / `brain.pre-restore`）便于手动回退。桌面端还可在设置里自定义数据保存位置（类 Obsidian 仓库位置，更换时旧数据自动迁移），Docker 版数据位置由 compose 卷挂载决定。

Android 数据位于应用私有目录（`brain/` 为真源，`wiki.db` 为可重建索引）；卸载 APK 会删除未同步、未导出的本机数据。Android 导出可移植 v2 备份（`manifest.json + brain/ + portable-metadata.json`，不含登录会话和同步令牌），也可导入旧版 `wiki.db + brain/` 备份并从文件重建索引。

**本地服务端口**（桌面端）：设置 → 数据管理 → 「本地服务端口」可修改内嵌后端监听端口，默认 18180（与 Docker 版 18080 互不冲突）；改动前自动预检端口占用，应用后内嵌服务以新端口重启，配置存桌面端 `config.json`。Docker 版端口仍由 compose 映射控制。

```
data/
├── brain/              # 权威源：Markdown 页面 + 原始文件
│   ├── 原始资料/        # 上传的资料与对话沉积；文本层提取后可被检索
│   ├── Wiki/           # 知识库页面（概念/实体五子类/查询/归档/关系，目录固定）
│   ├── AIWorks/        # 系统区（log/log.md 操作日志、index/index.md 分类索引、scheme/relationships.md 关系库：词表关系+双链关联+待建页面；服务端自动生成，不参与检索）
│   ├── assets/         # 编辑器粘贴的图片
│   └── .trash/         # 回收站（软删除）
└── wiki.db             # SQLite（FTS 索引/图谱/配置/证据账本）
```

> 目录结构固定：页面只能建在 Wiki 树内，文件只能上传到「原始资料」。

## 让 Agent 开始干活

1. 设置 → Agent 接入 →「接入目标」选「其他 Agent（MCP 接入）」→ 生成 Token；复制对应 Agent 的接入片段（或 CLI `login` 保存连接）
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
- **GitHub Release**：`v*` 标签自动构建，附 Windows 安装包（exe）、Android 安装包（apk）、Docker 镜像包（tar.gz）与 sha256 校验；Release 挂在本仓库 [Releases](https://github.com/jadesLL/Engram/releases)，发版是显式动作，仅按需执行
- **源码模式通道**：自用机器不依赖发版——合 main 后即可通过桌面快捷方式或应用内「检查更新」增量拉源码更新（见「下载与安装」）；Docker 部署可切「更新通道 → main」用镜像形式达到同样效果（合 main 即更新）
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
| [`main/desktop/README.md`](./main/desktop/README.md) | Windows 桌面端（本地内嵌、打包） |
