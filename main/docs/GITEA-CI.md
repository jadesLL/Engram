# Gitea CI 与镜像分发指南

本项目通过 Gitea Actions（`https://gitea.example.com/example/ExampleProject`）实现持续集成、Docker 镜像分发和 Windows 安装包发布。

## Workflow 总览

| 文件 | 触发 | 内容 |
|---|---|---|
| `.gitea/workflows/ci.yml` | 任意分支推送 / PR / 手动 | verify 阶段（build + typecheck + test）；仅 main 分支额外构建并推送 Docker 镜像 |
| `.gitea/workflows/release.yml` | 推送 `v*` 标签 / 手动 | 构建推送版本号镜像 + wine 容器交叉打包 Windows NSIS 安装包 + 创建 Release 上传附件 |

- **镜像 tag 跟随 `main/desktop/package.json` 的 version**（如 1.1.4），同时更新 `latest`。
- **Release 标签必须等于 `v<version>`**（如 `v1.1.4`），release.yml 里有校验，不一致直接失败。
- 手动触发（workflow_dispatch）release.yml 为测试模式：完整构建但不创建 Release，产物上传为 Artifact（保留 7 天）。

## 需要配置的 Repository Secrets

在 Gitea 仓库页面 → Settings → Actions → Secrets 添加：

| Secret | 用途 | 权限要求 |
|---|---|---|
| `REGISTRY_USERNAME` | runner 上 `docker login` 推镜像 | Gitea 用户名（如 `example`） |
| `REGISTRY_TOKEN` | 同上 | 具备 **package 写** 的 PAT |
| `RELEASE_TOKEN` | 创建 Release / 上传附件 | 具备 **repository 写** 的 PAT |

当前配置：`REGISTRY_TOKEN` 与 `RELEASE_TOKEN` 复用同一个 token（同 XINJE_Selection_Tool 的做法）。

PAT 创建：Gitea 右上角头像 → Settings → Applications → Generate New Token（fine-grained，勾选 package 写 + repository 写权限）。

## docker pull 拉取镜像（私有镜像，需先登录）

```bash
# 1. 登录（一次即可，凭证会保存）
docker login gitea.example.com -u example -p <token>

# 2. 拉取
docker pull gitea.example.com/example/example-wiki:latest
docker pull gitea.example.com/example/example-wiki:1.1.4

# 3. 部署（使用仓库 main/docker-compose.pull.yml）
docker compose -f docker-compose.pull.yml up -d
```

## 发版流程

1. bump 版本号：`main/desktop/package.json` 的 `version`（同时软件内显示的版本号）
2. 改动合并到 main 并推送：
   ```bash
   git push gitea main
   ```
   推送后 ci.yml 自动跑 verify 并把镜像推到 Registry（`:<version>` + `:latest`）
3. 打标签触发 Release（构建 exe + docker tar 并附到 Gitea Release）：
   ```bash
   git tag v<version>
   git push gitea v<version>
   ```

## Runner 前置要求

act_runner 以 Windows 宿主机模式运行（label `windows`，runner 即本机 DESKTOP-JQR7MEU），依赖 Docker Desktop 跑 Linux 容器：

- `docker`（构建镜像、运行 wine 打包容器；需可访问 Docker Hub / npmmirror）
- `git`（checkout 动作依赖）
- wine 容器内已含 Node；桌面端打包脚本在容器内自装 pnpm

**Z 盘不支持 bind mount**：CI 中所有容器构建均采用「源码 COPY 进镜像 + `docker create`/`docker cp` 拷出产物」方式，不使用 volume 挂载。

## 已知注意事项

- **Release 附件大小**：exe 约 100MB+、docker tar.gz 数百 MB。若上传返回 413，需在 Gitea `app.ini` 调大 `[attachment] MAX_SIZE`（默认较保守）后重启 Gitea。
- **runner 下载**：CI 在 runner 上联网下载依赖（pnpm registry、electron、prebuild 二进制、wine 容器镜像）属既定流程；本地开发机的下载申请限制不适用。
- **镜像与 compose**：本地开发 compose（`docker-compose.yml`）仍用本地构建镜像；生产 pull 部署用 `docker-compose.pull.yml`。
- **重复推送同版本号**：main 未 bump 版本号时重复推送会覆盖 Registry 上的同名 tag，属预期行为。
