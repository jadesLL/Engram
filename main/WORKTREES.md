# ExampleProject Worktree 工作流

## 目录布局

Git 工作目录和工作区根目录均为 `ExampleProject/`：

| 路径 | 用途 |
|---|---|
| `.git/` | 仓库元数据；仓库根不再位于 `main/` 内 |
| `main/` | 应用源码；主检出目录中的集成和发布入口 |
| `worktrees/<feature>/` | 功能、修复或文档任务的独立 Git worktree，其源码位于内部 `main/` |
| `releases/<version>/` | 用户明确要求保留的发布快照或构建产物，不纳入 Git |

`worktrees/` 和 `releases/` 与 `main/` 同级。根级 `.gitignore` 排除 linked worktree 的检出内容和整个 `releases/`。禁止把 worktree 建到 `main/` 内部，也不要在 `releases/` 中开发。

## 状态来源

不再在本文维护容易过期的“活动 worktree”表。以下命令才是实时状态来源：

```powershell
git status --short --branch
git worktree list --porcelain
git branch --all
```

需要运行服务时，再检查实际监听端口和 Docker 资源：

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'
docker volume ls --format '{{.Name}}'
```

不得仅凭文档中的历史记录判断 worktree、端口或资源是否可用。

## 选择工作模式

| 任务 | 工作方式 |
|---|---|
| 只读检查、答疑、代码审查 | 直接读取，不创建 worktree |
| Codex 已为当前任务创建 worktree | 使用当前 worktree，不再嵌套创建 |
| 修改源码、配置、依赖、测试或文档 | 在 `worktrees/<feature>/` 创建独立 worktree |
| 整理发布包或固定版本快照 | 完成集成和验证后写入 `releases/<version>/` |

修复 `AGENTS.md`、`WORKTREES.md` 或工作区引导文件时，用户可以明确授权在 `main/` 直接完成引导修复；其他开发仍应进入独立 worktree。

## Codex Worktree 模式

优先使用 Codex 桌面端的 Worktree 模式。Codex 创建的 worktree 可能处于 detached HEAD，这是正常的隔离状态。每个 worktree 会检出完整仓库布局，应用源码仍在该 worktree 的 `main/` 子目录。

开始修改前仍要确认：

```powershell
git status --short --branch
git rev-parse --show-toplevel
git worktree list --porcelain
```

需要把成果交给主检出目录集成时，先确保改动已提交，并通过 Codex 的 Handoff 流程或明确的功能分支传递提交。不要复制粘贴整个目录，也不要在两个 worktree 中同时编辑同一份未提交内容。

## 手动创建 Worktree

以下命令从 `ExampleProject/` 工作区根目录执行。功能名只使用小写字母、数字和中划线。

```powershell
$feature = "example-feature"
$branch = "feat/$feature"
$path = "worktrees/$feature"

git fetch gitea main
git worktree add $path -b $branch main
git worktree list
```

如果目标分支已经存在，先确认它确实属于当前任务，再去掉 `-b`：

```powershell
git worktree add "worktrees/example-feature" "feat/example-feature"
```

创建后，Git 操作在对应的 `worktrees/<feature>/` 根目录完成，应用修改、安装、测试和构建在 `worktrees/<feature>/main/` 中完成。

## 失效脚本

以下脚本仍硬编码旧路径 `//tsclient/D/SoftwareWorkspace/Wiki知识库`，与当前目录布局不兼容：

```text
main/scripts/new-worktree.sh
main/scripts/merge-feature.sh
```

在脚本完成迁移并通过测试前：

- 不得运行这两个脚本；
- 不得根据它们推断 worktree 路径；
- 使用本文中的 Git 命令完成创建、合并和清理；
- Docker 部署按任务实际需要单独执行，不再作为创建 worktree 的副作用。

## 运行资源隔离

只有任务确实需要启动应用时，才分配容器、端口和数据卷。纯文档、只读检查和不需要运行服务的测试不创建 Docker 资源。

建议命名：

```text
分支：    feat/<feature>
worktree: worktrees/<feature>
镜像：    example-wiki:<feature>
容器：    example-wiki-<feature>
数据卷：  example-wiki-data-<feature>
```

`8080` 保留给主环境。功能端口必须在启动前实时检查：

```powershell
$port = 8081
$listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
$dockerMappings = docker ps --format '{{.Names}} {{.Ports}}' |
  Select-String -SimpleMatch ":$port->"
if ($listeners -or $dockerMappings) {
  throw "端口 $port 已被占用，请选择其他端口"
}
```

端口冲突时不得停止其他 Agent 或用户的服务。改用空闲端口，并同步更新当前任务的配置。

## 开发完成与用户审核

在 worktree 中完成修改后：

1. 运行与改动范围匹配的测试、类型检查和构建。
2. 检查 `git status`，只提交当前任务相关文件。
3. 向用户报告 worktree 路径、分支、提交、测试结果和可检查入口。
4. 保留 worktree 和必要的预览环境，等待用户明确批准合并。

用户要求修改时，继续在同一 worktree 迭代并重新报告。只有“可以合并”“合并到 main”等明确表达才算合并批准。

## 串行合并

合并前确认：

- 用户已经明确批准当前提交；
- `main/` 工作区干净；
- 没有其他 Agent 正在合并；
- 功能分支已包含需要的最新 `main` 变更，或已评估冲突。

从 `ExampleProject/` 仓库根目录执行：

```powershell
$feature = "example-feature"
$branch = "feat/$feature"

git switch main
git status --short
git merge --no-ff $branch
```

合并冲突时不要盲选一侧。理解双方改动后解决；无法判断时停止并询问用户。

合并后运行主分支测试。只有任务本身涉及部署且用户批准部署时，才重建或重启主环境。

## 清理

确认合并、测试和必要部署都成功后：

```powershell
$feature = "example-feature"

git worktree remove "worktrees/$feature"
git branch -d "feat/$feature"
git worktree prune
git worktree list
```

仅清理当前功能明确拥有的 Docker 资源。删除镜像前先确认没有容器引用：

```powershell
docker ps -a --filter "ancestor=example-wiki:<feature>" --format '{{.Names}}'
```

禁止使用会影响其他项目或用户数据的宽泛命令，例如：

```text
docker system prune -a --volumes
```

## Release 目录

`releases/` 不参与 Git worktree 管理。只有用户明确要求生成发布快照、离线包或版本归档时才写入：

```text
releases/<version>/
```

发布内容必须来自已经集成并验证的提交，同时记录提交 ID、构建时间和校验值。不得把未审核的功能 worktree 直接复制为正式 release。
