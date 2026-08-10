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
- 创建、合并和清理以 [`WORKTREES.md`](./WORKTREES.md) 为唯一流程来源，手动管理时也必须满足其中的资源归属和零残留检查。
- 手动生命周期统一使用 `scripts/new-worktree.sh`、`scripts/verify-feature.sh`、`scripts/preview-feature.sh`、`scripts/merge-feature.sh` 和 `scripts/cleanup-feature.sh`；不得复制旧脚本或跳过脚本末尾的残留复验。
- `new-worktree.sh` 只创建分支和代码目录。普通 Web/服务端任务不得在 `main/` 或功能 worktree 中运行 `pnpm install`，也不得为每个 worktree 生成宿主机 `node_modules`；build、typecheck 和 test 统一由 `verify-feature.sh` 在 Docker 中完成。
- 宿主机共享的 pnpm 固定放在主检出目录 `main/node_modules/pnpm`，生命周期脚本通过该副本运行离线回退；功能 worktree 不得另装 pnpm。
- 功能依赖清单未变化时，`preview-feature.sh` 可用共享 pnpm 在仓库外构建产物，并叠加到当前主运行镜像创建隔离预览；依赖变化时必须使用完整 Docker 构建。
- 部署时若 Docker 离线缓存不足，且依赖清单与 Docker 运行阶段相对当前主镜像兼容，`merge-feature.sh --deploy` 可用同样方式生成主镜像；兼容检查不通过时必须停止。
- 只有确实无法在 Linux Docker 中完成的宿主机原生任务（例如 Windows 桌面端打包），才可在说明原因并取得用户同意后建立持久本地依赖环境；自动清理的临时离线验证目录不属于持久环境。
- 功能预览按需使用 `preview-feature.sh` 创建。不要仅为开始编码提前创建容器、端口、镜像或数据卷。
- Docker 构建默认禁用网络并复用本机已有依赖层和构建缓存。只有用户已经明确批准下载环境文件时，才可为对应脚本传入 `--allow-downloads`；缓存缺失时不得自行联网重试。Windows UNC 环境可回退到代码库外的本机临时目录，通过 pnpm `--offline` 复用已有 store，并在验证后删除临时依赖和项目索引。
- 不覆盖、回退或删除其他 Agent 的分支、worktree、容器、数据卷和未提交改动。
- 当前任务额外创建的所有 Docker 容器、镜像、数据卷和网络都必须带 `com.exampleproject.feature=<feature>` 标签；无归属标签的临时资源视为流程违规。
- 功能完成后必须先自行按真实使用路径验收，并截取能够证明结果的界面或终端画面。
- 验收通过后再提交，向用户报告改动、检查结果、截图、worktree、分支和提交信息，并分别询问是否合并到 `main`、是否部署；没有用户对相应动作的明确批准，不得合并或部署，也不清理供用户检查的环境。
- 用户批准合并后，合并只有在主分支检查通过且该功能的 worktree、分支、容器、镜像、数据卷和网络均通过零残留复验后才算完成；清理失败时不得报告“已完成”。
- 合并必须串行。发生冲突且无法确认双方意图时，停止并询问用户。

## 作用边界

- 本文件只约束仓库开发工作，不约束应用内 Dream Cycle、入库管线或通过 MCP 操作知识内容的 Agent。
- 知识内容操作规范见 [`docs/AI-CONTENT-OPERATIONS.md`](./docs/AI-CONTENT-OPERATIONS.md)。
