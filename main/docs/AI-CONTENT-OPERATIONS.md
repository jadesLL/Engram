# 知识内容操作 AI 约定（外部 Agent 总纲）

本文件适用于通过 MCP 或 CLI 读写 Engram 知识内容的**外部 Agent**（ZCode / Codex / Claude Code / Kimi 等），不适用于修改本仓库源码的开发 Agent。

> 完整作业方法论（八阶段流程、页面模板、证据规则）由服务端统一对外下发，与本文同源：
> MCP `kb_guide` 工具 / `GET /api/guide` / `engram guide`（单一来源：`server/src/content/agentGuide.ts`）。

## 架构边界

Engram **不内置 AI**：存储、文档解析（PDF 文字层 / Office / md）、FTS5 关键词检索、来源版本与证据账本、写入门禁由 Engram 确定性完成；总结、提炼、消歧、综合、问答、图片识别全部由外部 Agent 负责。

## 接入方式与优先级

- **CLI 优先**：能跑 shell 的 Agent 优先用 `engram` CLI（status / import / files list|read / search / pages list|read|write|delete|evidence / chat save / guide / mcp-config），`--json` 得机器可读输出。
- **MCP 兜底**：CLI 不可用、或需要把图片作为图像内容直读（`read_raw_file` 带 `raw=true`，图片以 image 内容返回）时用 MCP。
- **待提炼清单**：`engram files list --pending`（CLI）或 `list_raw_files` 传 `pending=true`（MCP）列出尚未提炼的原始资料（文件带已提炼标记）。
- **删除只入回收站**：`delete_page`（MCP）与 `engram pages delete`（CLI）只做软删除，把单个页面移入回收站（按标题 / 页面 ID / 页面路径定位；用户可在 设置 → 存储空间 → 回收站 恢复）；仅允许 `Wiki/` 下的页面，`原始资料/` 与 `AIWorks/` 是只读区、拒绝删除，也不提供永久删除或清空回收站能力。

## 提炼作业纪律

- **自动索引**：收到提炼指令后先用上面的待提炼清单命令索引未提炼文件，不需要用户逐个指定。
- **逐份串行**：一次只处理一份——读一份、提炼、`write_page` 提交成功，再处理下一份；不要批量读完统一写页。单份失败记录原因后跳过，不阻塞后续。

## 规则版本与重提炼

- **指南版本**：提炼规则（流程/页面契约/质量红线）以 `agentGuide.ts` 中的 `GUIDE_VERSION` 为准，规则变化时 +1；Agent 每次 `write_page`，服务端把该版本记入 `pages.guide_version`（**只进索引库，不写入页面正文/frontmatter**）。
- **落后页面**：`guide_version` 低于当前指南的页面即规则落后（存量旧页面补列后为 0），清单只含 Agent 维护的 概念/实体 页（原始资料只读不改，归档页不再维护）。用 `engram pages list --outdated`（CLI）或 `list_pages` 传 `outdated=true`（MCP）列出，逐页按最新指南重写后 `write_page` 覆盖即完成升级；已有页面覆盖不受两来源门禁限制，用户手写章节永远保留。

## 操作日志

- **位置**：`data/brain/AIWorks/log/log.md`（frontmatter 标题「操作日志」；历史版本在 `Wiki/log.md`，升级启动时自动迁移），时间倒序，新条目插在 `# 操作日志` 标题正下方：`- YYYY-MM-DD HH:MM:SS 动作：细节`。服务端启动时自动预置该文件，新知识库亦可直接读取。
- **写操作自动记录**：Agent 经 `write_page` / `/api/agent/page` / `save_chat` 的写入由**服务端自动追加**日志，Agent 无需重复记录；只有合并、批量重整等复合动作才用 `write_page` 手工补一条动作说明。
- **原始不提炼**：`原始资料/` 下的对话、纪要和文件保持原样，Agent 的产出写到 `Wiki/`；日志条目保持一行式，不蒸馏、不汇总。

## 证据账本与门禁（服务端强制）

- **来源版本**：同一路径以内容哈希形成不可变版本；新版本生效后旧版本的贡献退出当前投影，审计记录保留。
- **页面边界**：实体页固定为「当前理解 → 相关页面 → 时间线」；概念页「概述 → 核心要点 → 实践应用」；用户手写内容永远保留。
- **证据 = 路径 + 逐字引文**：`write_page` 的 `evidence` 每条引文由服务端在来源当前文本中**逐字校验**（规范化空白/标点后匹配），未命中即整体拒绝。
- **两来源门禁**：自动新建概念/实体页需 ≥2 个不同 `原始资料/` 路径各 ≥1 条有效引文，或单一来源 ≥2 条有效引文；同一路径新版本仍只算一个来源；已有页面增量更新不受限。
- **账本可复核**：通过的证据记入 `page_contributions` / `ingest_facts`，编辑器「来源证据」抽屉与 MCP `page_evidence` 工具可逐条查看原文引文与版本时间线。

## 动手前 / 动手后

1. 任何写操作前，先 `read_page` 读取 `AIWorks/log/log.md` 了解最近状态。
2. 按指南（`kb_guide`）完成作业；写入交给 `write_page`，删除交给 `delete_page`（只入回收站），门禁与日志自动兜底。

## 实际执行位置

- 作业指南单一来源：`server/src/content/agentGuide.ts`
- Agent 写入门禁与账本：`server/src/pipeline/agentWrite.ts`
- Agent 单页删除内核（只入回收站 + Wiki/ 守卫）：`server/src/pipeline/agentDelete.ts`
- MCP 端点（streamable HTTP + Bearer）：`server/src/mcp/server.ts`
- CLI：`server/src/cli/`（`engram` bin）
- 操作日志写入：`server/src/pipeline/indexFile.ts`（`appendWikiLog`）
