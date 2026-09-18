# 公开镜像：脱敏后推送到 GitHub

把私有 Gitea 仓库的历史**脱敏**后，作为一个独立快照推送到公开仓库（GitHub）。

**源仓库一行不改**：不重写历史、不 force push、不动 CI / 部署 / 安装器 / 其他 worktree。脱敏只发生在临时克隆里。

## 为什么不能直接用 Gitea 的推送镜像

Gitea 自带的 Push Mirror 推的是 `refs/heads/*` + 标签的**原样对象**——仓库里有什么，对方就看到什么。历史里存在这些内容，所以推送镜像会把它们一起公开：

| 类别 | 例子 |
|---|---|
| 凭据 | 历史 compose 里的 `DEFAULT_PASSWORD` 明文、ONLYOFFICE JWT 默认密钥 |
| 身份 | 894 个提交的作者邮箱（手机号邮箱）、作者名、Windows 用户名 |
| 基础设施 | 私有 Gitea 域名与端口、家庭 NAS 的公网 IPv6 直连域名、内网 IP |
| 其他私有项目 | 私有 Registry 里其他仓库的路径与 Android 包名 |

所以改用本 workflow：先在临时克隆里把这些全部替换掉，**逐条规则反查确认零残留**，再推送。

## 工作方式

```
Gitea 仓库（私有，原样不动）
        │  push main / v* 标签 触发
        ▼
Public Mirror workflow（Windows runner）
        │  1. 克隆到临时裸仓库（mktemp）
        │  2. git-filter-repo 重写：文件内容 + 提交/标签信息 + 作者身份 + 路径名
        │  3. 逐条规则反查全历史，任一残留即失败
        │  4. 只推 main + 标签（force）
        ▼
GitHub 公开仓库（脱敏快照）
```

脚本：`main/scripts/make-public-snapshot.sh`
Workflow：`.gitea/workflows/public-mirror.yml`

### 三道安全护栏

脚本**绝不会**修改源仓库，靠三层保证：

1. 快照目录必须落在 `mktemp -d` 出来的临时目录内；
2. `git filter-repo` 的 cwd 必须是快照目录——它的 `--target` 默认是当前目录，**只在 `--source` 之外不写 `--target` 会把重写结果写进 cwd**，这一点踩过坑；
3. 执行前后比对源仓库全部 refs 的 sha256 指纹，一旦变化立即中止。

### 仓库内链接的改写

脚本会**自动**把指向本仓库的 Gitea 链接改写成公开仓库的对应链接，**不需要额外配置**——目标地址从 `SNAPSHOT_REPO_URL` 推导，源地址从 `origin` 远端推导：

| 私有仓库里的链接 | 公开快照里变成 |
|---|---|
| `https://<gitea>/<owner>/<repo>.git` | `https://github.com/<账号>/<repo>.git` |
| `https://<gitea>/<owner>/<repo>/releases` | `https://github.com/<账号>/<repo>/releases` |
| `https://<gitea>/api/packages/<owner>/generic/engram-installer/latest/<文件>` | `https://github.com/<账号>/<repo>/releases/download/installer-latest/<文件>` |

规则是**按顺序**作用的，所以这些改写规则排在主机名占位规则**之前**——否则主机名先被换成 `gitea.example.com`，完整 URL 就再也匹配不到。`main/scripts/install-engram.ps1` 的 `-RepoUrl` 默认值也因此变成公开仓库地址，公开出去的安装器默认就对着 GitHub 克隆。

**没有 GitHub 对应物的部分**：Docker 镜像（私有 Registry）会退化成 `gitea.example.com/example/engram/engram` 这样的占位串——除非另外把镜像推到 GHCR，否则 README 里那段 docker 命令在公开仓库里是无效的。

**安装器固定链接要真的可用**，需要在公开仓库里有一个标签为 `installer-latest` 的 Release，并把 `Engram-source-setup.exe` 挂成它的附件（Gitea 侧原本走 generic 包，GitHub 没有对应机制）。

## 首次配置

### 1. 建 GitHub 空仓库

在 GitHub 网页新建仓库（**不要**勾选 README / .gitignore / License），建议私有或公开按需选择。镜像会 force push，所以不要在该仓库上直接提交。

### 2. 生成 GitHub PAT

Fine-grained token，只需 **Contents: Read and write**（经典 token 则勾 `public_repo`，私有目标仓勾 `repo`）。仓库没有 `.github/workflows/`，不需要 `workflow` 权限。

