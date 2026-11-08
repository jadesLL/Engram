# 知识内容操作 AI 约定（外部 Agent 总纲）

本文件适用于通过 `engram` CLI + skill 读写 Engram 知识内容的**外部 Agent**（Claude Code / Codex / DeepSeek Harness / ZCode / Kimi Code CLI / WorkBuddy / Qoder 等能跑 shell 的客户端），不适用于修改本仓库源码的开发 Agent。服务端不再提供 MCP 端点、不再依赖 MCP SDK、也不再往任何客户端写 MCP 配置；**能跑 shell 是接入前提**（Kimi Work 只有插件入口、没有 shell，已下线）。

> 完整作业方法论（八阶段流程、页面模板、证据规则）由服务端统一对外下发，与本文同源：
> 指南正文 `engram guide` / `GET /api/guide`（单一来源：`server/src/content/agentGuide.ts`）；
> 作业手法与纪律 `engram skill list` / `engram skill show <name>`（单一来源：`server/src/content/skills/`，按需下发）。

## 客户调研

内置与外部 Agent 的客户调研共用 `engram-customer-research` 入口 skill 与服务端 v3 契约。先 `engram research begin --customer <客户> [--scope knowledge-web|knowledge-only] [--save]` 固定任务版本并取回 `identityContract` / `reportContract` / `modeRules` / `existingReports` / `saveMode`，**第一步核验客户主体**（公开工商/官方渠道优先，其次知识库原始资料），再按证据量选报告模式（完整 8 章 / 资料不足简报 3 章 / 主体核验 2 章），最后 `engram research submit --task <taskId> --file report.json`（报告 JSON 含 `identity` / `sections` / `sources` / `save` / `saveMode` / `overwritePath`）校验。`identity` 必填（status=verified/kb-docs/not-found + method + attempts + evidence，verified 还要 fullName），v1 的 `companyFullName` 已被拒绝；公开渠道与知识库都确认不了主体时判 `not-found`，只交核验结论并质疑客户是否存在、名称是否写错，不写客户分析、不落文件；「仅知识库资料」不能声称 `verified`，kb-docs 证据必须是 `原始资料/` 下的原始文档。报告每章有长度上限、来源按工商/官方/媒体/库内分类并逐条登记，禁止方法说明、能力声明与行业泛论。

**入库与记录纪律（v3）**：

- 内置「调研并保存」的**完整报告自动入库**；**资料不足简报只在客户洞察页反馈、不自动入库**（不要声称已保存），用户可在页面手动入库；**主体核验永不入库**。外部 Agent 只有用户明确要求保存时才传 `--save`（显式保存时简报也可入库），其余只出预览。
- **重复客户**：`research begin` 返回知识库里该客户已有的报告 `existingReports`（按报告文件名中的客户名匹配，全名/简称互相包含；删调研记录不影响命中）。用户要求保存且 `existingReports` 非空时，必须**先问用户「生成新版本还是覆盖旧报告」**，再传 `--save-mode new` 或 `--save-mode overwrite --overwrite-path <existingReports[].path>`；不先问会被服务端拒收。覆盖是整篇替换同一份文件（路径与日期不变、不新增文件），只在用户明确选择时执行；覆盖目标在入库前被删除或移入回收站时自动退回新版本。
- **记录清除**：客户洞察页支持一键/按客户/按记录清除调研记录，只把记录置为软删除墓碑（随同步跨端删除），`原始资料/文档/` 里已入库的报告文件不动；进行中（running/queued）的记录拒绝清除，先停止再清；已清除记录不能再提交或入库。

客户报告使用专用模板，通用调研稿的栏目顺序不覆盖它；保存命名、重名规则与旧 ACS 模板升级说明见[客户调研指南](./CUSTOMER-RESEARCH.md)。桌面/Docker 输入客户名即可由内置 Agent 执行；外部客户端一键接入只装 skill + CLI 包装脚本，远程客户端下载 cli.js 后 `engram login` 并复制入口 SKILL.md。

## 架构边界

Engram **内核不内置 AI**：存储、文档解析（PDF 文字层 / Office / md）、FTS5 关键词检索、来源版本与证据账本、写入门禁由 Engram 确定性完成；总结、提炼、消歧、综合、问答、图片识别全部由 Agent 负责——外部 Agent（ZCode / Codex / Claude Code / DeepSeek Harness 等）经 **`engram` CLI + skill** 接入（同一套 Bearer Agent 令牌），或使用 Engram 随包内置的 Agent（设置页填自己的模型 Key 后，左栏 ✨ 聊天抽屉即用；它同样只经 `engram` 命令读写知识库，PATH 里预置 CLI 包装脚本、skill 装在其 skills 目录）。

