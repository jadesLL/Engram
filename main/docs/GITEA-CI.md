# Gitea CI 与镜像分发指南

本项目通过 Gitea Actions（`https://gitea.example.com/example/ExampleProject`）实现持续集成、Docker 镜像分发和 Windows 安装包发布。

> 从源码构建安装包的完整指南（含不依赖 CI 的本地 Docker 构建路径、部署方式与 AI 操作清单）见 [`BUILDING.md`](./BUILDING.md)；本文聚焦 CI/CD 流水线本身的维护与历史踩坑。

## 日常工作流（总纲）

```text
开发（worktree）→ verify → 用户三选一：仅合并 / 合并并推送远端 / 合并推送+发版
→（合并时）新功能同步整合进根 README.md
→（推送）git push gitea main：CI 只做 verify（build+typecheck+test），不构建镜像
→（发版）bump 三处版本号 + CHANGELOG.md 写 v<版本> 段落 → 提交并立即推送 → git tag v<版本> && git push gitea v<版本>
→ release.yml 自动：校验并提取 CHANGELOG 段落（缺失即失败）→ 构建并推送镜像（版本 tag + latest）+ Windows exe + Gitea Release（正文=CHANGELOG 版本段落，附件= exe / docker tar.gz / sha256）
→ 下载 Release 附件归档到 releases/<版本>/（AGENTS.md 项目规则 3）
→ 部署机 docker login + docker pull 新版本镜像
```

**铁律**：
- 功能验收后必须问用户三选一（仅合并 / 合并并推送 / 合并推送+发版），合并后必须推送 gitea，不得留本地远端分叉。
- **只要更新版本号，提交后必须立即推送 gitea**（版本号 = 镜像 tag = Release 标签，留在本地会造成远端镜像与版本号脱节），并确认 Actions 运行成功。
- **镜像只在发版时构建**（2026-08-20 起生效）：main 日常推送不构建不推送任何镜像，Registry 里的版本 tag 永远只对应发版产物，不会被日常推送覆盖。
- **功能合并 main 时同步整合进根 `README.md`**；**发版时必须写 `CHANGELOG.md` 的 `## v<版本>（YYYY-MM-DD）` 段落**（距上次发布以来的全部新功能），release.yml 校验缺失即失败，段落会自动发布为 Release 正文。

| 环节 | 命令/动作 | 自动发生什么 |
|---|---|---|
| 日常推送 | `git push gitea main` | ci.yml：仅 verify（build+typecheck+test），不碰镜像 |
| 发版 | bump 版本号 + CHANGELOG 段落 → push main → `git tag v<版本>` → `git push gitea v<版本>` | release.yml：校验提取 CHANGELOG 段落（缺失失败）→ 构建推送镜像（`:<版本>` + `:latest`）+ wine 交叉打 exe + 创建 Release（正文=CHANGELOG 段落，附件 exe/docker tar.gz/sha256） |
| Release 测试 | Gitea 网页手动触发 release.yml（workflow_dispatch） | 完整构建（含镜像推送）但**不发布 Release**，产物传 Artifact（保留 7 天） |
| 部署 | `docker login` → `docker compose -f docker-compose.pull.yml up -d` | — |

**版本号一致性（发版门禁，release.yml 有校验）**：
- tag 必须等于 `v<desktop/package.json 的 version>`（如 v1.1.6），不一致直接失败。
- bump 时三处同步：`main/desktop/package.json` 的 `version`、`main/web/src/version.ts`（软件内版本显示）、`main/docker-compose.yml` 镜像 tag。
- 仓库根 `CHANGELOG.md` 必须有 `## v<版本>（YYYY-MM-DD）` 段落（距上次发布以来的全部新功能），release.yml 用 awk 提取该段落（段落标题行到下一个 `## ` 标题前），缺失直接失败；段落内容自动作为 Gitea Release 正文发布。

## 镜像地址（重要）

```bash
# 正确：三层路径 example/exampleproject/example-wiki（owner/repo/imagename，镜像归属 ExampleProject 仓库）
gitea.example.com/example/exampleproject/example-wiki:<版本>

# 错误：两层路径 example/example-wiki（归属用户命名空间）——1.1.5 曾用此路径，NAS 实测拉取异常，已废弃
```

部署示例：

```bash
# Docker 镜像未公开发布（原私有 Registry 不对外）
docker pull gitea.example.com/example/exampleproject/example-wiki:1.1.5
docker compose -f docker-compose.pull.yml up -d
```

部署 compose 注意：
- **不要写 `pull_policy: never`**——它禁止从 Registry 拉取，本地无镜像时必报"找不到镜像"（NAS 首次部署曾因此误判为拉取失败）。
- onlyoffice 若第三方镜像源拉不动，换官方 `onlyoffice/documentserver:9.4.0`。

## 应用内自更新（设置 → 软件更新）

1.1.6 起支持网页内一键更新，服务器与桌面端共用「Gitea Releases」作为版本信号源。

### 一次性引导（Docker 部署机）

