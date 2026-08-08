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

## 开始前：先调研和计划（硬门禁）

任何写文件、创建 worktree、启动服务或创建 Docker 资源之前，必须先完成只读调研并形成计划。

**调研阶段只允许读取和检查：**

1. 完整读取本文件，并执行 `git status`、`git worktree list`。
2. 查看“当前活动 worktree”表、主机监听端口和 Docker 端口映射。
3. 阅读任务涉及的源码、脚本、配置和测试，确认改动范围及验证方式。
4. 此阶段不得修改文件、创建分支/worktree、启动服务或占用端口。

**计划必须明确写出：**

- 任务类型，以及是否需要功能 worktree、独立容器、端口和数据卷。
- 功能名、worktree 文件夹、分支、预计修改范围。
- **本任务使用的主机端口**及选择依据；纯文档/只读任务也要写端口字段，值为“`不适用（不启动服务）`”，不得为了填写端口而创建运行资源。
- 从创建 worktree、开发、测试、提交、串行合并、主站验证到资源清理的完整流程。
- 端口初检方法、执行前复验方法，以及端口冲突时重新选端口并更新计划的处理方式。

建议计划格式：

```text
任务类型：
feature / worktree / branch：
计划端口：（纯文档写“不适用”）
容器 / 数据卷：
修改范围：
执行流程：
验证方式：
合并与清理：
```

**端口必须检查两次：**

1. 形成计划时初检：同时核对活动表、主机监听状态和 Docker 映射，选出候选端口。
2. 开始执行计划时复验：在调用 `scripts/new-worktree.sh` 或启动任何服务的**紧前一步**再次检查。只有确认端口未被占用，才允许创建 worktree/容器或开始开发。

如果复验时端口已占用，立即停止，不得抢占或停止其他 Agent 的服务；重新选择端口、更新计划和活动表，并再次复验。`scripts/new-worktree.sh` 也会在任何创建动作前执行端口复验，失败时不应留下 worktree、分支、容器或数据卷。

Windows / PowerShell 初检和复验使用同一组命令，只有输出 `FREE` 才算通过：

```powershell
$port = 8081
$listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
$dockerMappings = docker ps --format '{{.Names}} {{.Ports}}' |
  Select-String -SimpleMatch ":$port->"
if ($listeners -or $dockerMappings) {
  throw "端口 $port 已被占用，停止执行并重新选择端口"
}
"FREE"
```

## 起一个新 worktree（给第 N 个 Agent）

源码、运行时配置、依赖、测试或构建任务，在完成计划和端口复验后，从**本目录**（main）执行：

```bash
scripts/new-worktree.sh <feature> <已复验端口>
```

从 PowerShell 调用时应明确使用 Git for Windows 的 Bash，避免系统 `bash.exe` 指向未配置的 WSL：

```powershell
& 'C:\Program Files\Git\bin\bash.exe' scripts/new-worktree.sh <feature> <已复验端口>
```

纯文档任务不创建运行资源，在完成计划后手动创建文档 worktree：

```bash
git worktree add "../Wiki知识库-<feature>" -b feat/<feature>
```

新 worktree 拿到的是基线快照的完整源码副本，Agent 在那个文件夹里独立工作，互不干扰。

> ⚠️ worktree 目录必须与 main 同级（`../Wiki知识库-xxx`），不要建在仓库内部。

## 各 worktree 之间共享资源隔离（worktree 管不了，必须手动）

多个 worktree 同时跑 `pnpm dev` 会撞共享资源，每个 worktree 各自隔离：

- **数据库**：各 worktree 用独立的 sqlite 文件，别共用 `data/wiki.db`。
  拷一份当本地库：`cp data/wiki.db ../Wiki知识库-<feature>/data/wiki.db`，
  启动时用环境变量指到自己的库（见 `server/src/config.ts` 的数据目录配置）。
- **端口**：各 worktree 用不同端口（server 默认端口见 config），通过 env 覆盖。活动表只是协调记录，不能代替主机监听和 Docker 映射检查；计划时初检，执行前必须复验。
- **构建产物**：`dist/` 已被 `.gitignore` 忽略，各 worktree 各自构建互不影响。

## Docker 资源清理规则（合并完成的硬门禁）

worktree 合并完成后，清理对象不只有容器、数据卷、目录和分支，还必须处理该功能的**带标签镜像**。功能资源的完整集合是：

- 容器：`example-wiki-<feature>`
- 数据卷：`example-wiki-data-<feature>`
- 镜像：`example-wiki:<feature>`
- Git worktree：`../Wiki知识库-<feature>`
- Git 分支：`feat/<feature>`

`docker image prune` 只会清理悬空镜像，**不会删除仍带 `example-wiki:<feature>` 标签的历史功能镜像**。因此合并并确认主站正常后，必须显式删除功能镜像：

