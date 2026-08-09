# ExampleProject 开发 Agent 约定

本文件适用于 `ExampleProject/` 仓库中的 `main/` 源码，以及该仓库创建的所有 Git worktree 内的 `main/` 源码。

## 开始前

1. 完整读取 [`WORKTREES.md`](./WORKTREES.md)。
2. 从仓库或 worktree 根目录执行 `git status --short --branch` 和 `git worktree list --porcelain`，确认当前目录、分支和已有 worktree。
3. 先判断当前任务是否已经运行在 Codex 管理的 worktree 中；已经隔离时直接使用当前 worktree，不得再创建嵌套 worktree。

## 工作位置

- `ExampleProject/` 是主检出目录，`main/` 是其中的应用源码和集成入口。除用户明确要求修复协作规则本身外，不直接在主检出目录开发功能。
- 新 worktree 统一放在仓库根目录下的 `worktrees/<feature>/`，其应用源码位于 `worktrees/<feature>/main/`。
- `releases/` 只存放明确要求保留的发布快照或产物，不用于日常开发，也不是 worktree 目录。
- 只读检查、答疑和代码审查不需要创建 worktree。

## 执行原则

- 优先使用 Codex 桌面端提供的 Worktree 模式。当前任务已经位于 worktree 时，沿用当前环境。
- 手动创建、合并和清理时，以 [`WORKTREES.md`](./WORKTREES.md) 为唯一流程来源。
- `scripts/new-worktree.sh` 和 `scripts/merge-feature.sh` 仍包含旧目录硬编码，修复前不得执行。
- 不覆盖、回退或删除其他 Agent 的分支、worktree、容器、数据卷和未提交改动。
- 功能完成后必须先自行按真实使用路径验收，并截取能够证明结果的界面或终端画面。
- 验收通过后再提交，向用户报告改动、检查结果、截图、worktree、分支和提交信息，并分别询问是否合并到 `main`、是否部署；没有用户对相应动作的明确批准，不得合并或部署，也不清理供用户检查的环境。
- 合并必须串行。发生冲突且无法确认双方意图时，停止并询问用户。

## 作用边界

- 本文件只约束仓库开发工作，不约束应用内 Dream Cycle、入库管线或通过 MCP 操作知识内容的 Agent。
- 知识内容操作规范见 [`docs/AI-CONTENT-OPERATIONS.md`](./docs/AI-CONTENT-OPERATIONS.md)。