在 `docker-compose.pull.yml` 的 example-wiki 服务 volumes 中确认有 docker.sock 挂载（模板已内置）：

```yaml
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock   # 应用内更新所需
```

然后 `docker compose -f docker-compose.pull.yml up -d` 重建容器一次。之后所有更新都可以在网页 设置 → 软件更新 中完成，无需再登录部署机。

### 更新源与令牌配置（设置 → 软件更新 → 更新源配置）

所有配置保存在**服务器数据目录的 `.env` 文件**（Docker 内 `/data/.env`，随数据卷持久化，不进数据库不进代码库）：

| 配置项 | 键 | 说明 |
|---|---|---|
| Gitea 服务地址 | `UPDATE_GITEA_URL` | 版本检测来源，如 `https://gitea.example.com` |
| Gitea 仓库 | `UPDATE_GITEA_REPO` | `owner/name` 形式 |
| Gitea 访问令牌 | `UPDATE_GITEA_TOKEN` | **公开仓库无需填写**；私有仓库需能读 Release |
| 镜像更新源 | `UPDATE_IMAGE_REF` | 不含 tag 的镜像地址，自动拉 `latest`；未配置时从当前容器镜像推导 |
| 镜像仓库用户名/令牌 | `UPDATE_REGISTRY_USERNAME` / `UPDATE_REGISTRY_TOKEN` | 私有 Registry 必填；公开仓库无需填写 |

私有化部署用户把 Gitea 地址/仓库换成自己的即可，镜像源同样可换。

### 更新流程与安全机制

- **检查更新**：比对 Gitea 最新 Release 版本号 + Registry `latest` digest（两者取或）。进入应用时自动检测一次（8 小时节流），有新版本时侧栏设置按钮出现红点并 toast 提醒。
- **一键更新（Docker）**：拉取 `latest` 镜像 → 用旧镜像临时起 switcher 容器接管 → 旧容器改名 `example-wiki-old` → 按原容器配置（端口/卷/网络/环境变量全保留）创建新容器 → 停旧起新 → 等新容器健康（最长 180s）→ 健康则删旧容器；**新容器起不来则自动回滚**重启旧容器。
- **桌面端更新**：设置页下载 Release 的 exe 安装包（带进度条）→ 运行安装包覆盖安装，应用自动退出。
- 手动恢复（极端情况 switcher 也失败）：`docker start example-wiki-old`，然后浏览器刷新。

### 安全说明

- 更新接口全部要求登录（JWT）。
- 挂载 docker.sock 意味着容器内进程可完全控制宿主 Docker（等同宿主 root），仅在自用/可信环境使用；不需要网页内更新就删掉该挂载行。
- 镜像目标 ref 只能来自当前容器自身推导或 `.env` 配置，不接受请求任意指定；桌面端安装包只允许从配置的 Gitea 源下载。
- compose 手动重建的容器 config 与 compose 记录存在漂移：下次手动 `compose up -d` 会重建容器（同镜像，短暂重启一次，版本不回退）。

## Repository Secrets（已配置）

| Secret | 用途 | 当前值 |
|---|---|---|
| `REGISTRY_USERNAME` | runner 上 docker login 推镜像 | `example` |
| `REGISTRY_TOKEN` | 同上 | **package 写权限** token（repository-only 权限的 token 过不了 Registry 认证） |
| `RELEASE_TOKEN` | 创建 Release / 上传附件 | repository 写权限 token |

## Runner 环境约束（Windows 宿主机模式）

act_runner 以 Windows 宿主机模式运行（label `windows`），Docker 命令经 Docker Desktop 跑 Linux 容器。由此产生的四条硬约束（都踩过，详见下文踩坑记录）：

1. **所有 run 步骤显式 `shell: bash`**——Windows runner 默认是 pwsh/cmd。
2. **`MSYS_NO_PATHCONV: '1'` 必须设**——Git Bash 会把 docker 参数里的 `main` 转成 `C:/Program Files/Git/main`。它只管参数转换；**docker build 的上下文路径仍必须 `cd main && docker build .`**（相对 cwd），传 `main` 参数会被 docker CLI 按错误路径解析。
3. **Docker Hub 直连不通**——`desktop/Dockerfile.ci` 基础镜像固定走 DaoCloud 镜像源 `docker.m.daocloud.io/electronuserland/builder:wine`；其他基础镜像靠本机缓存。
4. **Z 盘不支持 bind mount**——CI 里容器构建一律「源码 COPY 进镜像 + `docker create`/`docker cp` 拷出产物」，不用 volume 挂载。

### 当前 Runner 部署（2026-08-23 迁移：DESKTOP-JQR7MEU → DESKTOP-BBO2MIL）

