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

## 自动 Worktree 生命周期

以下脚本会从 Git common directory 自动定位当前 `ExampleProject/` 根目录，不依赖固定盘符或旧目录名：

```text
main/scripts/new-worktree.sh
main/scripts/merge-feature.sh
main/scripts/cleanup-feature.sh
```

功能名只使用小写字母、数字和中划线。从 `ExampleProject/` 根目录创建带隔离预览环境的 worktree：

```bash
bash main/scripts/new-worktree.sh example-feature 8081
```

Windows PowerShell 应明确调用 Git Bash，避免命中 WSL 的 `bash.exe`：

```powershell
& "C:\Program Files\Git\bin\bash.exe" main/scripts/new-worktree.sh example-feature 8081
```

脚本会创建 `worktrees/<feature>/`、`feat/<feature>`、功能镜像、容器和数据卷，并在任一步骤失败时回滚已经创建的资源。创建后，Git 操作在对应的 `worktrees/<feature>/` 根目录完成，应用修改、安装、测试和构建在 `worktrees/<feature>/main/` 中完成。

仅在脚本不可用且用户明确同意人工处理时，才手动执行：

```powershell
$feature = "example-feature"
git worktree add "worktrees/$feature" -b "feat/$feature" main
```

手动创建 Docker 资源仍必须遵守下文的命名和标签规则。

## 运行资源隔离

只有任务确实需要启动应用时，才分配容器、端口和数据卷。纯文档、只读检查和不需要运行服务的测试不创建 Docker 资源。

强制命名：

```text
分支：    feat/<feature>
worktree: worktrees/<feature>
镜像：    example-wiki:<feature>
容器：    example-wiki-<feature>
数据卷：  example-wiki-data-<feature>
Compose： exampleproject-<feature>
```

所有功能专属 Docker 容器、镜像、数据卷和网络都必须带以下标签：

```text
com.exampleproject.scope=feature
com.exampleproject.feature=<feature>
```

功能测试临时创建的 mock、备份容器或额外数据卷也必须带同一个 `com.exampleproject.feature` 标签。自动清理会同时匹配精确标签、标准名称和 Compose project；未加标签且不使用标准名称的资源无法安全判断归属，禁止创建。

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

## 开发完成、自检与用户审核

在 worktree 中完成修改后：

1. 运行与改动范围匹配的测试、类型检查和构建。
2. 按真实用户路径自行检查功能是否正确；需要运行应用时使用当前任务的隔离预览环境，不占用或停止其他任务的资源。
3. 截取能够证明检查结果的界面或终端画面；界面功能优先截取实际页面，后端或命令行功能可截取对应输出。
4. 检查 `git status`，只提交当前任务相关文件。
5. 向用户报告 worktree 路径、分支、提交、测试和自检结果、截图及可检查入口。
6. 明确询问用户是否合并到 `main`、是否部署，并保留 worktree 和必要的预览环境等待答复。

用户要求修改时，继续在同一 worktree 迭代并重新执行测试、自检、截图和报告。合并与部署批准分别生效：只有“可以合并”“合并到 main”等明确表达才算合并批准；只有“可以部署”“合并并部署”等明确表达才算部署批准。用户只批准合并时不得部署，只批准部署但当前提交尚未合并时应先确认集成方式。

## 串行合并

合并前确认：

- 用户已经明确批准当前提交；
- `main/` 工作区干净；
- 没有其他 Agent 正在合并；
- 功能分支已包含需要的最新 `main` 变更，或已评估冲突。

从 `ExampleProject/` 仓库根目录执行。只批准合并、不批准部署时：

```bash
bash main/scripts/merge-feature.sh example-feature
```

同时批准合并和部署时：

```bash
bash main/scripts/merge-feature.sh --deploy example-feature
```

Windows PowerShell 同样使用 `C:\Program Files\Git\bin\bash.exe`。脚本通过 Git 锁保证串行，合并后在 `main` 运行 `test`、`typecheck` 和 `build`；任一检查失败都会保留功能环境并以非零状态退出。UNC 工作区会把当前提交导出到本机临时目录，通过 pnpm `--offline` 使用已有本地 store 建立验证环境；验证完成后同时删除临时目录和 pnpm 项目索引。离线缓存或本地原生模块不完整时直接失败，不得自行下载依赖。

合并冲突时不要盲选一侧。理解双方改动并提交后运行：

```bash
bash main/scripts/merge-feature.sh --finish example-feature
```

如果用户也批准了部署，则增加 `--deploy`。没有部署批准时不得传入该参数。

## 清理

用户批准合并后，清理是合并流程的必需收尾动作，不需要再次申请删除功能预览环境。只有合并、主分支检查和必要部署成功后才开始清理；前置步骤失败时保留环境用于修复或回退。

自动清理必须删除当前功能明确拥有的全部资源：

- `worktrees/<feature>/` 及其 Git worktree 注册；
- 已合并的 `feat/<feature>` 分支；
- `example-wiki-<feature>` 和所有带 `com.exampleproject.feature=<feature>` 的容器；
- `example-wiki:<feature>` 和所有带该功能标签的镜像；
- `example-wiki-data-<feature>` 和所有带该功能标签的数据卷；
- `exampleproject-<feature>` Compose project 创建的网络；
- 为该 worktree 加入的 Git `safe.directory` 记录。

检查清理对象或单独收尾已经合并的旧任务：

```bash
bash main/scripts/cleanup-feature.sh --inspect example-feature
bash main/scripts/cleanup-feature.sh example-feature
```

脚本删除后会重新查询 Git 和 Docker。只要 worktree、分支、容器、镜像、数据卷或网络仍有一项残留，就必须非零退出，并将任务报告为“清理失败/尚未完成”，不得打印或汇报“已清理”。

部署成功后，合并脚本还会删除未被任何容器引用的旧 `example-wiki:main-*`、`example-wiki:pre-*` 和历史提交号镜像标签，只保留当前主提交镜像。以下资源不属于功能清理范围：

- 当前 `example-wiki` 主容器、`example-wiki-data` 主数据卷和主环境网络；
- 当前主提交镜像；
- 仍被其他容器引用的镜像；
- `node`、ONLYOFFICE 等共享基础镜像和共享主环境数据。

禁止使用会影响其他项目、其他 worktree 或用户数据的宽泛命令，例如：

```text
docker system prune -a --volumes
docker container prune
docker volume prune
```

## Release 目录

`releases/` 不参与 Git worktree 管理。只有用户明确要求生成发布快照、离线包或版本归档时才写入：

```text
releases/<version>/
```

发布内容必须来自已经集成并验证的提交，同时记录提交 ID、构建时间和校验值。不得把未审核的功能 worktree 直接复制为正式 release。