内置 Agent 还能**按计划无人值守地跑一轮**（设置 → Agent 与自动化 → 自动整理（梦境思考））：到点自动把待提炼的原始资料逐份整理入库，再做一次全库纠错（死链 / 疑似重复 / 规则落后 / 页面契约）。这一轮跑在专用系统会话「梦境思考」里（同一条 runner：工具卡、思考段、用量、停止与事件流都在），一轮只跑一个会话、配置按设备保存。**跑完的成果除了留在对话里，还汇总成设置页的「提炼看板」**：每轮列出提炼了哪几份资料、写入或更新了哪些页面、做了哪些纠错、整理前后的待办计数，收尾小结按 Markdown 渲染（不再压平成一行长文）。服务端在开跑前用确定性口径算好待办信号（`engram files list --pending` / `edges` 的未解析双链 / `guide_version` 落后），随任务文本下发；**这一轮不调用 `engram ask`**（用户不在场），公司全名核验照常登记、等用户下次在对话里答复，其余按证据自定并标注「待核实」。

## 接入方式与优先级

- **Agent 命令入口只有 `engram` CLI**：能跑 shell 的 Agent 一律用它（`--json` 得机器可读输出；`--url` / `--token` / `--allow-private` 可临时连接）。服务端没有 `/mcp` 端点、没有 `mcp__engram__*` 工具，也没有「MCP 兜底」这条路。
- **skill 是给 Agent 的说明书**：设置 → Agent 与自动化 → 外部接入 → 一键接入会给目标客户端装上 `engram` skill（何时用 + 完整命令参考 + 纪律；正文里的调用方式按本机解析出的 CLI 命令替换），**不再改客户端的 MCP 配置**。入口 skill `engram-customer-research` 说明何时做客户调研与 `engram research begin/submit` 用法。
- **本机零配置**：接入时写好 CLI 包装脚本（Windows `%USERPROFILE%\.engram\bin\engram.cmd`，POSIX `~/.engram/bin/engram`，在 PATH 里即可直接敲 `engram`）；服务端启动时已把本机地址与 Agent 令牌登记到 `~/.engram/config.json`（用户手动 `engram login` 的配置优先、不被覆盖）。调用方式：桌面/源码为 `"<node>" "<server>/dist/cli/cli.js"`，Docker 内为 `node /app/server/dist/cli/cli.js`。
- **远程客户端**：从设置页或 `GET /api/agent/cli` 下载单文件 `cli.js`，`node engram.js login --url <url> --token <token>` 一次即可；Agent 令牌在 设置 → Agent 与自动化 → 外部接入 → Agent 令牌 生成/吊销（`Authorization: Bearer`，CLI 与 REST 共用）。
- **图片类内容走临时文件**：`engram pages asset <ref>`（正文 `/media/...` 图片）、`engram files raw <path>`、`engram inbox raw <path> --out F` 默认把图片/二进制落到临时文件并打印路径（`--json` 含 `path` / `mimeType`），Agent 再用自己的图片读取工具打开；不要指望命令直接把图当图像内容返回。
- **内置 Agent 的提问通道 = `engram ask`**：`engram ask --data '{"questions":[...]}'` 由 CLI POST `/api/agent/ask` 并**阻塞长轮询**，问题弹在 Engram 对话最下侧的选项框，用户点选后 CLI 当场返回、同一轮继续（超时或本轮结束时返回未答复原因）。外部 Agent 不要用 `engram ask`，用自己的提问能力问在自己的对话里。
- **待提炼清单**：`engram files list --pending` 列出尚未提炼的原始资料（文件带已提炼标记）。
- **原始资料受限新建**：普通调研成果用 `engram files add <path> --file -`（= 旧 `create_raw_material`），客户报告用 `engram research submit` 新建，只能新建 `原始资料/文档/` 或 `原始资料/灵感碎片/` 下的 Markdown 文件；路径已存在（含回收站占位）即拒绝，`原始资料/对话/` 专供 `engram chat save`。调研成果写 `文档/`，用户随口记的零散内容写 `灵感碎片/`。仅在用户明确要求保存调研结果时调用。Agent 不得更新、改名、删除既有原始资料，也不得走 HTTP/CLI 旁路（**唯一例外**：客户调研在用户明确选择「覆盖旧报告」时，由服务端把同一份报告文件整篇替换——路径与文件名不变、不新增文件；Agent 不能自己用 `files add` 或其它命令模拟覆盖）。`AIWorks/` 只读；`engram pages write|rename|move|delete` 仍只允许 `Wiki/`。
  - 作业时需要的资料不在库里且用户没有要求保存调研结果时：按现有材料推进，把缺口写进页面的「待核实」，**不要停下来等用户**。证据门禁报「来源必须在 `原始资料/` 下」时同理——跳过这条事实（或改用库内来源支撑）并记进「待核实」，不要自己找旁路把文件塞进去。