| 项 | 值 |
|---|---|
| 机器 | 开发机 DESKTOP-BBO2MIL（Windows，Docker Desktop Linux 引擎） |
| 安装目录 | `C:\Users\example\gitea-runner\`（gitea-runner.exe v3.3.0 + config.yaml + .runner） |
| 注册方式 | **全局（instance 级）**，runner id=3，name `dev-pc-bbo2mil`，labels `windows:host, ubuntu-latest:docker://node:22-bookworm`——ExampleProject 与 XINJE_Selection_Tool 的 CI 都由它执行 |
| 启动 | `gitea-runner.exe daemon --config config.yaml`；开机自启走计划任务 `GiteaRunnerDaemon`（登录触发、崩溃自动重启，`Get-ScheduledTask GiteaRunnerDaemon` 查状态） |
| config.yaml 关键项 | `container.docker_host: npipe:////./pipe/dockerDesktopLinuxEngine`（Windows 下 runner 默认探测 /var/run/docker.sock 失败，必须显式指向 Docker Desktop 的 Linux 引擎命名管道）；日志级别 debug（排查认领问题用，平时可调回 info） |

**迁移踩坑（旧机下线后 CI 全部排队无人认领）**：
- 旧 runner（id=1 dev-pc / id=2 仓库级 dev-pc-bbo2mil）已于 2026-08-23 删除；注意 **runner 注册有作用域**——用仓库页 token 注册的 runner 只服务该仓库（曾导致 ExampleProject CI 排队 6 小时无人认领而 XINJE 正常），必须用全局管理页（`/-/admin/actions/runners`，注意 `/-/` 前缀）的 Registration Token 注册。
- 管理页「创建新运行器」是**下拉菜单**，Registration Token 直接嵌在菜单的只读输入框里（页面 HTML 即含，无需点击交互）。
- 派发卡死恢复：任务派给已下线 runner 的会永久排队，推送一个空提交（`git commit --allow-empty`）触发新 run 即可被在线 runner 认领。

## wine 交叉打包关键坑（desktop/Dockerfile.ci + scripts/build-desktop-ci.sh）

Linux 容器里交叉打 Windows exe 的三个必踩坑，脚本已内置修复，改动打包流程前必读：

1. **`electron-builder --config.npmRebuild=false`**：EB 内置 @electron/rebuild 会按**当前平台（Linux）**重编原生模块，覆盖预放的 win32 二进制——打出的 `better_sqlite3.node` 是 Linux ELF，exe 能装但本地模式 dlopen 必崩。
2. **`prebuild-install --platform win32`**：prebuild-install 默认按当前平台拉预编译，必须显式指定 win32。脚本内有 **MZ 头断言**（PE32 检查），非 Windows 二进制直接 fail，防止回归。
3. **打包前删 `server/node_modules` 的 `.bin` 目录与悬空 symlink**：`--prod` 安装后 `.bin` 里残留指向 devDeps 的悬空链接，NSIS 的 7za 扫描到会报 exit 1。

打包端到端验证标准（每次发版必做）：
```bash
# 1. 产物二进制平台正确
file desktop-dist/win-unpacked/resources/app.asar.unpacked/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node
# → 必须是 PE32+ executable for MS Windows
# 2. fork server 起服务
cd desktop-dist/win-unpacked && ELECTRON_RUN_AS_NODE=1 "./LLM Wiki.exe" resources/app.asar/server/dist/index.js &
curl http://localhost:18080/health   # → 200
# 3. asar 内版本号
grep -c '<版本号>' app.asar 二进制内容（或查 staging package.json 的 version 字段）
```

## 已知注意事项

- **Release 附件大小**：exe 约 110MB、docker tar.gz 约 160MB。上传返回 413 时需调大 Gitea `app.ini` 的 `[attachment] MAX_SIZE` 后重启 Gitea。
- **镜像只随发版更新**：main 日常推送不构建镜像（2026-08-20 起）；Registry 版本 tag 只对应发版产物。发版前想提前验证 main 最新代码需本地构建，或手动 dispatch release.yml（测试模式，会推 `:<版本>` `:latest`——注意它仍会覆盖同版本 tag）。
- **本地开发 compose**（`docker-compose.yml`）仍用本地构建镜像；生产 pull 部署用 `docker-compose.pull.yml`。
- **Gitea secrets API** 字段名是 `data` 不是 `value`（PUT `/api/v1/repos/{owner}/{repo}/actions/secrets/{name}`，`{"data":"..."}`），用错报 422 "[Data]: Required"。
- **Release 测试模式**（手动 dispatch）产物在 Artifact 页，保留 7 天，正式产物必须走 `v*` 标签。

## 历史版本与镜像路径变更记录

| 版本 | 镜像路径 | 说明 |
|---|---|---|
| 1.1.4 / 1.1.5 初版 | `example/example-wiki`（两层） | 用户命名空间归属；1.1.5 发布时 NAS 拉取异常 |
| 1.1.5 起 | `example/exampleproject/example-wiki`（三层） | 仓库归属，与 XINJE_Selection_Tool 同款形式，NAS 拉取正常 |

旧两层路径的镜像仍留在 Registry（`1.1.4`、`1.1.5`），但不再更新；新发版全部走三层路径。
