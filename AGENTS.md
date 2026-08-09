# ExampleProject 工作区入口

Git 工作目录位于当前 `ExampleProject/` 目录，使用以下布局：

- `main/`：主分支中的应用源码和集成入口
- `worktrees/`：独立任务 worktree；实际检出内容不纳入主工作目录版本控制
- `releases/`：发布快照和产物；不纳入 Git

处理 `main/` 或 `worktrees/` 下的任何仓库任务前，必须从仓库根目录完整读取：

1. [`main/AGENTS.md`](./main/AGENTS.md)
2. [`main/WORKTREES.md`](./main/WORKTREES.md)

Git 命令默认从当前 `ExampleProject/` 根目录执行。不要运行仍引用旧 `Wiki知识库` 路径的 worktree 脚本，也不要在 `releases/` 中开发。
