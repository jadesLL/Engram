# Engram Worktree 工作流

## 目录布局

Git 工作目录和工作区根目录均为 `Engram/`（即仓库根，`.git/` 在此，不在 `main/` 内）：

| 路径 | 用途 |
|---|---|
| `main/` | 应用源码；主检出目录中的集成和发布入口 |
| `worktrees/<feature>/` | 功能、修复或文档任务的独立 worktree，源码位于内部 `main/` |
| `releases/<version>/` | 发布快照或构建产物，不纳入 Git |

根级 `.gitignore` 排除 linked worktree 检出内容和整个 `releases/`。禁止把 worktree 建到 `main/` 内部，不要在 `releases/` 中开发。

## 状态来源

不维护容易过期的"活动 worktree"表，实时状态只看命令输出，不得凭文档历史记录判断 worktree、端口或资源可用性：

```bash
git status --short --branch
git worktree list --porcelain
git branch --all
docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'
docker volume ls --format '{{.Name}}'
```

## 选择工作模式

| 任务 | 工作方式 |
|---|---|
| 只读检查、答疑、代码审查 | 直接读取，不创建 worktree |
| Codex 已为当前任务创建 worktree | 使用当前 worktree，不再嵌套创建 |
| 修改源码、配置、依赖、测试或文档 | 在 `worktrees/<feature>/` 创建独立 worktree |
| 整理发布包或固定版本快照 | 完成集成和验证后写入 `releases/<version>/` |

修复 `AGENTS.md`、`WORKTREES.md` 等工作区引导文件时，经用户明确授权可在 `main/` 直接完成；其他开发仍应进入独立 worktree。

## Codex Worktree 模式

优先使用 Codex 桌面端的 Worktree 模式；Codex 创建的 worktree 可能是 detached HEAD，属正常隔离状态。开始修改前仍要执行上面的状态命令确认。需要把成果交给主检出目录集成时，先提交改动，再通过 Codex Handoff 或功能分支传递提交；不要复制粘贴整个目录，也不要在两个 worktree 中同时编辑同一份未提交内容。

## 自动 Worktree 生命周期

生命周期拆成三个独立阶段：①创建代码 worktree（不装依赖、不分配端口、不建 Docker 资源）→ ②修改后在 Docker 中 build/typecheck/test → ③仅需要真实页面或接口验收时才启动隔离预览。脚本从 Git common directory 自动定位仓库根，不依赖固定盘符：

```bash
bash main/scripts/new-worktree.sh example-feature
# 修改 worktrees/example-feature/main/ 中的代码
bash main/scripts/verify-feature.sh example-feature
bash main/scripts/preview-feature.sh example-feature 8081
bash main/scripts/merge-feature.sh [--deploy] example-feature
bash main/scripts/cleanup-feature.sh example-feature
```

Windows PowerShell 必须显式调用 Git Bash（避免命中 WSL 的 `bash.exe`）：`& "C:\Program Files\Git\bin\bash.exe" main/scripts/<script>.sh ...`。

功能名只用小写字母、数字和中划线。各脚本职责：

- `new-worktree.sh`：只创建 `worktrees/<feature>/` 和 `feat/<feature>`，失败时只回滚本次 Git 资源。
- `verify-feature.sh`：用 worktree 代码构建 Docker verify 镜像并在镜像内 build/typecheck/test；不在宿主机 worktree 创建 `node_modules`，不启动服务。
- `preview-feature.sh`：先重新验证当前 worktree，再构建功能运行镜像，按需创建容器、数据卷、网络和端口，并从主数据卷播种隔离测试数据；同一功能可重复运行更新预览。

仅在脚本不可用且用户明确同意人工处理时才手动执行（`git worktree add "worktrees/$feature" -b "feat/$feature" main`），手动创建 Docker 资源仍须遵守下文命名和标签规则。

## 依赖缓存与下载许可

普通 Web/服务端任务禁止在 `main/` 或功能 worktree 中运行 `pnpm install`；每个 worktree 只保存代码。宿主机共享 pnpm 固定在 `main/node_modules/pnpm`（不入 Git），所有生命周期脚本通过它做本机离线回退；共享副本缺失应先恢复，不得静默改用其他全局 pnpm 版本。

依赖清单/锁文件未变化而 Docker 离线缓存不足时，`preview-feature.sh` 会用共享 pnpm 在仓库外临时目录构建，把 dist 叠加到当前主运行镜像创建隔离预览；`merge-feature.sh --deploy` 在兼容性检查通过时用同样方式生成主镜像。依赖有变化或兼容检查不通过时直接失败，不得复用旧依赖。Dockerfile 依赖安装层在源码复制之前，清单未变时多个 worktree 共享不可变依赖层和构建缓存。

