# 软件开发 Agent 约定

本文件仅适用于修改本仓库源码、配置、测试、构建或部署的软件开发 Agent。

## 开始前必须执行

1. 完整读取根目录 [`WORKTREES.md`](./WORKTREES.md)。
2. 用 `git status` 和 `git worktree list` 确认主分支及现有 worktree 状态。
3. 按 `WORKTREES.md` 判断任务类型，并在对应的独立 worktree 中工作；不得直接在 `main` 开发。

## 唯一流程来源

- worktree 创建、资源隔离、端口分配、串行合并、部署验证、登记和清理均以 `WORKTREES.md` 为唯一来源。
- 本文件不复制具体命令，避免两份规则漂移或相互矛盾。
- 遇到其他 Agent 的改动不得覆盖或回退；合并冲突无法确定意图时，暂停并询问用户。

## 与应用内 AI 的边界

- 本文件不约束 Dream Cycle、入库管线或通过 MCP 读写知识内容的 Agent。
- 知识内容操作规范见 [`docs/AI-CONTENT-OPERATIONS.md`](./docs/AI-CONTENT-OPERATIONS.md)。
- 运行时纪律由服务端代码和 MCP instructions 强制执行，不能依赖开发 Agent 是否读取文档。