```bash
docker image rm "example-wiki:<feature>"
```

删除前必须确认没有任何容器仍引用该镜像：

```bash
docker ps -a --filter "ancestor=example-wiki:<feature>" --format '{{.Names}}'
```

有输出时不得删除镜像；先判断该容器是否属于本功能且已经完成合并，再按正常清理流程停止并删除。不得处理其他 Agent、其他仓库或用户仍在使用的容器和镜像。

**默认保留：**

- 主站镜像 `example-wiki:0.1.0`
- 构建基础镜像 `node:22-slim`（可能同时显示镜像源别名）
- 主数据卷 `example-wiki-data`
- 明确命名的备份卷，如 `example-wiki-data-backup-*`

**禁止使用宽泛清理命令：**

```text
docker system prune -a --volumes
```

该命令可能删除其他项目、其他 Agent 或用户需要的镜像、网络和数据卷。必须按明确的功能名逐项清理，并在执行前校验目标名称。

### 构建缓存与镜像分开处理

BuildKit 构建缓存不是功能镜像。使用以下命令分别检查：

```bash
docker system df
docker buildx du
```

- 默认保留构建缓存，以加速后续 Docker 构建。
- 磁盘空间紧张时，先报告缓存总量和可回收量，再由用户确认是否清理。
- 获得确认后使用 `docker builder prune` 或 `docker buildx prune` 清理可回收缓存；不要附带 `--volumes`。
- 删除功能镜像后仍显示较大构建缓存是正常现象，不能把它误判成 worktree 镜像残留。

### 合并后的最终核验

每个功能合并后必须同时检查 Git、目录、容器、卷和镜像五层：

```bash
git worktree list
git branch --list 'feat/*'
docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}'
docker volume ls --format '{{.Name}}'
docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}'
```

功能真正清理完成的标准：

1. `git worktree list` 不再出现该功能目录。
2. 不再存在 `feat/<feature>` 分支。
3. 不再存在 `example-wiki-<feature>` 容器。
4. 不再存在 `example-wiki-data-<feature>` 数据卷。
5. 不再存在 `example-wiki:<feature>` 镜像。
6. 主站 `http://localhost:8080/` 返回成功，`example-wiki:0.1.0` 仍被主容器使用。
7. `WORKTREES.md` 活动表和操作日志已更新。

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

**0. 调研和计划**（只读，不创建任何资源）：

```text
任务类型：源码修改
feature / worktree / branch：ai-organize-logs / Wiki知识库-ai-organize-logs / feat/ai-organize-logs
计划端口：8081（活动表、主机监听、Docker 映射初检均空闲）
容器 / 数据卷：example-wiki-ai-organize-logs / example-wiki-data-ai-organize-logs
执行流程：复验端口 → 创建 worktree → 开发测试 → 提交 → 串行合并 → 验证 8080 → 清理
```

**1. 执行前复验 + 开功能**（在 main 仓库根目录）：

