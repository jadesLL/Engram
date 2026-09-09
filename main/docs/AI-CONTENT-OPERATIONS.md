# 知识内容操作 AI 约定（外部 Agent 总纲）

本文件适用于通过 MCP 或 CLI 读写 Engram 知识内容的**外部 Agent**（ZCode / Codex / Claude Code / Kimi 等），不适用于修改本仓库源码的开发 Agent。

> 完整作业方法论（八阶段流程、页面模板、证据规则）由服务端统一对外下发，与本文同源：
> 指南正文 MCP `kb_guide` / `GET /api/guide` / `engram guide`（单一来源：`server/src/content/agentGuide.ts`）；
> 作业手法与纪律 MCP `skill_list` / `skill_guide`（单一来源：`server/src/content/skills/`，按需下发）。

## 架构边界

Engram **不内置 AI**：存储、文档解析（PDF 文字层 / Office / md）、FTS5 关键词检索、来源版本与证据账本、写入门禁由 Engram 确定性完成；总结、提炼、消歧、综合、问答、图片识别全部由外部 Agent 负责。

## 接入方式与优先级

- **CLI 优先**：能跑 shell 的 Agent 优先用 `engram` CLI（status / import / files list|read / search / pages list|read|write|rename|move|delete|evidence / chat save / guide / mcp-config），`--json` 得机器可读输出。
- **MCP 兜底**：CLI 不可用、或需要把图片作为图像内容直读（`read_raw_file` 带 `raw=true`，图片以 image 内容返回）时用 MCP。
- **待提炼清单**：`engram files list --pending`（CLI）或 `list_raw_files` 传 `pending=true`（MCP）列出尚未提炼的原始资料（文件带已提炼标记）。
- **只读区服务端强制**：Agent 的写入（`write_page`）与页面操作（`rename_page` / `move_page` / `delete_page` 及对应 CLI 子命令）只允许 `Wiki/` 下的页面，`原始资料/` 与 `AIWorks/` 是只读区，越界一律 403 拒绝。
  - 「只读」约束的是 **Agent 的权限**，不等于文件不可改：软件本身（Web 界面与 REST API）具备上传、新建、删除原始资料的能力，那是**用户的操作**。Agent 需要新增或删除原始资料时，**先问用户并说明原因，得到明确同意再做**，不得走 HTTP/CLI 旁路自行写入。权限不等于授权。
  - 证据门禁报「来源必须在 `原始资料/` 下」时同理：停下来问用户「要沉淀这份资料，需要先导入原始资料，可以吗？」，不要自己找旁路把文件塞进去。
- **对话沉积须用户指示**：`save_chat`（CLI `chat save`）只在用户明确说「沉淀」、或 Agent 先问并得到同意后才可执行；Agent 不得自行判断「这段对话有价值」就沉淀。已沉淀的对话属于原始资料，**可以**被后续提炼作业引用——卡的是「谁决定沉淀」，不是「沉淀后能不能用」。
- **内置 skill 按需下发**：`skill_list`（MCP）列服务端内置的作业 skill 元数据（名称 / 用途 / 何时用 / 版本），`skill_guide` 按名取全文。skill 与《Agent 作业指南》同级、同样由服务端内置经 MCP 下发（Agent 读的是工具返回值，不是安装目录文件）；区别是**按需**——清单只回元数据，需要时才取正文，因此 skill 增多不会一次性灌满上下文。skill 版本独立于 `GUIDE_VERSION`，改 skill 不改抽取口径、**不触发全库「规则落后」**；skill 仅服务端内置，不开放用户自定义。新增 skill 时同步 `web/src/lib/mcpTools.ts`（Agent 接入界面清单）与本文。
- **删除只入回收站**：`delete_page`（MCP）与 `engram pages delete`（CLI）只做软删除，把单个页面移入回收站（按标题 / 页面 ID / 页面路径定位；用户可在 设置 → 存储空间 → 回收站 恢复）；也不提供永久删除或清空回收站能力。
- **改名/移动不换 ID**：`rename_page` / `move_page`（CLI `pages rename|move`）保持页面 ID 与图谱边；重命名会把其他页面引用的 `[[旧标题]]` 双链重定向。不要用「新建+删除」模拟改名——那会产生新页面 ID 并让引用悬空。
- **图谱关联可查询**：`related_pages`（MCP）返回页面的入链/出链邻居与实体关系（与编辑器「相关页面」同一数据），供写「相关页面」章节、验证 `[[双链]]` 目标与排查反向引用。

## 提炼作业纪律

