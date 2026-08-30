# 构建与部署指南（BUILDING）

本文是 Engram 从源码到安装包、再到部署运行的**完整构建手册**，面向两类读者：

- **其他用户**：拿到源码后想自己构建 Docker 镜像 / Windows 安装包，或把系统部署到自己的服务器；
- **AI Agent / 维护者**：需要快速执行「发新版本」「本地构建」「部署」等操作，本文提供可直接复制执行的命令清单（见 §7）。

CI 流水线的维护细节（Runner 搭建、Secrets、历史踩坑）见 [`GITEA-CI.md`](./GITEA-CI.md)；开发工作流（worktree / 验证 / 合并）见 [`../AGENTS.md`](../AGENTS.md) 与 [`../WORKTREES.md`](../WORKTREES.md)。

---

## 0. 全景：为什么「本地生成安装包」却「由 workflow 生成」

本项目的发布方式初看矛盾：**安装包是在开发者本机生成的，但触发和编排它的是 Gitea Actions workflow**。原因在 Runner 的部署方式——act_runner 以 **Windows 宿主机模式**注册，runner 进程就跑在开发者的 Windows 开发机上（不是 NAS 上的容器）。于是整条链路是：

```
 ① 推送标签              ② 派发任务               ③ 在本机构建                      ④ 产物推回 NAS
┌────────────┐ v* tag  ┌────────────────┐  job   ┌──────────────────────────┐  push  ┌────────────────┐
│ 开发者本机   │ ──────▶ │ Gitea（NAS）    │ ─────▶ │ act_runner（本机进程，     │ ─────▶ │ Gitea（NAS）    │
│ git push    │         │ .gitea/        │        │ Windows 宿主机模式）       │         │ Registry 镜像   │
│ gitea v1.1.7│         │ workflows/     │        │  └ Docker Desktop         │         │ :<版本> + :latest│
└────────────┘         │ release.yml 触发│        │    └ Linux 容器内构建：     │         │ + Release 页面  │
                       └────────────────┘        │      · 服务端 Docker 镜像  │         │ (exe/tar.gz/   │
                                                 │      · wine 交叉打 exe     │         │  sha256 三附件) │
                                                 │      · docker save tar.gz │         └────────────────┘
                                                 └──────────────────────────┘
```

要点：

- **Gitea 与 Runner 分离**：Gitea（含镜像 Registry 和 Release 页面）在 NAS 上；构建执行发生在开发本机。runner 离线时 workflow 会排队等待。
- **Windows 宿主机 runner + Docker Desktop**：workflow 的 `runs-on: windows` 命中本机 runner，所有构建命令经本机 Docker Desktop 跑 **Linux 容器**——服务端镜像直接 `docker build`，Windows 安装包则在 `electronuserland/builder:wine` 容器里用 **wine 交叉编译**。
- **产物统一回推 NAS**：镜像推到 Gitea 内置 Registry，安装包等三附件挂到 Release 页面，本地不留依赖残留。

### 三条构建路径总览

| 路径 | 适用场景 | 需要 Gitea？ | 详见 |
|---|---|---|---|
| **A. workflow 标准发版** | 正式版本发布，产物进 Registry + Release | 是（打 tag 触发） | §3 |
| **B. 本地 Docker 手动构建** | 其他用户从源码构建；CI 不可用时应急 | **否**，仅需本机 Docker | §4 |
| **C. Windows 宿主机直接打包** | 维护者在 Windows 上调试打包本身 | 否 | §5 |

路径 A 和路径 B 产出**完全相同**的产物——workflow 内部跑的就是路径 B 的那几条 docker 命令。其他用户没有这套 CI 环境时，直接照 §4 操作即可。

---

## 1. 产物一览

每次发版（`v*` 标签）固定产出以下四类：

| 产物 | 名称 / 地址 | 用途 |
|---|---|---|
| Docker 镜像 | `gitea.example.com/example/engram/engram:<版本>` 和 `:latest` | Docker 部署（push 到 Gitea 内置 Registry） |
| Windows 安装包 | `Engram Setup <版本>.exe`（约 110 MB） | NSIS 安装器，装出 Electron 桌面端 |
| Docker 镜像离线包 | `engram-<版本>.tar.gz`（`docker save`，约 160 MB） | 无 Registry 环境离线部署（`docker load`） |
| 校验值文件 | `sha256-<版本>.txt` | 前两者的 sha256 |