紧接脚本执行前再次核对 `8081`；若已占用，停止并更新计划，不得继续。脚本自身还会做最后一道端口复验。

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
# 随后必须确认并删除功能镜像 example-wiki:ai-organize-logs，再执行五层最终核验
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
| 数字角标 | ~~`Wiki知识库-number-badge/`~~ | ~~`feat/number-badge`~~ | ~~`example-wiki-number-badge`~~ | ~~8082~~ | ~~`example-wiki-data-number-badge`~~ | 已合并入 main |
| 首页按钮 | ~~`Wiki知识库-home-button/`~~ | ~~`feat/home-button`~~ | ~~`example-wiki-home-button`~~ | ~~8085~~ | ~~`example-wiki-data-home-button`~~ | 已合并入 main |
| Docker 镜像清理规则 | ~~`Wiki知识库-worktree-image-cleanup-docs/`~~ | ~~`feat/worktree-image-cleanup-docs`~~ | — | — | — | 已合并入 main |
| Agent 指引分流 | ~~`Wiki知识库-agent-guidance-scope/`~~ | ~~`feat/agent-guidance-scope`~~ | ~~`example-wiki-agent-guidance-scope`~~ | ~~8086~~ | ~~`example-wiki-data-agent-guidance-scope`~~ | 已合并入 main |
| 协作规则分流 | ~~`Wiki知识库-worktree-policy/`~~ | ~~`feat/worktree-policy`~~ | — | — | — | 已合并入 main |
| 模糊实体消歧 | ~~`Wiki知识库-ambiguous-entity/`~~ | ~~`feat/ambiguous-entity`~~ | ~~`example-wiki-ambiguous-entity`~~ | ~~8084~~ | ~~`example-wiki-data-ambiguous-entity`~~ | 已合并入 main |
| 回收站 | ~~`Wiki知识库-recycle-bin/`~~ | ~~`feat/recycle-bin`~~ | ~~`example-wiki-recycle-bin`~~ | ~~8089~~ | ~~`example-wiki-data-recycle-bin`~~ | 已合并入 main |
| 模型目录卡片 | ~~`Wiki知识库-model-catalog/`~~ | ~~`feat/model-catalog`~~ | ~~`example-wiki-model-catalog`~~ | ~~8087~~ | ~~`example-wiki-data-model-catalog`~~ | 已合并入 main |
| AI整理日志 | ~~`Wiki知识库-ai-organize-logs/`~~ | ~~`feat/ai-organize-logs`~~ | ~~`example-wiki-ai-logs`~~ | ~~8081~~ | ~~`example-wiki-data-ai-logs`~~ | 已合并入 main |
| 知识图谱优化 | ~~`Wiki知识库-graph-opt/`~~ | ~~`feat/graph-opt`~~ | ~~`example-wiki-graph-opt`~~ | ~~8083~~ | ~~`example-wiki-data-graph-opt`~~ | 已合并入 main |
| 图谱拖动修复 | ~~`Wiki知识库-graph-drag/`~~ | ~~`feat/graph-drag`~~ | ~~`example-wiki-graph-drag`~~ | ~~8086~~ | ~~`example-wiki-data-graph-drag`~~ | 已合并入 main |
| 实时页面刷新 | ~~`Wiki知识库-realtime-sync/`~~ | ~~`feat/realtime-sync`~~ | ~~`example-wiki-realtime-sync`~~ | ~~8083~~ | ~~`example-wiki-data-realtime-sync`~~ | 已合并入 main |
| Office 在线编辑 | ~~`Wiki知识库-office-online-editing/`~~ | ~~`feat/office-online-editing`~~ | ~~`example-wiki-office-online-editing` + `example-wiki-office-online-editing-onlyoffice`~~ | ~~8086~~ | ~~`example-wiki-data-office-online-editing` + Office 专属卷~~ | 已合并入 main |

> `8080` 永久保留给 main。功能端口可从 `8081` 起顺延，但顺延值只代表候选端口；必须经过计划初检和执行前复验，不能仅凭编号或活动表判断空闲。

## Agent 入场须知（每个 Agent 必读）

1. **先调研并形成计划**：先只读检查仓库、活动 worktree 和端口；计划中写明 worktree、分支、端口、修改范围、验证、串行合并及清理流程。
2. **开始执行前复验端口**：在创建 worktree/容器或启动服务的紧前一步复验。端口被占用就停止、改计划并换端口；不得处理其他 Agent 的资源。
3. **确认你在哪个文件夹**：你的功能对应上表某一行，只在该行文件夹里工作。当前没有活动功能 worktree；新建后先登记再开发。
4. **绝不碰 `Wiki知识库/`（main 主干）**：那是集成分支，只用来合并，不直接写代码。
   在上面写代码会卡住后续合并（`merge-feature.sh` 会因 main 不干净而拒绝）。
5. **开发循环**（在你的 worktree 文件夹里）：
   ```bash
   cd "<你的 worktree 文件夹>"
   # 改代码... 提交到你的 feat/ 分支
   git add -A && git commit -m "..."
   docker compose -f docker-compose.worktree.yml build   # 重建你的镜像
   docker compose -f docker-compose.worktree.yml up -d   # 重部署到你的端口
   curl http://localhost:<你的端口>/...                    # 验证
   ```
6. **完成合并**（回 main 仓库根目录，确认此刻没有别的 merge 在跑）：
   ```bash
   scripts/merge-feature.sh <你的功能名>     # 自动: merge→main → 重部署8080 → 清理你的资源
   ```
   - 冲突 → 脚本会停住：在 main 仓库解决冲突 → `git add -A && git commit` → `scripts/merge-feature.sh --finish <功能名>`。
7. **删除功能镜像**：确认没有容器引用后，执行 `docker image rm "example-wiki:<功能名>"`。不要删除 `example-wiki:0.1.0`、`node:22-slim`、主数据卷或备份卷。
8. **执行五层最终核验**：检查 worktree、分支、容器、数据卷和镜像均无该功能残留；构建缓存单独报告，默认保留。
9. **合并完更新本表和操作日志**：把你的行标成"已合并"，或删掉该行，并记录完整清理结果。

## 串行合并排班

多个功能同时完成时，**按顺序逐个**跑 `merge-feature.sh`，一个合完重部署 8080 验证后再合下一个。
不要两个 Agent 同时跑 merge。建议顺序：越早完成的越先合（分支寿命短 = 冲突小）。