- **自动索引**：收到提炼指令后先用上面的待提炼清单命令索引未提炼文件，不需要用户逐个指定。
- **逐份串行**：一次只处理一份——读一份、提炼、`write_page` 提交成功，再处理下一份；不要批量读完统一写页。单份失败记录原因后跳过，不阻塞后续。

## 规则版本与重提炼

- **指南版本**：提炼规则（流程/页面契约/质量红线）以 `agentGuide.ts` 中的 `GUIDE_VERSION` 为准，规则变化时 +1；Agent 每次 `write_page`，服务端把该版本记入 `pages.guide_version`（**只进索引库，不写入页面正文/frontmatter**）。仅类型词表一类「存量页面无需重写、也不改变抽取口径」的机制性调整不加版本（避免把全库页面误标为落后）。
- **落后页面**：`guide_version` 低于当前指南的页面即规则落后（存量旧页面补列后为 0），清单只含 Agent 维护的 概念/实体 页（原始资料只读不改，归档页不再维护）。用 `engram pages list --outdated`（CLI）或 `list_pages` 传 `outdated=true`（MCP）列出，逐页按最新指南重写后 `write_page` 覆盖即完成升级；已有页面覆盖不受两来源门禁限制，用户手写章节永远保留。

## 操作日志

- **位置**：`data/brain/AIWorks/log/log.md`（frontmatter 标题「操作日志」；历史版本在 `Wiki/log.md`，升级启动时自动迁移），时间倒序，新条目插在 `# 操作日志` 标题正下方：`- YYYY-MM-DD HH:MM:SS 动作：细节`。服务端启动时自动预置该文件，新知识库亦可直接读取。
- **写操作自动记录**：Agent 经 `write_page` / `/api/agent/page` / `rename_page` / `move_page` / `delete_page` / `save_chat` 的写入由**服务端自动追加**日志，Agent 无需重复记录；只有合并、批量重整等复合动作才用 `write_page` 手工补一条动作说明。
- **原始不提炼**：`原始资料/` 下的对话、纪要和文件保持原样，Agent 的产出写到 `Wiki/`；日志条目保持一行式，不蒸馏、不汇总。

## 证据账本与门禁（服务端强制）

- **来源版本**：同一路径以内容哈希形成不可变版本；新版本生效后旧版本的贡献退出当前投影，审计记录保留。
- **页面边界**：实体页固定为「当前理解 → 相关页面 → 时间线」；概念页「概述 → 核心要点 → 实践应用」；用户手写内容永远保留。
- **证据 = 路径 + 逐字引文**：`write_page` 的 `evidence` 每条引文由服务端在来源当前文本中**逐字校验**（规范化空白/标点后匹配），未命中即整体拒绝。
- **两来源门禁**：自动新建概念/实体页需 ≥2 个不同 `原始资料/` 路径各 ≥1 条有效引文，或单一来源 ≥2 条有效引文；同一路径新版本仍只算一个来源；已有页面增量更新不受限。
- **账本可复核**：通过的证据记入 `page_contributions` / `ingest_facts`，编辑器「来源证据」抽屉与 MCP `page_evidence` 工具可逐条查看原文引文与版本时间线。

## 动手前 / 动手后

1. 任何写操作前，先 `read_page` 读取 `AIWorks/log/log.md` 了解最近状态。
2. 按指南（`kb_guide`）完成作业；具体作业手法与纪律用 `skill_list` 看清单、`skill_guide` 取全文；写入交给 `write_page`，删除交给 `delete_page`（只入回收站），门禁与日志自动兜底。
3. 涉及原始资料的写入/删除、对话沉积，先取得用户同意（见上文「接入方式与优先级」）。

## 实际执行位置

- 作业指南单一来源：`server/src/content/agentGuide.ts`
- 内置 skill 单一来源：`server/src/content/skills/`（注册表 `index.ts`）
- Agent 接入界面的工具清单：`web/src/lib/mcpTools.ts`（新增/改名工具时三处同步：`server/src/mcp/server.ts` 注册、`web/src/lib/mcpTools.ts` 界面清单、本文）
- Agent 写入门禁与账本：`server/src/pipeline/agentWrite.ts`
- Agent 单页删除内核（只入回收站 + Wiki/ 守卫）：`server/src/pipeline/agentDelete.ts`
- MCP 端点（streamable HTTP + Bearer）：`server/src/mcp/server.ts`
- CLI：`server/src/cli/`（`engram` bin）
- 操作日志写入：`server/src/pipeline/indexFile.ts`（`appendWikiLog`）
