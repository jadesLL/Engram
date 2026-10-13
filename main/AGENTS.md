# Engram 开发 Agent 约定

适用于 `main/` 源码及所有 worktree 内的 `main/` 源码。worktree 生命周期以 [`WORKTREES.md`](./WORKTREES.md) 为唯一流程来源，本文件只列要点。

## 开始前

1. 完整读取 `WORKTREES.md`。
2. 从仓库/worktree 根执行 `git status --short --branch` 和 `git worktree list --porcelain`，确认当前目录、分支和已有 worktree。
3. 已在 Codex 管理的 worktree 中时沿用当前环境，不得嵌套创建。

## 工作位置

- 主检出目录不直接开发功能（用户明确授权修复协作规则文件除外）；新任务建 `worktrees/<feature>/`，源码在其 `main/` 子目录；`releases/` 只存发布产物；只读检查、答疑、代码审查不需 worktree。
- 生命周期统一使用 `main/scripts/` 下的 `new-worktree.sh`、`verify-feature.sh`、`preview-feature.sh`、`merge-feature.sh`、`cleanup-feature.sh`；不得复制旧脚本或跳过末尾的残留复验。
- build、typecheck、test 统一由 `verify-feature.sh` 在 Docker 中完成；不得在 `main/` 或功能 worktree 中运行 `pnpm install`、生成宿主机 `node_modules`，也不得另装 pnpm（共享副本固定在 `main/node_modules/pnpm`）。
- Docker 构建默认断网 `network=none`、复用本机依赖层和缓存；只有用户明确批准下载时才对当前命令加 `--allow-downloads`，缓存缺失不得自行联网重试。
- 只有确实无法在 Linux Docker 完成的宿主机原生任务（如 Windows 桌面端打包），经说明原因并取得用户同意后才可建立持久本地依赖环境；自动清理的临时离线验证目录不算持久环境。
- 功能预览按需用 `preview-feature.sh` 创建；不要仅为开始编码提前创建容器、端口、镜像或数据卷。
- 当前任务创建的所有 Docker 资源必须带 `com.engram.feature=<feature>` 标签；不覆盖、回退或删除其他 Agent 的分支、worktree、容器、数据卷和未提交改动。

## 验收与合并

- 完成后先按真实使用路径自行验收并截取界面/终端画面（截图必须直接发给用户，不能只给路径）；通过后再提交，向用户报告 worktree、分支、提交信息和检查结果，随后按下一行走自动合并与弹窗提问（提问通道见根 [`AGENTS.md`](../AGENTS.md) 规则 8）。
- **验收通过即自动合并进 main，合并后检查通过即自动清理**（不再请示「是否合并/是否清理」，见根 [`AGENTS.md`](../AGENTS.md) 规则 4/10；合并前确认工作区干净、无其他 Agent 在合并，冲突且双方意图不明时停下问用户）。执行 `main/scripts/merge-feature.sh --cleanup <feature>`，立即删除已合并功能分支、worktree、该任务全部 Docker 容器/镜像/数据卷/网络及 Git `safe.directory` 记录，并复验零残留；不得等用户答复是否推送才清理。清理失败不得报告"已完成"。未合并、未提交或检查失败时保留资源并报告；用户明确要求保留预览时才暂缓。保留主环境、主数据、ONLYOFFICE 数据卷、共享基础镜像与构建缓存及其他任务资源。**推送 gitea、发版和部署仍须明确批准**。
- 合并必须串行；冲突且无法确认双方意图时，停止并询问用户。

## 作用边界

本文件只约束仓库开发工作，不约束应用内 Dream Cycle、入库管线或通过 MCP 操作知识内容的 Agent（规范见 `docs/AI-CONTENT-OPERATIONS.md`）。