- **对话沉积须用户指示**：`engram chat save`（= 旧 `save_chat`）只在用户明确说「沉淀」后才可执行；Agent 不得自行判断「这段对话有价值」就沉淀。已沉淀的对话属于原始资料，**可以**被后续提炼作业引用——卡的是「谁决定沉淀」，不是「沉淀后能不能用」。
- **原始资料二级分类（固定三个）**：一级目录是 `原始资料/`，其下固定 **`文档/`**（成文的完整文件：会议纪要、调研报告、复盘、年报、教程、攻略…，新资料默认落这里）、**`对话/`**（`engram chat save` 专用）、**`灵感碎片/`**（随手记：零散条目、想法、待办）。Agent 不要自造其他二级目录；二级分类上线前留在 `原始资料/` 根目录的历史文件按「文档」对待（侧栏「文档」分组会把根目录文件一并列出，磁盘不动）。证据门禁、提炼清单、检索都按 `原始资料/` 前缀判定，二级目录不影响。用户在编辑页的「分类」下拉里换分类会移动文件，服务端同步把按路径存的账本（`source_versions` / `ingest_runs` / `page_revisions`）改挂新路径——所以**你按 `engram files list` 看到的路径始终是当前路径**，「已提炼」标记与证据来源不会因为用户换分类而失效。
- **调研资料与对话分开保存**：用户明确要求保存调研成果时，用 `engram files add` 创建新 Markdown 文件并在正文列出来源；它不覆盖现有文件。`engram chat save` 只保存与 Agent 的聊天记录到 `原始资料/对话/`，两者不能互相替代。
- **内置 skill 下发**：`research-raw-material`（调研范围、引用、成稿格式与保存边界）装在客户端 skills 目录，也可用 `engram skill show research-raw-material` 随时重读；其他作业手法用 `engram skill list` 看清单、`engram skill show <name>` 取全文。skill 版本独立于 `GUIDE_VERSION`，改 skill 不触发全库「规则落后」；skill 仅服务端内置，不开放用户自定义。新增/改名 skill 时同步接入界面（`web/src/components/settings/AgentCliSection.vue`）与本文。
- **删除只入回收站**：`engram pages delete <ref>` 只做软删除，把单个页面移入回收站（按标题 / 页面 ID / 页面路径定位；用户可在 设置 → 知识库数据 → 回收站 恢复）；也不提供永久删除或清空回收站能力。
- **改名/移动不换 ID**：`engram pages rename <ref> --title T` / `engram pages move <ref> --dir …` 保持页面 ID 与图谱边；重命名会把其他页面引用的 `[[旧标题]]` 双链重定向。不要用「新建+删除」模拟改名——那会产生新页面 ID 并让引用悬空。
- **图谱关联可查询**：`engram pages related <ref>` 返回页面的入链/出链邻居与实体关系（与编辑器「相关页面」同一数据），供写「相关页面」章节、验证 `[[双链]]` 目标与排查反向引用。
- **全自动、不打断（拿不准就自己定）**：作业全流程不问用户、不空等。只有用户才知道、资料里又查不到的信息（同名主体区分、客户身份口径等），先自查（`engram search` 全库、读原文比对），仍无定论就按证据取最可信的写法落页，并在正文标注「待核实」与依据（候选、出处、为什么这么取）；**不得编造**。事实冲突、对象身份不清同理：不建页，把冲突与候选记进相关页面的「待核实」，继续处理下一份，不要卡住整批作业。**唯一例外是公司工商全名**，见下一条（内置 Agent 用 `engram ask` 弹窗提问——问题弹在 Engram 对话最下侧，用户点选后命令当场返回，Agent 同一轮继续）。
- **公司全名核验通道（唯一允许问用户的事，问在对话里）**：公司类实体（客户/供应商/渠道商/组织）的名称不是工商全名、资料库里也没有全名时，走两轮问答——**没有单独的核验页面**，问答都发生在对话里：
  1. `engram names check <名称> [--page <ref>] [--note N]`（= 旧 `entity_name_check`）传材料里的写法与关联页面。服务端先自查资料库：**页面标题、证据账本、原始资料提取文本，以及正文里写明全名的提法**都算已有全名，直接返回（用 `engram pages rename` 改用全名即可，不问用户）；正文里带「待核实 / 候选 / 疑似」一类存疑标记的写法只算**疑似候选（未核实）**——那正是此前记下还没确认的写法，服务端把它一并回给 Agent 并照常登记这一问。**问法**：内置 Agent 调 `engram ask`——问题出现在 Engram 对话最下侧的选项弹窗，用户点选后命令当场返回答复；外部 Agent（Claude Code / Codex / ZCode 等）不要用 `engram ask`（它等的是 Engram 界面），用自带的提问能力问在自己的对话里。拿到答复立刻用 `engram names answer <id> --allow|--deny` 回填。同一名称只登记一次。
  2. 用户允许后用 Agent **自带的联网检索**查企查查/天眼查（服务端不抓这两家：登录墙与反爬，且容器常无外网），拿到工商登记全名后 `engram names propose <id> --full-name <全名> --source <出处>` 回填；返回文本会让 Agent 再问一次「是否改用全名」，用户同意后用 `engram names answer <id> --allow` 落地，**由服务端执行改名**（保持页面 ID、双链重定向、自动记日志）。查不到就不传 `--full-name`，按「未找到全名」办结。
  - **全名的界定**：以「企查查/天眼查等能否查到该名称」为准——能查到工商登记信息才是全名，查到的是简称就继续查全称，查不到就不算。服务端的名称形态判断（是否以「有限公司」等结尾）只是提示，不是结论；服务端也会拒绝回填明显不像全名的写法。
  - 用户不在 / 不允许 / 查不到 / 不同意改名：标题保持材料写法，名称口径标注「全称待确认」与候选依据，继续作业——**不追问、不反复请示**（`engram ask` 超时会明确告知用户没答）。收尾必须用 `engram names list --status unresolved` 把**仍未定全名的条目**列给用户（名称、页面、卡在哪、为什么）；需要知道还有哪些公司页没核验过，用 `engram names audit`。