镜像地址是**三层路径**（`owner/repo/imagename`，归属 Engram 仓库）。历史上曾用两层路径（更名前的 `example/example-wiki`），NAS 实测拉取异常，**不要改回**。

版本号的**唯一权威来源是 `main/desktop/package.json` 的 `version` 字段**：发版 tag、镜像 tag、exe 文件名、镜像内 `/app/VERSION`（应用内自更新的比对依据）全部由它派生。

---

## 2. 发版前置门禁：版本号与 CHANGELOG

workflow 会在构建前自动校验以下内容，**任何一条不满足直接失败**，不会产出半成品：

1. **tag 与版本号一致**：`v<版本>` 标签必须等于 `main/desktop/package.json` 的 `version`（如 tag `v1.1.7` ↔ version `1.1.7`）。
2. **CHANGELOG 段落存在**：仓库根 `CHANGELOG.md` 必须有 `## v<版本>（YYYY-MM-DD）` 格式的段落（标题到下一个 `## ` 之前），记录距上次发布以来的全部新功能。该段落会被自动提取为 Gitea Release 正文。

版本号需在**三处同步 bump**（同一提交）：

| 文件 | 位置 | 作用 |
|---|---|---|
| `main/desktop/package.json` | `"version"` 字段 | 版本号权威来源（CI 硬校验） |
| `main/web/src/version.ts` | `APP_VERSION` | 软件内页面显示的版本号 |
| `main/docker-compose.yml` | `image: example-wiki:<版本>` | 本地开发 compose 的镜像 tag |

---

## 3. 路径 A：标准发版（Gitea Actions workflow）

### 3.1 触发方式

`.gitea/workflows/release.yml` 有两种触发：

| 触发 | 行为 |
|---|---|
| 推送 `v*` 标签（如 `v1.1.7`） | **完整发布**：构建推送镜像（`:<版本>` + `:latest`）→ 打 exe → 创建 Gitea Release 挂三附件 |
| 网页手动触发（workflow_dispatch） | **测试模式**：同样构建并推送镜像、产出全部产物，但**不创建 Release**，产物上传为 Artifact（保留 7 天） |

日常推送 main 分支只触发 `ci.yml` 做 verify（build + typecheck + test），**不构建镜像**——Registry 里的版本 tag 永远只对应发版产物。

### 3.2 操作步骤

```bash
# 1. bump 三处版本号 + 写 CHANGELOG 段落（同一提交）
git commit -am "chore: bump 版本号至 <版本>"
git push gitea main                 # ci.yml 只做 verify
# 2. 确认 Actions 里 ci.yml 通过
# 3. 打标签触发发版
git tag v<版本>
git push gitea v<版本>              # release.yml 启动
# 4. 到 Gitea 网页 Actions 页盯 release.yml 直到全绿
# 5. 校验产物：Release 页面出现 v<版本>，正文=CHANGELOG 段落，
#    附件为 exe / tar.gz / sha256 三件；镜像可 docker pull
# 6. 把附件下载归档到 releases/<版本>/（记录提交 ID、构建时间、sha256）
```

**铁律**：bump 版本号的提交必须**立即推送** gitea——版本号是镜像 tag 和 Release 标签的来源，留在本地会导致远端镜像与版本号脱节。

### 3.3 workflow 内部做了什么（release.yml 八步）

1. **检出代码**；
2. **提取版本号**：从 `main/desktop/package.json` sed 出 `version`；
3. **校验 tag = v<版本>**（仅 tag 触发时）；
4. **提取 CHANGELOG 段落**：awk 截取 `## v<版本>` 到下一个 `## ` 的内容，缺失即失败；
5. **构建并推送 Docker 镜像**：`docker build --label org.opencontainers.image.version=<版本> -t $IMAGE:<版本> -t $IMAGE:latest main`，login 后连推两个 tag；
6. **构建 Windows 安装包**：`cd main && docker build -f desktop/Dockerfile.ci -t engram-desktop-builder .`（wine 容器内跑 `scripts/build-desktop-ci.sh`，详见 §4.2），再 `docker create` + `docker cp` 把 `/work/desktop/dist/` 拷出来；
7. **整理产物**：断言 `Engram Setup <版本>.exe` 存在 → `docker save | gzip` 生成镜像 tar.gz → `sha256sum` 生成校验文件；
8. **发布**：tag 触发则用 gitea-release-action 创建 Release（正文 = CHANGELOG 段落 + 固定的镜像地址说明，附件 = exe / tar.gz / sha256）；手动触发则上传为 Artifact。

