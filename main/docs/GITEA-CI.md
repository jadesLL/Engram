# Gitea CI 与镜像分发指南

本项目通过 Gitea Actions（`https://gitea.example.com/example/ExampleProject`）实现持续集成、Docker 镜像分发和 Windows 安装包发布。

## 日常工作流（总纲）

```text
开发（worktree）→ verify → 用户批准合并 → git push gitea main（CI 自动 verify + 推镜像）
→ 用户批准发版 → bump 版本号 → 提交推送 → git tag v<版本> && git push gitea v<版本>
→ CI 自动：版本号镜像 + Windows exe + Gitea Release（exe / docker tar.gz / sha256）
→ 下载 Release 附件归档到 releases/<版本>/（AGENTS.md 项目规则 3）
→ 部署机 docker login + docker pull 新版本镜像
```

| 环节 | 命令/动作 | 自动发生什么 |
|---|---|---|
| 日常推送 | `git push gitea main` | ci.yml：verify（build+typecheck+test）+ 推镜像 `:<版本>` `:latest` |
| 发版 | bump 版本号 → push main → `git tag v<版本>` → `git push gitea v<版本>` | release.yml：版本镜像 + wine 交叉打 exe + 创建 Release 上传附件 |
| Release 测试 | Gitea 网页手动触发 release.yml（workflow_dispatch） | 完整构建但**不发布**，产物传 Artifact（保留 7 天） |
| 部署 | `docker login` → `docker compose -f docker-compose.pull.yml up -d` | — |

**版本号一致性（发版门禁，release.yml 有校验）**：
- tag 必须等于 `v<desktop/package.json 的 version>`（如 v1.1.5），不一致直接失败。
- bump 时三处同步：`main/desktop/package.json` 的 `version`、`main/web/src/version.ts`（软件内版本显示）、`main/docker-compose.yml` 镜像 tag。

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

## Repository Secrets（已配置）

| Secret | 用途 | 当前值 |
|---|---|---|
| `REGISTRY_USERNAME` | runner 上 docker login 推镜像 | `example` |
| `REGISTRY_TOKEN` | 同上 | **package 写权限** token（repository-only 权限的 token 过不了 Registry 认证） |
| `RELEASE_TOKEN` | 创建 Release / 上传附件 | repository 写权限 token |

## Runner 环境约束（Windows 宿主机模式）

act_runner 以 Windows 宿主机模式运行（label `windows`，runner 即开发机 DESKTOP-JQR7MEU），Docker 命令经 Docker Desktop 跑 Linux 容器。由此产生的四条硬约束（都踩过，详见下文踩坑记录）：

1. **所有 run 步骤显式 `shell: bash`**——Windows runner 默认是 pwsh/cmd。
2. **`MSYS_NO_PATHCONV: '1'` 必须设**——Git Bash 会把 docker 参数里的 `main` 转成 `C:/Program Files/Git/main`。它只管参数转换；**docker build 的上下文路径仍必须 `cd main && docker build .`**（相对 cwd），传 `main` 参数会被 docker CLI 按错误路径解析。
3. **Docker Hub 直连不通**——`desktop/Dockerfile.ci` 基础镜像固定走 DaoCloud 镜像源 `docker.m.daocloud.io/electronuserland/builder:wine`；其他基础镜像靠本机缓存。
4. **Z 盘不支持 bind mount**——CI 里容器构建一律「源码 COPY 进镜像 + `docker create`/`docker cp` 拷出产物」，不用 volume 挂载。

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
- **重复推送同版本号**：main 未 bump 版本号重复推送会覆盖 Registry 同名 tag，属预期。
- **本地开发 compose**（`docker-compose.yml`）仍用本地构建镜像；生产 pull 部署用 `docker-compose.pull.yml`。
- **Gitea secrets API** 字段名是 `data` 不是 `value`（PUT `/api/v1/repos/{owner}/{repo}/actions/secrets/{name}`，`{"data":"..."}`），用错报 422 "[Data]: Required"。
- **Release 测试模式**（手动 dispatch）产物在 Artifact 页，保留 7 天，正式产物必须走 `v*` 标签。

## 历史版本与镜像路径变更记录

| 版本 | 镜像路径 | 说明 |
|---|---|---|
| 1.1.4 / 1.1.5 初版 | `example/example-wiki`（两层） | 用户命名空间归属；1.1.5 发布时 NAS 拉取异常 |
| 1.1.5 起 | `example/exampleproject/example-wiki`（三层） | 仓库归属，与 XINJE_Selection_Tool 同款形式，NAS 拉取正常 |

旧两层路径的镜像仍留在 Registry（`1.1.4`、`1.1.5`），但不再更新；新发版全部走三层路径。
