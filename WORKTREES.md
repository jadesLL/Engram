# Worktree 并行工作流

本仓库用 `git worktree` 让多个 Agent 在**各自独立的物理文件夹 + 独立分支**上并行改代码，
彻底避免"同一时刻在同一文件夹互相覆盖"的问题。

## 当前结构

| 物理文件夹 | 分支 | 用途 |
|---|---|---|
| `Wiki知识库/` (本目录) | `main` | 集成与部署主干；禁止直接开发 |
| `Wiki知识库-<feature>/` (按需创建) | `feat/<feature>` | 各并行功能的工作树 |

> `main` 只接收串行合并并用于主站部署。所有功能、修复和应用代码调整都必须进入独立 worktree。

## 任务类型与资源范围

| 任务类型 | Worktree | 独立容器 / 端口 / 数据卷 | 合并后重部署主站 |
|---|---|---|---|
| 只读检查、答疑、代码审查 | 不需要 | 不需要 | 不需要 |
| 仅维护 `AGENTS.md`、`WORKTREES.md` 或纯说明文档 | 需要文档 worktree | 不需要 | 不需要 |
| 修改源码、运行时配置、依赖、测试或构建产物 | 需要功能 worktree | 需要（按任务实际运行范围隔离） | 需要 |

> 纯文档任务仍需提交分支、串行合并、更新活动表并清理 worktree；但不得为此无意义地创建 Docker 资源或重部署应用。

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

---

# 当前活动 worktree（实时登记）

每个 Agent 进来先看这里，确认自己在哪个文件夹、用哪个端口。改完合并后记得更新本表。

| 功能 | 文件夹 | 分支 | 容器 | 端口 | 卷 | 状态 |
|---|---|---|---|---|---|---|
| 集成分支(主干) | `Wiki知识库/` | `main` | `example-wiki` | 8080 | `example-wiki-data` | 干净，禁止直接开发 |
| 数字角标 | `Wiki知识库-number-badge/` | `feat/number-badge` | `example-wiki-number-badge` | 8082 | `example-wiki-data-number-badge` | 开发中 |
| Agent 指引分流 | ~~`Wiki知识库-agent-guidance-scope/`~~ | ~~`feat/agent-guidance-scope`~~ | ~~`example-wiki-agent-guidance-scope`~~ | ~~8086~~ | ~~`example-wiki-data-agent-guidance-scope`~~ | 已合并入 main |
| 协作规则分流 | ~~`Wiki知识库-worktree-policy/`~~ | ~~`feat/worktree-policy`~~ | — | — | — | 已合并入 main |
| 回收站 | ~~`Wiki知识库-recycle-bin/`~~ | ~~`feat/recycle-bin`~~ | ~~`example-wiki-recycle-bin`~~ | ~~8089~~ | ~~`example-wiki-data-recycle-bin`~~ | 已合并入 main |
| 模型目录卡片 | ~~`Wiki知识库-model-catalog/`~~ | ~~`feat/model-catalog`~~ | ~~`example-wiki-model-catalog`~~ | ~~8087~~ | ~~`example-wiki-data-model-catalog`~~ | 已合并入 main |
| AI整理日志 | ~~`Wiki知识库-ai-organize-logs/`~~ | ~~`feat/ai-organize-logs`~~ | ~~`example-wiki-ai-logs`~~ | ~~8081~~ | ~~`example-wiki-data-ai-logs`~~ | 已合并入 main |
| 知识图谱优化 | ~~`Wiki知识库-graph-opt/`~~ | ~~`feat/graph-opt`~~ | ~~`example-wiki-graph-opt`~~ | ~~8083~~ | ~~`example-wiki-data-graph-opt`~~ | 已合并入 main |
| 图谱拖动修复 | ~~`Wiki知识库-graph-drag/`~~ | ~~`feat/graph-drag`~~ | ~~`example-wiki-graph-drag`~~ | ~~8086~~ | ~~`example-wiki-data-graph-drag`~~ | 已合并入 main |
| 实时页面刷新 | ~~`Wiki知识库-realtime-sync/`~~ | ~~`feat/realtime-sync`~~ | ~~`example-wiki-realtime-sync`~~ | ~~8083~~ | ~~`example-wiki-data-realtime-sync`~~ | 已合并入 main |

> 端口顺延规则：main=8080，第 N 个功能用 808N。

## Agent 入场须知（每个 Agent 必读）

1. **先确认你在哪个文件夹**：你的功能对应上表某一行，只在该行文件夹里干活。
   - 数字角标 → `Wiki知识库-number-badge/`
   - AI整理日志 → `Wiki知识库-ai-organize-logs/`
2. **绝不碰 `Wiki知识库/`（main 主干）**：那是集成分支，只用来合并，不直接写代码。
   在上面写代码会卡住后续合并（`merge-feature.sh` 会因 main 不干净而拒绝）。
3. **开发循环**（在你的 worktree 文件夹里）：
   ```bash
   cd "<你的 worktree 文件夹>"
   # 改代码... 提交到你的 feat/ 分支
   git add -A && git commit -m "..."
   docker compose -f docker-compose.worktree.yml build   # 重建你的镜像
   docker compose -f docker-compose.worktree.yml up -d   # 重部署到你的端口
   curl http://localhost:<你的端口>/...                    # 验证
   ```
4. **完成合并**（回 main 仓库根目录，确认此刻没有别的 merge 在跑）：
   ```bash
   scripts/merge-feature.sh <你的功能名>     # 自动: merge→main → 重部署8080 → 清理你的资源
   ```
   - 冲突 → 脚本会停住：在 main 仓库解决冲突 → `git add -A && git commit` → `scripts/merge-feature.sh --finish <功能名>`。
5. **合并完更新本表**：把你的行标成"已合并"，或删掉该行。

## 串行合并排班

多个功能同时完成时，**按顺序逐个**跑 `merge-feature.sh`，一个合完重部署 8080 验证后再合下一个。
不要两个 Agent 同时跑 merge。建议顺序：越早完成的越先合（分支寿命短 = 冲突小）。