### 3.4 一次性环境前置（已配置，复现细节见 GITEA-CI.md）

- **Windows 宿主机 runner**：act_runner 注册到 Gitea，label `windows`，宿主机装好 Docker Desktop；
- **三个 Repository Secrets**：`REGISTRY_USERNAME` + `REGISTRY_TOKEN`（推镜像，token 需 **package 写权限**）、`RELEASE_TOKEN`（建 Release，repository 写权限）；
- **网络**：runner 需能访问 DaoCloud 镜像源（拉 `electronuserland/builder:wine` 基础镜像）和 npmmirror（npm 依赖、electron 二进制）。

私有化用户自建 Gitea + act_runner 复现这套 CI 的完整说明（含 Windows runner 的 MSYS 路径转换、Z 盘 bind mount 限制等坑）见 [`GITEA-CI.md`](./GITEA-CI.md)。

---

## 4. 路径 B：本地 Docker 手动构建（推荐其他用户使用）

**不需要 Gitea、不需要 CI 环境**，任何装了 Docker 的机器（Linux / macOS / Windows + Docker Desktop）都能构建出与发版完全相同的产物。脚本内部统一走 npmmirror / DaoCloud 国内源；若你的网络可直连 Docker Hub，基础镜像可自行换回官方名。

### 4.1 构建服务端 Docker 镜像

```bash
cd main
docker build -t example-wiki:<版本> .
```

`main/Dockerfile` 是多阶段构建：`build`（装依赖 + 编译 server/web + 写入 `/app/VERSION`）→ `deps`（生产依赖 + better-sqlite3 原生编译）→ `test` / `verify`（跑测试，CI 用）→ 最终运行时镜像（`node:22-slim`，`CMD node dist/index.js`，暴露 8080，数据卷 `/data`）。

只想验证代码而不出镜像时，可以只构建 verify 阶段（typecheck + test 在 `docker build` 期间执行，失败即构建失败）：

```bash
docker build --target verify -t example-wiki:verify .
docker run --rm example-wiki:verify     # 打印 Engram verification passed 即全部通过
```

### 4.2 构建 Windows 安装包（wine 容器交叉打包）

```bash
cd main
docker build -f desktop/Dockerfile.ci -t engram-desktop-builder .
CID=$(docker create engram-desktop-builder)
mkdir -p ../desktop-dist
docker cp "$CID:/work/desktop/dist/." ../desktop-dist
docker rm "$CID"
ls -la ../desktop-dist     # → Engram Setup <版本>.exe + win-unpacked/
```

> Windows 上用 Git Bash 执行时，若 `docker cp` 的容器路径被转义成 `C:/Program Files/...`，在命令前加 `MSYS_NO_PATHCONV=1`。

容器内实际执行的是 `main/scripts/build-desktop-ci.sh`，全自动完成：

1. corepack 激活 pnpm@10.20.0，registry 设 npmmirror；
2. `pnpm install` → 编译 server（tsc）+ web（vite）→ `prepare-desktop.js` 把产物复制进 `desktop/`；
3. 给 `desktop/server` 按 **win32-x64** 交叉安装生产依赖（`--node-linker=hoisted` 保证原生模块是真实目录而非 symlink）；
4. `prebuild-install` 显式拉 better-sqlite3 的 **Electron win32-x64** 预编译，并做 **MZ 头断言**（必须是 Windows PE 二进制，防止被装成 Linux ELF 装进 exe 导致本地模式必崩）；
5. 删 `server/node_modules` 的 `.bin` 与悬空 symlink（避免 NSIS 的 7za 扫描报错）；
6. `npx electron-builder --win nsis --config.npmRebuild=false` 打 NSIS 安装包（`npmRebuild=false` 防止 EB 按当前 Linux 平台重编原生模块，覆盖第 4 步预放的 win32 二进制）。