### 3. 在 Gitea 仓库设置里配置

`设置 → Actions`：

**Secrets**（不要用 Variables，secret 会在日志里被打码）：

| 名称 | 值 |
|---|---|
| `PUBLIC_MIRROR_TOKEN` | 上一步的 GitHub PAT |
| `PUBLIC_SANITIZE_RULES` | 额外脱敏规则，多行文本，格式见下节 |

**Variables**：

| 名称 | 值 |
|---|---|
| `PUBLIC_MIRROR_REPO_URL` | `https://github.com/<你的账号>/Engram.git` |
| `PUBLIC_MIRROR_EMAIL` | `<你的账号>@users.noreply.github.com` |
| `PUBLIC_MIRROR_NAME` | 快照里的作者名，可留空（默认 `Engram`） |

### 4. 跑一次

`Actions → Public Mirror → Run workflow`。看日志里是否出现：

```
>> 护栏 3 通过：源仓库 refs 指纹未变
   ok no residual for any rule
   ok 提交头邮箱已归一
   ok 作者名已归一
```

## 规则文件格式

每行一条，`==>` 前是「要被替换的真实串」，后面是占位串：

```
literal:某真实域名.com==>example.com
literal:某个账号或密码==>CHANGE_ME_PUBLIC_SNAPSHOT_PLACEHOLDER
literal:某私有项目名==>ExampleProject
regex:192\.168\.1\.55\b==>192.168.1.100
regex:(ONLYOFFICE_JWT_SECRET:-)[0-9a-f]{64}==>\1CHANGE_ME_PUBLIC_SNAPSHOT_PLACEHOLDER
```

* 默认按**字面量**匹配，`regex:` 前缀走正则（支持 `\1` 反向引用），`glob:` 仅用于路径重命名且不能配 `==>`。
* 规则**按书写顺序**依次作用，所以「更长更具体的串」要写在前面（例如带端口的主机名写在裸主机名之前）。
* 规则同时作用于**文件内容、提交信息、标签信息、路径名**。
* 注释行以 `#` 开头，空行忽略。

Gitea 的主机名与 owner **不需要写进规则**——脚本从 `origin` 远端推导，分别替换为 `gitea.example.com` 与 `example`。

## 本地运行

本地规则放在 `main/.public-mirror/rules.local.txt`（已在根 `.gitignore` 忽略，不会入库）。脚本按 `PUBLIC_SANITIZE_RULES` → `PUBLIC_SANITIZE_RULES_FILE` → 上述本地文件的顺序取规则。

先干跑，只重写与校验、不推送：

```bash
SNAPSHOT_EMAIL="<你的账号>@users.noreply.github.com" \
SNAPSHOT_DRY_RUN=1 \
bash main/scripts/make-public-snapshot.sh
```

要推送时再去掉 `SNAPSHOT_DRY_RUN` 并加上：

```bash
SNAPSHOT_REPO_URL="https://github.com/<你的账号>/Engram.git" \
SNAPSHOT_TOKEN="<PAT>" \
bash main/scripts/make-public-snapshot.sh
```

其他可用环境变量：`SNAPSHOT_NAME`、`SNAPSHOT_BRANCH`（默认 `main`）、`SNAPSHOT_PUSH_TAGS`（默认 `1`）、`SNAPSHOT_KEEP=1`（保留快照目录供排查）、`SNAPSHOT_HOST_FROM` / `SNAPSHOT_OWNER_FROM` / `SNAPSHOT_HOST_TO` / `SNAPSHOT_OWNER_TO`。

## 已知限制

* **只推 `main` + 标签**，进行中的 `feat/*` 分支不会公开。要改范围用 `SNAPSHOT_BRANCH` / `SNAPSHOT_PUSH_TAGS`。
* **不同步 Issue / PR / Release / Wiki**。GitHub 上不会有 Release 页面；发版仍走 Gitea Actions 与 `CHANGELOG.md`。
* **force push 覆盖目标仓库**：不要在 GitHub 上直接提交，会被下次同步覆盖。
* **只支持 HTTPS**：推送目标必须是 `https://` 地址，PAT 当密码用。
* 脱敏是**字符串替换**，不是语义重写：被替换的标识符（如 Android `applicationId`、Java 包名）在快照里会变成占位值。公开快照因此与原私有构建的包名不同，这是有意为之。
* 需要 runner 能访问 `github.com`（本项目 runner 是 Windows 宿主机模式，跑在开发机上）。
