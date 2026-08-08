# Worktree 并行工作流

本仓库用 `git worktree` 让多个 Agent 在**各自独立的物理文件夹 + 独立分支**上并行改代码，
彻底避免"同一时刻在同一文件夹互相覆盖"的问题。

## 当前结构

| 物理文件夹 | 分支 | 用途 |
|---|---|---|
| `Wiki知识库/` (本目录) | `main` | 主干；**正在改的功能**继续在这里干 |
| `Wiki知识库-<feature>/` (按需创建) | `feat/<feature>` | 各并行功能的工作树 |

> 主目录 = `main` = 当前那个 in-progress 功能的工作区。基线提交 `2ada68d` 已把当前状态
> （含该 WIP）快照进去。等该功能改完，在 main 上再提交一次即可，无需迁移。

## 起一个新 worktree（给第 N 个 Agent）

在**本目录**（main）下执行：

```bash
git worktree add "../Wiki知识库-<feature>" -b feat/<feature>
# 例：
git worktree add "../Wiki知识库-search-export" -b feat/search-export
```

新 worktree 拿到的是基线快照的完整源码副本，Agent 在那个文件夹里独立干，互不干扰。

> ⚠️ worktree 目录必须与 main 同级（`../Wiki知识库-xxx`），不要建在仓库内部。

## 各 worktree 之间共享资源隔离（worktree 管不了，必须手动）

多个 worktree 同时跑 `pnpm dev` 会撞共享资源，每个 worktree 各自隔离：

- **数据库**：各 worktree 用独立的 sqlite 文件，别共用 `data/wiki.db`。
  拷一份当本地库：`cp data/wiki.db ../Wiki知识库-<feature>/data/wiki.db`，
  启动时用环境变量指到自己的库（见 `server/src/config.ts` 的数据目录配置）。
- **端口**：各 worktree 用不同端口（server 默认端口见 config），通过 env 覆盖，避免占用冲突。
- **构建产物**：`dist/` 已被 `.gitignore` 忽略，各 worktree 各自构建互不影响。

## 合回 main

功能在 worktree 里完成并自测后，回 main 合并：

```bash
# 在 main 目录
git checkout main
git merge feat/<feature>          # 或 git merge --no-ff 保留分支轨迹
git worktree remove "../Wiki知识库-<feature>"   # 清理工作树
git branch -d feat/<feature>                       # 删分支
```

若两个功能改了**同一文件**（如都动 `server/src/routes/*.ts` 路由表），合并时会冲突——
尽量在分配任务时就按文件/目录切分，减少重叠面；越早合冲突越小。

## 查看所有 worktree

```bash
git worktree list
```

## 不要做的事

- ❌ 不要在仓库内部建 worktree（会自嵌套）。
- ❌ 不要让两个 Agent 在**同一个 worktree 文件夹**里同时改文件——那又回到了原问题。
- ❌ 不要直接在 main 上同时跑多个功能的改动；新功能一律开 worktree。
