# 知识内容操作 AI 约定（外部 Agent 总纲）

本文件适用于通过 MCP 或 CLI 读写 Engram 知识内容的**外部 Agent**（ZCode / Codex / Claude Code / Kimi 等），不适用于修改本仓库源码的开发 Agent。

> 完整作业方法论（八阶段流程、页面模板、证据规则）由服务端统一对外下发，与本文同源：
> MCP `kb_guide` 工具 / `GET /api/guide` / `engram guide`（单一来源：`server/src/content/agentGuide.ts`）。

## 架构边界

Engram **不内置 AI**：存储、文档解析（PDF 文字层 / Office / md）、FTS5 关键词检索、来源版本与证据账本、写入门禁由 Engram 确定性完成；总结、提炼、消歧、综合、问答、图片识别全部由外部 Agent 负责。

## 操作日志

- **位置**：`data/brain/Wiki/log.md`（frontmatter 标题「操作日志」），时间倒序，新条目插在 `# 操作日志` 标题正下方：`- YYYY-MM-DD HH:MM:SS 动作：细节`。
- **写操作自动记录**：Agent 经 `write_page` / `/api/agent/page` / `save_chat` 的写入由**服务端自动追加**日志，Agent 无需重复记录；只有合并、批量重整等复合动作才用 `write_page` 手工补一条动作说明。
- **原始不提炼**：`原始资料/` 下的对话、纪要和文件保持原样，Agent 的产出写到 `Wiki/`；日志条目保持一行式，不蒸馏、不汇总。

## 证据账本与门禁（服务端强制）

- **来源版本**：同一路径以内容哈希形成不可变版本；新版本生效后旧版本的贡献退出当前投影，审计记录保留。
- **页面边界**：实体页固定为「当前理解 → 相关页面 → 时间线」；概念页「概述 → 核心要点 → 实践应用」；用户手写内容永远保留。
- **证据 = 路径 + 逐字引文**：`write_page` 的 `evidence` 每条引文由服务端在来源当前文本中**逐字校验**（规范化空白/标点后匹配），未命中即整体拒绝。
- **两来源门禁**：自动新建概念/实体页需 ≥2 个不同 `原始资料/` 路径各 ≥1 条有效引文，或单一来源 ≥2 条有效引文；同一路径新版本仍只算一个来源；已有页面增量更新不受限。
- **账本可复核**：通过的证据记入 `page_contributions` / `ingest_facts`，编辑器「来源证据」抽屉与 MCP `page_evidence` 工具可逐条查看原文引文与版本时间线。

## 动手前 / 动手后

1. 任何写操作前，先 `read_page` 读取 `Wiki/log.md` 了解最近状态。
2. 按指南（`kb_guide`）完成作业；写入交给 `write_page`，门禁与日志自动兜底。

## 实际执行位置

- 作业指南单一来源：`server/src/content/agentGuide.ts`
- Agent 写入门禁与账本：`server/src/pipeline/agentWrite.ts`
- MCP 端点（streamable HTTP + Bearer）：`server/src/mcp/server.ts`
- CLI：`server/src/cli/`（`engram` bin）
- 操作日志写入：`server/src/pipeline/indexFile.ts`（`appendWikiLog`）
