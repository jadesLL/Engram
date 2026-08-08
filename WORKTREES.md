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

---

# 完整并行工作流（全程 AI 执行）

仓库自带两个脚本（在 main 上提交，所有 worktree 继承）：
- `scripts/new-worktree.sh <feature> <port>` —— 开一个新并行功能
- `scripts/merge-feature.sh <feature>` —— 合并回 main + 重部署 + 清理

## ⚠️ 唯一铁律：合并必须串行

worktree 只隔离**开发**阶段（每个 Agent 在自己文件夹改代码，互不覆盖）。
但**合并回 main 必须串行**——同一时刻只能有一个 `merge-feature.sh` 在跑。
多个 Agent 不能同时更新 main 的 ref，否则又回到竞态。

→ 3 个功能 A/B/C 并行开发，合并时按 **A → B → C 依次**串行执行合并脚本，
每个合完重部署 main 验证，再合下一个。后合的若与先合的改了同文件，merge 时解决冲突。

## main 必须保持干净

main 是集成分支，不直接在上面开发。每个功能（含"数字角标"）都应有自己的 `feat/` 分支。
若 main 工作区有未提交 WIP，`merge-feature.sh` 会拒绝合并（避免把 live 改动和合并搅在一起）。
→ 把 main 上的 live 开发先 `git commit` 或迁到 feat 分支，再合并。

## 单功能完整生命周期（AI 跑脚本）

**1. 开功能**（在 main 仓库根目录）：
```bash
scripts/new-worktree.sh ai-organize-logs 8081
# 产出: worktree ../Wiki知识库-ai-organize-logs / 分支 feat/ai-organize-logs
#       镜像 example-wiki:ai-organize-logs / 容器 example-wiki-ai-organize-logs / 端口 8081 / 卷 example-wiki-data-ai-organize-logs
```

**2. 开发迭代**（Agent 在 worktree 文件夹里）：
```bash
cd "../Wiki知识库-ai-organize-logs"
# 改代码... git commit 到 feat/ai-organize-logs
docker compose -f docker-compose.worktree.yml build   # 重建本功能镜像
docker compose -f docker-compose.worktree.yml up -d   # 重部署到 8081
curl http://localhost:8081/...                          # 验证
```

**3. 合并回 main + 重部署 + 清理**（串行，在 main 仓库根目录，确认 main 干净）：
```bash
scripts/merge-feature.sh ai-organize-logs
# 自动: merge feat -> main → 重建 example-wiki:0.1.0 → 重部署 main 容器(8080) → 清理功能容器/卷/worktree/分支
```

**4. 冲突时**（脚本会停住提示）：
```bash
cd main 仓库
# 手动解决冲突文件
git add -A && git commit                      # 完成合并
scripts/merge-feature.sh --finish ai-organize-logs   # 继续重部署+清理
```

## AI 冲突解决原则

- 靠**任务切分**把冲突降到最低：分配功能时按文件/目录划分（A 改 `server/src/ai/`、B 改 `web/src/views/`、C 改 `server/src/routes/`），减少重叠面。
- 合并冲突时，集成 Agent 应理解两边意图再取舍；无法判断就**暂停问人**，不要瞎选。
- 分支寿命要短：勤合并，越早合冲突越小。

