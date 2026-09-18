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

**Docker 镜像没有 GitHub 对应物**：公开仓库没有 Registry，所以 README 里那几条 `docker login` / `docker pull` 会被换成一句明确说明，镜像那一行也标注「未公开发布；需要请自行构建」。要真正可用只有一条路——把镜像推到 GHCR（需要 PAT 再加 `packages: write`）。

**安装器固定链接要真的可用**，需要在公开仓库里有一个标签为 `installer-latest` 的 Release，并把 `Engram-source-setup.exe` 挂成它的附件（Gitea 侧原本走 generic 包，GitHub 没有对应机制）。

### README 口径修正

README 里有些文案描述的是私有仓库，在公开仓库里不成立，脚本会把它们换成公开口径：

| 原文 | 公开快照里变成 |
|---|---|
| `` | 删除 |
| `公开仓库无需凭据` | `公开仓库无需凭据` |
| `- **GitHub Release**：` | `- **GitHub Release**：` |
| `发布到 GitHub Release 正文` | `发布到 GitHub Release 正文` |
| `生产环境可从私有 Registry 拉取镜像部署…` | `公开仓库未发布 Docker 镜像；自建部署请从源码构建：` |
| `docker login <gitea> -u <owner> -p <token>` | `# Docker 镜像未公开发布（原私有 Registry 不对外）` |
| `docker pull <gitea>/<owner>/engram/engram:<版本>` | `# 需要镜像请自行构建：docker compose … up -d --build` |
| `（未公开发布；需要请自行构建）` | `（未公开发布；需要请自行构建）` |

这些是**按字面匹配**的，所以改动 README 措辞后对应规则会静默失效——改文案时记得同步脚本里这一段规则。

## 发布同步

推完标签后，脚本会按 `CHANGELOG.md` 的版本段落给每个 `v*` 标签建/更新公开仓库的 Release：

- 正文取**快照内**的 `CHANGELOG.md`（已脱敏），与 Gitea 侧 `release.yml` 同一约定，因此**不需要调 Gitea API、不需要额外凭据**（复用推送用的那把 PAT）
- 刻意读 `HEAD` 的 CHANGELOG 而不是 `<tag>:CHANGELOG.md`：早期标签当时仓库根还没有这份文件，只有当前这份覆盖全部版本段落
- **幂等**：先 `GET` 该标签的 Release，正文一致就不动；缺了才 `POST`，变了才 `PATCH`
- `SNAPSHOT_SYNC_RELEASES=0` 可关闭；目标不是 github.com 时自动跳过
- 不附带任何二进制附件（与 Gitea 侧现状一致）

## 发布公开安装器

README 里那条「源码版安装器（固定链接，永远最新）」在公开仓库里指向
`https://github.com/<账号>/<repo>/releases/download/installer-latest/Engram-source-setup.exe`。
要让它真的能下载，需要把安装器 exe 挂到 `installer-latest` 标签的 Release 下。

按需在本机跑（**不参与 CI**，与「安装包只在明确要求时才构建」一致）：

```powershell
.\main\scripts\publish-public-installer.ps1 -Token 'github_pat_xxx'
```

它做三件事：

1. 调 `make-public-snapshot.sh` 并把 `SNAPSHOT_EXPORT_INSTALLER` 指向暂存目录，
   直接复用已验证的脱敏结果导出安装器源码。**绝不能用私有树里的源码**——
   `main/installer/scripts/lib/repo-url.js` 的注释带着内网 IP 与账号名，会被原样打进 exe。
2. 用本机已有的 electron 运行时与 electron-builder 打包 portable exe。
3. 上传到 `installer-latest` Release（不存在则创建；同名旧附件先删再传）。

只构建不上传用 `-SkipUpload`。脚本自带两道自检：导出的 ps1 默认地址必须等于公开仓库
地址；打包后再解包确认 exe 内 ps1 的默认地址正确、且不含任何私有串。

两个已踩过并已处理的坑：

* electron-builder 26 默认用 `npm` 枚举依赖树，而本机只有 pnpm，不在 `package.json`
  里声明 `packageManager` 会报 `spawn npm ENOENT`。
* 暂存的 `package.json` 必须写**无 BOM** 的 UTF-8，否则 `@electron/rebuild` 的
  `JSON.parse` 报 `Unexpected token '﻿'`。

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
