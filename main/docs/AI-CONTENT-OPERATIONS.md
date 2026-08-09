# 知识内容操作 AI 约定

本文件适用于应用内 Dream Cycle、入库管线，以及通过 MCP 读写 LLM Wiki 知识内容的外部 Agent。它不适用于修改本仓库源码的软件开发 Agent。

## 操作日志

- **位置**：`data/brain/Wiki/log.md`（frontmatter 标题「操作日志」）。
- **格式**：时间倒序，新条目插在 `# 操作日志` 标题正下方：
  ```
  - YYYY-MM-DD HH:MM:SS 动作：细节
  ```
- **原则**：条目保持原始一行式，不蒸馏、不汇总成状态看板。
- **资料入库**：`原始资料/` 下的对话、纪要和文件走正常入库管线，不创建绕过提炼的笔记类型。

## 动手前 / 动手后

1. 对知识内容执行任何写操作前，先读取 `Wiki/log.md`，了解最近状态。
2. 操作完成后，将本次动作原样追加到 `Wiki/log.md`。
   - 应用内 AI 通过 `appendWikiLog(action, detail)` 自动写入。
   - MCP Agent 使用 `write_page`，把新条目插在标题正下方。

## 应用内自动写入点

| 触发 | 动作 |
|---|---|
| 新建页面 | `新建页面` |
| 归档 / 取消归档 | `归档` / `取消归档` |
| 删除页面或资料 | `删除` |
| 合并页面 | `合并`（原页已归档） |
| 回收站恢复 / 永久删除 / 清空 | `恢复` / `永久删除` / `清空回收站` |
| 死链批量建页 | `新建页面` |
| Dream Cycle 运行 | `Dream Cycle`（各分类计数完整保留） |
| 实体升级批次 | `实体升级`（所有实体完整列出） |
| 批量处理失败 | `批量处理失败`（所有错误完整保留） |
| 一键清除 | `清除`（重置操作日志） |

Dream Cycle 默认由 `server/src/dream/scheduler.ts` 定时触发，也可通过 `POST /api/dream/run` 手动运行。整理结果落入 `reports` 表，操作日志只记录运行摘要。

## 实际执行位置

- 操作日志写入：`server/src/pipeline/indexFile.ts`
- MCP 下发纪律：`server/src/mcp/server.ts`
- Dream Cycle 摘要：`server/src/dream/tasks.ts`
- 页面、文件、回收站和设置路由中的用户操作由相应服务端路由调用 `appendWikiLog`

`POST /api/settings/wipe-ai-logs` 会清理历史 `AIWorks/log/` 残留并重置 `Wiki/log.md`。正常使用下不再创建独立 AI 日志文件。