### 4.3 产物验证（每次构建后必做）

```bash
# 1. 安装包存在且原生模块是 Windows PE 二进制（头两字节 = MZ）
ls "../desktop-dist/Engram Setup <版本>.exe"
head -c 2 "../desktop-dist/win-unpacked/resources/app.asar.unpacked/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
# → 应输出 MZ

# 2. 在 Windows 上 fork 内嵌 server 起服务（exe 只能在 Windows 运行）
cd ../desktop-dist/win-unpacked
PORT=18080 ELECTRON_RUN_AS_NODE=1 "./Engram.exe" resources/app.asar/server/dist/index.js &
curl http://localhost:18080/health        # → 200
# 3. 确认 asar 里是本次版本号（返回计数 > 0 即命中）
grep -c "<版本>" resources/app.asar
```

三项全过才算构建通过；只看构建命令不报错不算验证。

---

## 5. 路径 C：Windows 宿主机直接打包（维护者场景）

在 Windows 上不经过 Docker、直接用本机 Node 环境打包（调试打包流程本身时用）：

```bash
cd main
pnpm build:desktop
```

该命令依次：构建 server → 构建 web → `prepare-desktop.js` 复制产物 → 装 server 生产依赖 → `electron-builder --win nsis` 产出安装包到 `desktop/dist/`。

**主要障碍是 Windows Defender**：实时扫描会锁定 `electron.exe` 导致 `EPERM rename` 失败。绕行方案是「手动两步法」——`Expand-Archive` 直接解压 electron zip 组装 win-unpacked → `desktop/scripts/pack-asar.js` 手动打 asar → `electron-builder --prepackaged` 出 NSIS 包，外加手动补 better-sqlite3 的 native 二进制等十余条细节。完整踩坑记录见仓库根 `AGENTS.md` 的「Windows 桌面端打包」章节。

**与路径 B 的取舍**：路径 C 需要 Windows 宿主环境 + 处理 Defender，步骤多坑多；路径 B 一条 docker 命令出同样的产物，**优先走路径 B**，除非你要调试的正是打包流程本身。

---

## 6. 部署

### 6.1 Docker 部署（三种方式）

**方式一：源码构建部署**（开发 / 内网无 Registry）

```bash
git clone https://github.com/jadesLL/Engram.git
cd Engram/main
docker compose up -d --build
```

**方式二：从 Registry 拉取**（生产，模板 `main/docker-compose.pull.yml`）

```bash
# Docker 镜像未公开发布（原私有 Registry 不对外）
docker compose -f docker-compose.pull.yml up -d     # 模板默认拉 :latest
```

**方式三：离线部署**（目标机无法访问 Registry）

```bash
# 在有网机器上（或直接用 Release 附件 engram-<版本>.tar.gz）
docker load < engram-<版本>.tar.gz
# 载入的镜像名是完整三层路径 :<版本>；compose 模板引用 :latest，二选一：
docker tag gitea.example.com/example/engram/engram:<版本> \
           gitea.example.com/example/engram/engram:latest
# 或者把 compose 里的 image 固定为 :<版本>
docker compose -f docker-compose.pull.yml up -d
```

**部署三条铁律**：

1. 镜像地址用三层路径 `example/engram/engram`，不要写两层的 `example/engram`（NAS 拉取异常）；
2. **不要写 `pull_policy: never`**——它禁止拉取，本地无镜像时必报「找不到镜像」，曾多次被误判为 Registry 故障；
3. `docker-compose.pull.yml` 里的 `/var/run/docker.sock` 挂载是**应用内自更新**（设置 → 软件更新，网页一键拉新镜像重建容器）所需；不需要该功能可删掉这行。

部署后访问 `http://<主机IP>:8080`；初始密码由 compose 的 `DEFAULT_PASSWORD` 环境变量指定。onlyoffice 协同编辑是独立服务，第三方源拉不动时换官方镜像 `onlyoffice/documentserver:9.4.0`。

### 6.2 Windows 桌面端