三个生命周期脚本默认 `network=none` 且要求本机已有 `node:22-slim`。Docker 依赖层缺失时，Windows UNC 环境回退到代码库外本机临时目录，用 pnpm `--offline` 复用已有 store，验证后删除；Docker 和本地离线缓存都不足时直接失败。只有用户明确批准下载环境文件后，才可为当前命令加 `--allow-downloads`——该许可只对本次动作生效。确实无法在 Docker 完成的宿主机原生任务（如 Windows 桌面端打包），经用户同意后可建持久本地依赖环境。

## 运行资源隔离

只有任务确实需要启动应用时才分配容器、端口和数据卷；纯文档和只读检查不创建 Docker 资源。强制命名：

```text
分支：    feat/<feature>
worktree: worktrees/<feature>
镜像：    engram:<feature>
验证镜像：engram:<feature>-verify
容器：    engram-<feature>
数据卷：  engram-data-<feature>
Compose： engram-<feature>
```

所有功能专属容器、镜像、数据卷和网络（含临时 mock、备份容器、额外数据卷）都必须带标签 `com.engram.scope=feature` + `com.engram.feature=<feature>`；自动清理按精确标签、标准名称和 Compose project 匹配，无标签且非标准命名的资源禁止创建。

`8080` 保留给主环境。功能端口启动前必须实时检查占用（`Get-NetTCPConnection -State Listen -LocalPort <port>` 和 `docker ps` 端口映射），冲突时改用空闲端口并同步更新任务配置，不得停止其他 Agent 或用户的服务。

## 开发完成、自检与用户审核

worktree 中完成修改后：

1. `verify-feature.sh <feature>` 完成 Docker 内 build/typecheck/test。
2. 按真实用户路径自行验收；需要运行应用时 `preview-feature.sh <feature> <port>`。
3. 截取能证明结果的界面或终端画面（截图直接发给用户）。
4. `git status` 确认后只提交当前任务相关文件。
5. 向用户报告 worktree 路径、分支、提交、测试和自检结果、截图及可检查入口。
6. 明确询问是否合并、是否部署，保留 worktree 和预览环境等待答复。

用户要求修改时在同一 worktree 迭代并重新走测试、自检、截图、报告。合并与部署批准分别生效：只有"可以合并""合并到 main"等明确表达才算合并批准；只有"可以部署""合并并部署"才算部署批准。只批准合并时不得部署；只批准部署但尚未合并时先确认集成方式。

## 串行合并

合并前确认：用户已明确批准当前提交；`main/` 工作区干净；没有其他 Agent 正在合并；功能分支已包含最新 `main` 变更或已评估冲突。从仓库根执行：

```bash
bash main/scripts/merge-feature.sh example-feature              # 仅合并
bash main/scripts/merge-feature.sh --deploy example-feature     # 合并并部署
bash main/scripts/merge-feature.sh --allow-downloads ...        # 仅限用户批准本次下载时
bash main/scripts/merge-feature.sh --finish example-feature     # 冲突解决后收尾（需要部署再加 --deploy）
```

脚本通过 Git 锁保证串行；合并后在 Docker verify 阶段重跑 build/typecheck/test（断网缓存不足时用上述本机临时离线环境），任一检查失败保留功能环境并以非零退出。合并冲突时不盲选一侧，理解双方改动并提交后用 `--finish` 收尾。

## 清理

用户批准合并后，清理是合并流程的必需收尾，不需再次申请删除功能预览环境；只有合并、主分支检查和必要部署都成功后才开始，前置失败时保留环境用于修复或回退。

自动清理必须删除该功能拥有的全部资源：`worktrees/<feature>/` 及 Git worktree 注册、已合并的 `feat/<feature>` 分支、`engram-<feature>` 容器及所有带功能标签的容器、`engram:<feature>`/`-verify` 镜像及带标签镜像、`engram-data-<feature>` 及带标签数据卷、`engram-<feature>` Compose 网络、为该 worktree 加入的 Git `safe.directory` 记录。检查或单独收尾旧任务用 `cleanup-feature.sh --inspect <feature>` / `cleanup-feature.sh <feature>`。

脚本删除后会重新查询 Git 和 Docker，任一资源残留即非零退出，任务必须报告"清理失败/尚未完成"，不得汇报"已清理"。

部署成功后合并脚本还会删除未被引用的旧 `engram:main-*`、`engram:pre-*` 和历史提交号镜像标签。以下不属于功能清理范围：当前 `engram` 主容器、主环境数据 bind mount（main/data）和网络、当前主提交镜像、仍被其他容器引用的镜像、`node`/ONLYOFFICE 等共享基础镜像、Docker 共享构建缓存和可复用依赖层。

禁止影响其他项目/worktree/用户数据的宽泛命令：`docker system prune -a --volumes`、`docker container prune`、`docker volume prune`。

## Release 目录

`releases/` 不参与 worktree 管理，仅在用户明确要求发布快照、离线包或版本归档时写入 `releases/<version>/`；内容必须来自已集成验证的提交，并记录提交 ID、构建时间和校验值，不得把未审核的 worktree 直接复制为正式 release。