- **客户/公司页契约（指南 v3）**：客户页「当前理解」按 名称口径 / 概览 / 核心机型 / 客户画像 / 核心卡点 / 合作策略 组织（缺证据的章节省略）；公司类实体页（客户/供应商/渠道商）标题用**工商全名**，「当前理解」首节固定为「名称口径」（全称 / 英文名 / 简称别名 / 易混淆的同名公司），内部组织与个人用惯用名。全名来源顺序固定：① 材料里的工商登记信息（调研报告、年报、出货表、合同抬头）；② `engram names check` 让服务端在页面标题 / 证据账本 / 原始资料提取文本里自查（正文里带「待核实/候选」标记的写法只是疑似候选）；③ 都没有才在对话里问用户（上面的核验通道）。**不得编造或推测全名**；走不通时标题暂用材料写法并在名称口径标注「全称待确认」，后续资料出现全名再用 `engram pages rename` 改用全名。本次属页面契约变化，`GUIDE_VERSION` 升 3，只重提炼客户页即可：`engram pages list --outdated --tag 客户`。（名称核验通道本身不改抽取口径，不额外 bump 版本。）

## 命令面（本机已装 `engram` 包装脚本；远程为 `node engram.js`）

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
pages asset <ref> [--out F]               # 正文 /media/... 图片：默认落临时文件并打印路径
files list [--pending] [--dir D]
files read <path> [--out F]               # 提取文本
files raw <path> [--out F]                # 原件字节；图片/二进制默认落临时文件
files add <path> [--file F|-]             # 新建原始资料（正文来自 stdin/文件）
inbox list [--status all|pending|converted|adopted] [--limit N]
inbox read <path> [--out F]
inbox raw <path> --out F
inbox add <path> [--file F|-]
inbox write <path> [--file F|-] [--title T] [--note N]
inbox convert <path>                      # 服务端管道，可能数分钟
chat save [--identifier I] [--project P] [--append] [--file F|-]
names check <名称> [--page R] [--note N]
names propose <id> [--full-name F] [--source S] [--note N]
names list [--status pending|open|unresolved|all]
names audit
names answer <id> --allow|--deny [--note N]
research begin --customer C [--scope knowledge-web|knowledge-only] [--save] [--save-mode new|overwrite] [--overwrite-path P] [--client X] [--timezone TZ]
research submit --task <taskId> [--file F|-]
ask --data '<json>' [--file F|-] [--timeout-ms N]   # 内置 Agent 专用：阻塞等用户点选
```

- 全局：`--json` 机器可读；`--url` / `--token` / `--allow-private` 临时连接。出错时 stderr 打原因、退出码非 0（2=用法/配置错误，1=服务端拒绝/失败）。
- 服务端 REST 面（CLI 背后的契约，也是自写脚本的入口，全部要求 Agent 令牌）：`GET /api/agent/cli`（cli.js 源文件）、`GET /api/agent/info`（连接信息）、`POST /api/agent/ask`、`GET /api/agent/skills`、`GET /api/agent/skills/:name`、`GET /api/agent/pages/tree`、`GET /api/agent/pages/related`、`GET /api/agent/asset`、`GET/POST /api/agent/inbox/*`、`POST /api/agent/raw-material`、`POST /api/agent/research/begin|submit` 等。

## 提炼作业纪律

- **自动索引**：收到提炼指令后先用上面的待提炼清单命令索引未提炼文件，不需要用户逐个指定。
- **逐份串行**：一次只处理一份——读一份、提炼、`engram pages write` 提交成功，再处理下一份；不要批量读完统一写页。单份失败记录原因后跳过，不阻塞后续。

## 规则版本与重提炼

- **指南版本**：提炼规则（流程/页面契约/质量红线）以 `agentGuide.ts` 中的 `GUIDE_VERSION` 为准，规则变化时 +1；Agent 每次 `engram pages write`，服务端把该版本记入 `pages.guide_version`（**只进索引库，不写入页面正文/frontmatter**）。仅类型词表一类「存量页面无需重写、也不改变抽取口径」的机制性调整不加版本（避免把全库页面误标为落后）。
- **落后页面**：`guide_version` 低于当前指南的页面即规则落后（存量旧页面补列后为 0），清单只含 Agent 维护的 概念/实体 页（原始资料只读不改，归档页不再维护）。用 `engram pages list --outdated` 列出，逐页按最新指南重写后 `engram pages write` 覆盖即完成升级；已有页面覆盖不受两来源门禁限制，用户手写章节永远保留。

## 操作日志

- **位置**：`data/brain/AIWorks/log/log.md`（frontmatter 标题「操作日志」；历史版本在 `Wiki/log.md`，升级启动时自动迁移），时间倒序，新条目插在 `# 操作日志` 标题正下方：`- YYYY-MM-DD HH:MM:SS 动作：细节`。服务端启动时自动预置该文件，新知识库亦可直接读取。
- **写操作自动记录**：Agent 经 `engram pages write` / `engram pages rename|move|delete` / `engram files add` / `engram chat save`（以及等价的 REST 写入）的写入由**服务端自动追加**日志，Agent 无需重复记录；只有合并、批量重整等复合动作才用 `engram pages write` 手工补一条动作说明。
- **原始不提炼**：`原始资料/` 下的对话、纪要、文件与用户授权保存的调研稿保持原样；提炼后的知识写到 `Wiki/`；日志条目保持一行式，不蒸馏、不汇总。

## 证据账本与门禁（服务端强制）

- **来源版本**：同一路径以内容哈希形成不可变版本；新版本生效后旧版本的贡献退出当前投影，审计记录保留。
- **页面边界**：实体页固定为「当前理解 → 相关页面 → 时间线」；概念页「概述 → 核心要点 → 实践应用」；用户手写内容永远保留。
- **证据 = 路径 + 逐字引文**：`engram pages write` 的 `--evidence "路径::引文"` 每条引文由服务端在来源当前文本中**逐字校验**（规范化空白/标点后匹配），未命中即整体拒绝。
- **两来源门禁**：自动新建概念/实体页需 ≥2 个不同 `原始资料/` 路径各 ≥1 条有效引文，或单一来源 ≥2 条有效引文；同一路径新版本仍只算一个来源；已有页面增量更新不受限。
- **账本可复核**：通过的证据记入 `page_contributions` / `ingest_facts`，编辑器「来源证据」抽屉与 `engram pages evidence` 可逐条查看原文引文与版本时间线。

## 收集箱（未纳入知识库的暂存区）

- **定位**：`收集箱/` 是用户拖进来的待整理文件（任意格式），**不是知识库**——不建 `pages`/`files` 行、不写 FTS、不参与检索、不出现在目录树与原始资料清单里，通用文件接口（预览/取内容/导出）对它一律拒绝（「不支持内置浏览」）。
- **Agent 能做什么**：`engram inbox list` 看清单，`engram inbox read <path>` 读内容（图片落临时文件后自己看），`engram inbox write <path> --file -` 把语义转换结果写回 `收集箱/转换结果/<原名>.md`；用户要求转换时优先 `engram inbox convert <path>`（服务端稳定分块转换：长文档按章节、宽表格按工作表/表格行切分，模型输出被上限截断时自动拆小重试；大文件可能耗时数分钟，HTTP 超时 ≥10 分钟。图片/音视频等 Agent-only 格式会被明确拒绝，由 Agent 自己读原件后写）。`engram inbox add <path> --file -` 按用户明确要求往收集箱**新建一份待整理原件**（文本类，如「把这段内容先放进收集箱」）：只写 `收集箱/`、不写 `转换结果/`、不覆盖已有文件、不建页面、不进检索。作业规范用 `engram skill show inbox-semantic-to-md`。
- **也可由用户交给 Agent 处理**：收集箱行 ⋯ 菜单「让 Agent 总结并转换」调用 `POST /api/inbox/agent-task`，服务端新建「收集箱处理：<文件名>」会话并立刻起一轮（Agent 自己读原件、总结、按需调 `engram inbox convert` 或自写产物），过程留在对话里可继续追问；入口内核在 `server/src/pipeline/inboxAgentTask.ts`。**内置 Agent 的对话里也可以直接附带收集箱文件**：界面把文件清单放进本轮 `inboxFiles` 上下文（用户消息 metadata 同时留一份），任务文本会说明「这是本次任务输入，用收集箱命令读、产物留收集箱、不得当证据」，等价于用户明确要求处理这些文件。
- **Agent 不能做什么**：不得把收集箱内容写进页面、不得作为 `evidence`、不得在回答里当作事实依据。转换产物同样留在收集箱，**不是**知识库内容。
- **产物状态以磁盘为准**：转换产物在 `收集箱/转换结果/` 即为「已转换」——Agent 通道直接写产物（没有转换任务行）或上次任务失败后补写产物，列表都不会再显示「转换失败」；只有任务正在跑时显示「转换中」。
- **三个用户可见状态**：待整理（`pending`）/ 已转换（`converted`）/ 已入库（`adopted`）。已入库同样由磁盘推导：产物副本在 `原始资料/文档/<产物同名>.md`（同名带序号）且 frontmatter `来源` 与这份原件一致即为 `adopted`，接口额外返回 `adoptedPath`；副本被删掉就退回 `converted`，不需要额外状态表。**收集箱界面默认只列待整理与已转换**，已入库的点「已入库」筛选单独看；图标栏角标、首页收集箱卡片与 Agent 摘要说的都是还没入库的数量。`engram inbox list` 的 `--status` 过滤也支持 `adopted`。
- **入库是用户的动作**：用户在收集箱界面点「入库」后，服务端按原件名称把产物复制进 `原始资料/文档/` 并登记为页面（同名加序号）——从这一刻起它才是可检索、可引用、可作证据的来源。旧版 `原始资料/收集箱/` 里的产物启动时迁入 `原始资料/文档/`。
- **同步**：收集箱文件走普通文件通道（含 `.md` 也按文件传字节，绝不在任何一端变成页面）；入库前后的差别只在于是否进 `pages` 表。

## 动手前 / 动手后

1. 任何写操作前，先 `engram pages read AIWorks/log/log.md` 读取操作日志了解最近状态。
2. 按指南（`engram guide`）完成作业；具体作业手法与纪律用 `engram skill list` 看清单、`engram skill show <name>` 取全文；写入交给 `engram pages write`，删除交给 `engram pages delete`（只入回收站），门禁与日志自动兜底。
3. 涉及原始资料的写入/删除、对话沉积，先取得用户同意（见上文「接入方式与优先级」）。

## 实际执行位置

- 作业指南单一来源：`server/src/content/agentGuide.ts`（`engram guide` 与 `GET /api/guide` 同源）
- 内置 skill 单一来源：`server/src/content/skills/`（注册表 `index.ts`；`engram skill list|show` 下发）；给客户端安装的 `engram` / `engram-customer-research` skill 正文在 `server/src/content/agentSkill.ts`
- Agent 命令入口：`server/src/cli/`（`engram` bin；远程单文件 `GET /api/agent/cli` 由 `dist/cli/cli.js` 直出）
- Agent REST 面（CLI 背后的契约）：`server/src/routes/agentTools.ts`（`/api/agent/*`，auth = Agent 令牌）
- 客户端接入与 CLI 包装脚本：`server/src/lib/agentAccess.ts`（各客户端检测与 skill 安装）、`server/src/lib/cliShim.ts`（`~/.engram/bin/engram` 包装脚本与 PATH 注入）、`server/src/routes/settings.ts`（`/api/settings/agent-access`、`agent-tokens`、`agent-cli-source`）；接入界面 `web/src/components/settings/AgentCliSection.vue` + 命令参考 `web/src/lib/cliReference.ts`（新增/改名命令时三处同步：CLI 命令面、`cliReference.ts` 清单、本文）
- Agent 写入门禁与账本：`server/src/pipeline/agentWrite.ts`
- Agent 调研原始资料只新建入口：`server/src/pipeline/rawMaterial.ts`
- 收集箱边界判定与语义转换：`server/src/lib/brainPaths.ts`（唯一判定来源）、`server/src/pipeline/inboxConvert.ts`（转换与入库）、`server/src/pipeline/inboxAdd.ts`（新建待整理原件，不覆盖、不建页面）、`server/src/pipeline/inboxAgentTask.ts`（「让 Agent 处理」建会话起轮）、`server/src/routes/inbox.ts`（界面接口）、`server/src/routes/agentTools.ts`（`/api/agent/inbox/*` CLI 通道）；内置 Agent 对话附件的上下文规整与渲染在 `server/src/assistant/prompts.ts`（`normalizeInboxFiles`），消息 metadata 由 `server/src/assistant/runner.ts` 落库
- Agent 单页删除内核（只入回收站 + Wiki/ 守卫）：`server/src/pipeline/agentDelete.ts`
- 公司全名核验通道内核（资料库自查 + 两轮问答状态机 + 服务端改名）：`server/src/lib/entityNameChecks.ts`（表 `entity_name_checks`；CLI `engram names …`，REST 由 `server/src/routes/agentTools.ts` / `routes/entityNames.ts` 提供；问答在对话里——内置 Agent 用 `engram ask`，答复经 `engram names answer` 回填）
- 内置 Agent 的提问通道（`engram ask` → `POST /api/agent/ask` 挂起等点选 → 对话底部弹窗 → 答复唤醒 CLI 进程）：`server/src/assistant/questions.ts`（表 `assistant_questions`；REST `POST /api/assistant/questions/:id/answer`；界面 `web/src/components/ChatDrawer.vue` 底部弹窗）
- 梦境思考（按计划无人值守跑一轮）：`server/src/assistant/dreamConfig.ts`（配置与排期数学，键 `dream_config` / `dream_state` / `dream_history`）、`dreamAudit.ts`（待办信号：待提炼 / 死链 / 疑似重复 / 规则落后）、`dreamCycle.ts`（专用会话、起轮、结算、30s tick）、`dreamBoard.ts`（提炼看板：轮次 + 工具卡明细 + 前后计数）、`playbooks.ts`（`dream-cycle` 作业手册）、`routes/assistant.ts`（`GET/PUT /api/assistant/dream` + `run` / `stop`）、界面 `web/src/components/settings/DreamSection.vue`（看板排版）+ `web/src/lib/dreamBoard.ts`（看板文案纯函数）
- 原始资料清单唯一实现：`server/src/pipeline/rawFiles.ts`（`engram files list` 与梦境思考的待办统计共用同一份口径）
- 旧 MCP 端点：**已删除**（`server/src/mcp/` 整体移除，不再依赖 `@modelcontextprotocol/sdk`，也不再向任何客户端写 `mcpServers` 配置）
- 操作日志写入：`server/src/pipeline/indexFile.ts`（`appendWikiLog`）