直接安装 Release 附件里的 `Engram Setup <版本>.exe`（NSIS，可选安装目录）。桌面端有本地模式（内嵌后端，零服务器）和远端模式（连 Docker 实例，凭连接令牌免密登录）两种，详见 [`../desktop/README.md`](../desktop/README.md)。

### 6.3 应用内更新

Docker 部署在网页「设置 → 软件更新」一键更新（拉 latest 镜像 → switcher 容器接管重建 → 失败自动回滚）；桌面端同页下载新 exe 覆盖安装。更新源与令牌在设置页配置，存数据目录 `.env`。机制与安全说明见 [`GITEA-CI.md`](./GITEA-CI.md) 的「应用内自更新」章节。

---

## 7. AI 快速部署清单（可直接照做的操作卡）

以下清单面向 AI Agent / 自动化脚本，命令可直接复制执行。`<版本>` 为占位符（当前示例 `1.1.7`）。

### 卡 1：发新版本（需要 Gitea CI 环境）

```text
前置检查：
  · git status 干净，main 已与 gitea/main 同步，待发功能已全部合并
  · Gitea 网页 Actions 页面 runner 显示在线（离线则 workflow 排队）
  · 距上次发布的新功能已盘点（CHANGELOG 段落要写全）
命令序列：
  1. 同步 bump 三处版本号：
     main/desktop/package.json 的 "version"
     main/web/src/version.ts 的 APP_VERSION
     main/docker-compose.yml 的 image: example-wiki:<版本>
  2. CHANGELOG.md 顶部新增 "## v<版本>（YYYY-MM-DD）" 段落，写入全部新功能
  3. git commit + git push gitea main → 等 ci.yml（verify）全绿
  4. git tag v<版本> && git push gitea v<版本>
  5. 盯 release.yml 至全绿
结果验证：
  · Release 页面出现 v<版本>，正文 = CHANGELOG 段落，附件 = exe + tar.gz + sha256 三件
  · docker pull 镜像 :<版本> 成功
  · 附件下载归档 releases/<版本>/
常见失败对照：
  · 校验步失败 "标签与版本号不一致"     → tag 必须严格等于 v + desktop/package.json version
  · 校验步失败 "缺少 v<版本> 版本段落"  → CHANGELOG 段落标题格式必须是 ## v<版本>（YYYY-MM-DD）
  · 上传附件 413                       → 调大 Gitea app.ini [attachment] MAX_SIZE 后重启 Gitea
  · workflow 一直排队                  → runner 离线，检查本机 act_runner 与 Docker Desktop
```

### 卡 2：从源码构建安装包（本机 Docker，无需 Gitea）

```text
前置检查：
  · docker version 正常（Windows 需 Docker Desktop 已启动）
  · 能访问 docker.m.daocloud.io 与 registry.npmmirror.com（国内源）
命令序列：
  · 服务端镜像：cd main && docker build -t example-wiki:<版本> .
  · Windows 安装包：
      cd main
      docker build -f desktop/Dockerfile.ci -t engram-desktop-builder .
      CID=$(docker create engram-desktop-builder)
      docker cp "$CID:/work/desktop/dist/." ../desktop-dist
      docker rm "$CID"
    （Windows Git Bash 下 docker cp 前缀加 MSYS_NO_PATHCONV=1）
结果验证：
  · ../desktop-dist/Engram Setup <版本>.exe 存在
  · better_sqlite3.node 头两字节 = MZ（§4.3 命令）
  · Windows 上 fork server：PORT=18080 ELECTRON_RUN_AS_NODE=1 "./Engram.exe" \
    resources/app.asar/server/dist/index.js 后 curl /health 返回 200
常见失败对照：
  · 基础镜像拉不动            → 网络可达 Docker Hub 时把 Dockerfile.ci 基础镜像换回官方名
  · docker cp 报路径不存在    → Git Bash 路径转义问题，加 MSYS_NO_PATHCONV=1
  · asar 内版本号不对          → 构建前未提交版本号改动，检查 desktop/package.json 后重建
```

### 卡 3：部署到 Docker 服务器

```text
前置检查：
  · 目标机 docker + docker compose 可用
  · 镜像可及：能 docker login Registry，或已拿到 engram-<版本>.tar.gz
命令序列：
  · 在线：docker login <registry> → docker compose -f docker-compose.pull.yml up -d
  · 离线：docker load < engram-<版本>.tar.gz → retag 到 :latest（或改 compose 镜像 tag）→ up -d
结果验证：
  · curl http://<主机IP>:8080/health 返回 200
  · 浏览器打开出现登录页，登录后设置页版本号 = <版本>
常见失败对照：
  · "pull access denied / 找不到镜像" → 检查三层路径写法 + 是否误加 pull_policy: never + 是否 docker login
  · onlyoffice 起不来                → 换官方镜像 onlyoffice/documentserver:9.4.0
  · 页面慢                           → 先看 /health 是否快，区分网络/磁盘问题与版本问题
```

---

## 8. 常见问题排查

**镜像拉不到 / 找不到**
依次检查：① 地址是三层路径 `example/engram/engram`（两层 `example/engram` 是废弃路径，Registry 里残留旧版本但不再更新）；② 没写 `pull_policy: never`；③ 私有 Registry 先 `docker login`（token 需 **package 权限**，repository-only 权限的 token 过不了认证）。

**Release 附件上传 413**
exe 约 110 MB、tar.gz 约 160 MB，超出 Gitea 默认附件上限。调大 `app.ini` 的 `[attachment] MAX_SIZE` 后重启 Gitea。

**exe 安装后本地模式启动即崩（dlopen 失败）**
几乎总是 `better_sqlite3.node` 不是 Windows PE 二进制（被装成了 Linux ELF）。用 §4.3 的 MZ 头检查确认；构建脚本内置了断言会主动报错，绕过脚本手动组装时容易踩。另一常见原因是改了 `server/src/lib/db.ts` 后没重新 build server 就打包。

**Windows runner 特有坑**（自建 CI 复现时必读，详见 GITEA-CI.md）
① 所有 run 步骤必须显式 `shell: bash`（默认是 pwsh/cmd）；② 必须设 `MSYS_NO_PATHCONV: '1'`，否则 Git Bash 把参数里的 `main` 转成 `C:/Program Files/Git/main`；③ 网络驱动器（如 Z 盘）不支持 docker bind mount，一律「源码 COPY 进镜像 + docker create/cp 拷出产物」；④ 构建上下文用 `cd main && docker build .`（相对路径），不要传 `main` 参数。

**Windows Defender EPERM（仅路径 C）**
`electron-builder` 解压 electron 时 Defender 锁 `electron.exe` 致 rename 失败。关实时扫描 / 加排除项，或直接改走路径 B / 手动两步法（根 AGENTS.md）。

---

## 9. 构建相关文件索引

| 文件 | 作用 |
|---|---|
| `.gitea/workflows/release.yml` | 发版 workflow：版本/CHANGELOG 校验 → 镜像构建推送 → wine 打 exe → 建 Release |
| `.gitea/workflows/ci.yml` | main 推送触发的 verify（build + typecheck + test，不碰镜像） |
| `main/Dockerfile` | 服务端镜像多阶段构建（build / deps / test / verify / 运行时） |
| `main/desktop/Dockerfile.ci` | wine 交叉打包容器（基础镜像 + COPY 源码 + 调构建脚本） |
| `main/scripts/build-desktop-ci.sh` | 容器内打包全流程脚本（路径 B 的核心，含三个关键修复点） |
| `main/desktop/scripts/prepare-desktop.js` | 复制 server/web 产物到 desktop/，生成 server 运行时依赖清单 |
| `main/desktop/scripts/pack-asar.js` | 路径 C 手动打 asar（绕 Defender，CI 不用） |
| `main/desktop/package.json` | 版本号权威来源 + electron-builder 配置（asar / asarUnpack / NSIS） |
| `main/desktop/build/installer.nsh` | NSIS 定制：安装时显示详情与阶段日志 |
| `main/docker-compose.yml` | 本地开发 compose（本地构建镜像） |
| `main/docker-compose.pull.yml` | 生产部署模板（Registry 拉取 + docker.sock 挂载） |
| `main/docker-compose.local-deploy.yml` | 内部部署辅助片段（叠加本地镜像用） |
| `main/Dockerfile.deploy` | 旧版遗留，release.yml 未使用 |
| `CHANGELOG.md` | 版本段落 = 发版硬门禁 + Release 正文来源 |
