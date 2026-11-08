# Gitea CI 与镜像分发指南

本项目通过 Gitea Actions（`https://github.com/jadesLL/Engram`）实现持续集成与 Docker 镜像分发：**推 `v*` 标签即一次完整发版**（verify → 镜像先 smoke 再推 `:<版本>` + `:latest` → 自动构建 exe/APK → 一次创建带附件的 Release → 同步公开仓库 GitHub 同名 Release），`workflow_dispatch` 只用于补发/补镜像/离线包/回填。

> 从源码构建安装包的完整指南（含不依赖 CI 的本地 Docker 构建路径、部署方式与 AI 操作清单）见 [`BUILDING.md`](./BUILDING.md)；本文聚焦 CI/CD 流水线本身的维护与历史踩坑。

## 日常工作流（总纲）

```text
开发（worktree）→ verify → **自动合并进 main** → 弹窗问用户：仅本地保留 / 推送 gitea / 推送并发版
→（合并时）新功能同步整合进根 README.md
→（推送）git push gitea main：CI verify（build+typecheck+test）+ 构建推送主分支滚动镜像 :main
→（发版准备，操作手册见 docs/RELEASE.md）node main/scripts/release/bump-version.mjs <版本> 一次改三处版本号
  → 把距上次发布的全部新功能写进 CHANGELOG.md 的 ## 未发布 区（每条带 [平台影响: X]）
  → node main/scripts/release/release-notes.mjs --render --write 生成 ## v<版本> 段落与安卓累积段
  → node main/scripts/release/verify-release.mjs --rehearse --strict 彩排 → 提交并立即推送
→ 打标签即完成发版：git tag v<版本> && git push gitea v<版本>
→ release.yml 自动（同一次运行）：版本/标签校验 → verify 门禁（build+typecheck+test，含发版就绪测试）→ 构建镜像并先 smoke（18099 /health，最多 90 秒）再推 :<版本> + :latest
  → 自动构建 Windows exe + Android APK → 组装 release-out + sha256 → 创建带附件的 Release（正文=CHANGELOG 段落 + 产物清单）
  → 同步 exe/APK/sha256 到公开仓库 GitHub 同名 Release（幂等，见「公开仓库产物同步」）
→（仅失败/历史版本按需）Actions → Release → Run workflow 单点补发：image=补镜像 / binaries=补 exe+APK / offline_image=离线包 / github_backfill=公开仓库回填
→ 部署机 docker login + docker pull 新版本镜像
```

**两条镜像通道**：`:latest`（+ 版本 tag）只在发版时由 release.yml 产出，是正式发版线；`:main` 由 ci.yml 在每次 main 推送后产出，是发版前的滚动测试通道（合 main 即更新，无需发版本号）。选择哪条由部署机在应用内「更新通道」配置决定，详见「应用内自更新」章节。

**铁律**：
- 功能验收通过后**自动合并进 main**（不再问是否合并，见根 [`AGENTS.md`](../../AGENTS.md) 规则 4/10）；**推送 gitea 与发版必须弹窗问用户**并拿到明确批准，未批准不推送、不 bump 版本号、不打 tag；用户选择暂不推送时允许本地暂时领先远端，下次任务前再确认补推。
- **只要更新版本号，提交后必须立即推送 gitea**（版本号 = 镜像 tag = Release 标签，留在本地会造成远端镜像与版本号脱节），并确认 Actions 运行成功。
- **版本 tag 与 :latest 只在发版时构建**（2026-08-20 起生效）：Registry 里的版本 tag 永远只对应发版产物，不会被日常推送覆盖。
- **`:main` 滚动镜像由 ci.yml 在 main 推送时构建推送**（2026-09-11 起生效，与 verify 同一 job、verify 通过后执行）：供测试部署跟踪主分支最新代码，不带版本语义（身份看烤入的 `/app/GIT_SHA`）。它是独立 tag，不触碰版本 tag 与 `:latest`，故不与「版本 tag 只在发版构建」冲突。
- **推 `v*` 标签 = 一次完整发版，三件套自动产出**（2026-11-09 起，取代 2026-09-27 的「推 tag 后必须手动 dispatch binaries」口径）：**Android APK + Windows exe + Docker 镜像（`:<版本>` + `:latest`）** 在同一次 tag 运行里构建；镜像先起容器 smoke（18099 `/health`，最多 90 秒）通过后才推 `:latest`；exe/APK 齐备并算出 sha256 后才创建**带附件的** Release——所以 Release 一旦存在就一定是三件套齐全的状态。失败/缺失时**不重推标签**，用单项 dispatch 补发（见「环节」表与 [`RELEASE.md`](./RELEASE.md) §6）。日常自用仍走源码模式与 Registry 镜像，只有用户明确提出才发版。**安卓端要补齐「距上次更新之间的全部更新内容」**：APK 必须基于本次发版提交构建、版本号与发版一致，发版说明里安卓部分要写全自上一个 Android 版本以来累积的改动（安卓端不能源码自更新，可能一次跨过多个版本）。
- **功能合并 main 时同步整合进根 `README.md`**；**发版说明由脚本生成**：新功能先写进 `CHANGELOG.md` 的 `## 未发布` 区（每条带 `[平台影响: A|B|C|D|E|F|none]`），发版时 `release-notes.mjs --render --write` 自动生成 `## v<版本>（YYYY-MM-DD）` 段落并附带「安卓端自上一版本以来的累计更新」小标题；release.yml 校验缺失即失败，段落自动发布为 Release 正文。
- **镜像烤入提交号**（2026-09-09 起，对齐 hermes-agent 的 build-file 路线）：release.yml 构建镜像时传 `--build-arg ENGRAM_GIT_SHA=<提交>`，写入镜像内 `/app/GIT_SHA`；镜像里没有 `.git`，应用内 设置 → 本机应用 → 版本信息（高级，默认收起）→「应用版本」靠它显示 `版本号 · 提交号`。本地 `docker compose up -d --build` 想显示提交号，先 `export ENGRAM_GIT_SHA=$(git rev-parse HEAD)`（不传则只显示版本号）。
- **发版必须过 verify 门禁 + 发版就绪检查**（2026-09-04 起；2026-11-09 起加脚本层）：release.yml 在构建任何产物前先跑完整 verify（build+typecheck+test），再在检出目录上用宿主 node 跑 `node main/scripts/release/verify-release.mjs --tag "$TAG" --strict`（tag 路径）或 `--rehearse`（dispatch 路径）——版本三处一致、CHANGELOG 段落与日期、未发布区已清空、安卓累计段齐全才算通过，`--strict` 下 WARN 也算失败。`ci.yml` 在每次推送/PR 上也会跑 `verify-release --rehearse --strict` 彩排（宿主机 node），所以问题在合 main 前就能发现。main 测试不红才能带标签发版（堵住 2026-08-27~08-30 main 连红期间 v1.1.22~v1.1.28 照常发版的缺口）。
- **发版必须过三端一致性门禁**（2026-11-02 起）：`bash main/scripts/platform-parity-check.sh --strict` 通过（版本号三处一致、能力位/原生桥/内嵌 Web 构建链、手机滞后清单目标版本清零），规范见 [`PLATFORM-PARALLEL-DEV.md`](./PLATFORM-PARALLEL-DEV.md)；verify 内部已包含 `web/src/lib/platformParity.test.ts` 契约检查。

| 环节 | 命令/动作 | 自动发生什么 |
|---|---|---|
| 日常推送 | `git push gitea main` | ci.yml：verify（build+typecheck+test）+ 构建推送滚动镜像 `:main` |
| 发版（tag 一步到位） | `bump-version.mjs <版本>` → 写 `## 未发布` 区 → `release-notes.mjs --render --write` → `verify-release.mjs --rehearse --strict` → `git push gitea main` → `git tag v<版本> && git push gitea v<版本>` | ci.yml 同时跑发版彩排；release.yml：版本/标签校验 → verify 门禁 + 脚本层门禁（宿主 node）→ 构建镜像并 smoke 后推 `:<版本>` + `:latest` → 自动构建 exe + APK → 组装 release-out + sha256 → 创建带附件的 Release（正文=CHANGELOG 段落 + 产物清单）→ 同步公开仓库 GitHub 同名 Release。三件套同一次运行产出 |
| 补充修复（按需 dispatch） | Actions → Release → Run workflow：输入标签并勾选 `image`（补镜像）/ `binaries`（补 exe+APK）/ `offline_image`（离线 tar.gz）/ 填 `github_backfill`（公开仓库回填） | 只做对应一项：image 与 tag 路径同一套 build→smoke→push；binaries 重建并补挂 Release（Release 不存在时一并创建）；产物同时上传 Artifact（保留 7 天）。**不重推标签**；提前验证 main 最新代码用 `:main` 通道（应用内一键更新）或 BUILDING.md 本地构建 |
| 历史版本回填（按需） | 手动触发 release.yml，`github_backfill` 填版本号列表（如 `1.2.0,1.3.0`）或 `all` | 从 Gitea Release 拉已有附件再传到公开仓库 GitHub 同名 Release；不构建产物、不碰 Release 正文 |
| 部署 | `docker login` → `docker compose -f docker-compose.pull.yml up -d` | — |

**版本号与发版说明（发版门禁，release.yml 有校验）**：
- tag 必须等于 `v<desktop/package.json 的 version>`（如 v1.1.6），不一致直接失败。
- **三处版本号由脚本一次同步**：`node main/scripts/release/bump-version.mjs <major/minor/patch/x.y.z>` 改写 `main/desktop/package.json` 的 `version`、`main/web/src/version.ts` 的 `APP_VERSION`、`main/docker-compose.yml` 的镜像 tag，写后回读校验；三处不一致时脚本直接失败并列出明细。
- **发版说明由未发布区生成**：仓库根 `CHANGELOG.md` 的 `## 未发布` 区按 `- [平台影响: X] 描述` 逐条维护；发版时 `release-notes.mjs --render --write` 生成 `## v<版本>（YYYY-MM-DD）` 段落（含「安卓端：自 v<上个版本> 以来的累计更新」）并把未发布区清空。release.yml 用 awk 提取该段落（段落标题行到下一个 `## ` 标题前），缺失直接失败；段落内容自动作为 Gitea Release 正文发布。
- **发版前彩排**：`node main/scripts/release/verify-release.mjs --rehearse --strict`（tag 后 CI 自动跑 `--tag --strict`），检查版本一致、CHANGELOG 段落、未发布区已清空、安卓累计段与标签匹配；`--artifacts <dir>` 模式还会核对 exe/APK/sha256 文件与哈希。

### 发版脚本速查（细节见 [`RELEASE.md`](./RELEASE.md)）

以下命令都在 `main/` 下运行（CLI 默认当前目录为应用源码根，可用 `--repo <dir>` 覆盖）：

| 脚本 | 用途 |
|---|---|
| `node scripts/release/bump-version.mjs <major/minor/patch/x.y.z>` | 一次改三处版本号并回读校验；`--dry-run` 只预览 |
| `node scripts/release/release-notes.mjs --check` | 校验 `## 未发布` 区条目格式（带 `[平台影响: X]`、描述非空） |
| `node scripts/release/release-notes.mjs --render --write` | 生成 `## v<版本>` 段落（含安卓累计段）并清空未发布区 |
| `node scripts/release/verify-release.mjs --rehearse [--strict]` | 发版彩排：版本一致 / CHANGELOG 段落 / 未发布区 / 安卓累计段；`--tag v<版本>` 供 CI 校验标签，`--artifacts <dir>` 核对产物哈希 |
| `node scripts/release/archive.mjs --tag v<版本> --from <dir> [--copy]` | 重算哈希并归档 `releases/<版本>/` 与带 schema 的 `release.json`（`--download` 可从 Gitea Release 拉附件） |

### 已有标签的 Android 构建环境修复

若标签应用源码无需改动，但 Android Dockerfile 的依赖源失效，可在 `release.yml` dispatch 的 `android_build_recipe_sha` 填入**本仓库完整的 40 位修复提交 SHA**（仅 dispatch 路径；tag 发版路径不使用该输入，直接用标签自带配置）。工作流只从该不可变提交取得 `main/mobile/Dockerfile.ci`；前端、Kotlin/Java、版本号和签名流程仍来自 `inputs.tag`。留空时完全使用标签自带配置。修复提交先完成验证并合入 main，再 dispatch 勾选 `binaries` 补产；在 `releases/<版本>/release.json` 记录应用标签提交与构建环境提交，不移动发布标签、不以 main 应用源码替代已发布版本。

## 源码版安装器发布（generic 包，独立于发版）

源码版安装器 `Engram-source-setup.exe` 是**引导器**：它的行为全在内嵌的
`install-engram.ps1` 里（clone 地址、内置 Node/pnpm 解压、依赖安装、构建桌面端），
需要在**发版之外**单独更新。因此它不挂 Release，而是发布到 Gitea generic 包的固定版本
`latest`——下载链接永不变，每次发布覆盖同名文件。

安装器 exe 现在**内置 Node 22.20.0（便携 zip）与 pnpm 10.20.0**（`resources\runtime\`，由
`installer/scripts/prepare-runtime.js` 在打包前生成）：客户机安装不联网下载 Node、也不执行
`npm install`，避开 Node 22 的 npm.ps1 吞参数（`Unknown command: "file"`）与 pnpm 版本漂移。
内置运行时约 43MB，安装器 exe 因此增大约 40MB；从仓库直接跑脚本（无内置运行时）才退回旧下载路径。
引擎脚本头部的 `# ENGINE_VERSION` 会被 GUI 用来和克隆里的旧引擎比大小：**旧克隆引擎不能盖掉
新 exe 里的修复**（2026-11-06 客户机事故：换了引擎仍跑旧克隆脚本，继续报同一条错）。

```bash
# 本地构建并发布（需 package 写权限的 Gitea 令牌）
# 在**主检出目录**做：打包依赖主检出的 node_modules 与 desktop 的 electron 运行时，
# worktree 内没有依赖、无法打包（同 Windows 桌面端打包，属宿主机原生任务）。
cd main
node node_modules/pnpm/bin/pnpm.cjs -C installer dist    # 构建（dist 会先跑 prepare-runtime.js 准备内置 Node/pnpm）
ENGRAM_GITEA_TOKEN=<令牌> node installer/scripts/publish-installer.js
```

- **固定下载链接**（写进 README，永不失效）：
  `https://github.com/jadesLL/Engram/releases/download/installer-latest/Engram-source-setup.exe`
  （generic 包下载走 API 路径 `/api/packages/...`，不是仓库 UI 路径；该包为公开包，无需登录）
- **clone 地址直接写真实值**：`install-engram.ps1` 的 `$RepoUrl` 默认就是本仓库真实地址，
  克隆仓库时一并拿到，无需任何打包期注入。全新机器装失败第一步先查这里：
  `grep RepoUrl` 包内 ps1 应显示真实域名。
- **覆盖发布后无需改 README**（链接固定）；只有包名/版本槽位改动才动链接。
- **发布后验证按下一节「大产物下载与验证」执行**（默认 IPv6 优先，禁止 `curl -4`）。

### 两个必须记住的坑（都有回归测试锁死）

1. **含中文的 `.ps1` 必须有 UTF-8 BOM**。Windows PowerShell 5.1 读无 BOM 的 UTF-8 文件时
   按系统 ANSI（简体中文是 GBK）解码，中文串里的字节会吃掉后续引号 → 整脚本 ParserError
   （2026-09-10 实测：`install-engram.ps1` 丢 BOM 后 19 处解析错误、安装器完全无法运行；
   开源清洗提交 86c6a39 曾误删该 BOM）。`installer-error-capture.test.js` 会检查。
2. **`$ErrorActionPreference='Stop'` 下不要用 `2>&1` 收子进程 stderr**。它会把子进程的
   首行 stderr 当终止性异常，导致 git clone 失败只留下 `Cloning into ...`、真正的 `fatal:`
   行与退出码全丢，用户看到的报错被误导成「请检查账号密码」。`Invoke-Logged` 已在函数内
   临时降级为 `Continue`，并用 `Pick-ErrorLine` 取 `fatal:`/`ERR_PNPM_*` 关键行（不取末行）。

## 大产物下载与验证（IPv6 优先，不要写 `curl -4`）

发布后验证、回填产物、给客户机取安装包都要从 Gitea 下 100MB 级文件。同一域名两族的实测差距极大（2026-11-06，开发机）：

| 协议族 | 单流速度 | 130MB 安装器耗时 |
| --- | --- | --- |
| IPv4 | 0.56–0.80 MB/s（4 并发合计约 1.4 MB/s） | 约 8 分钟 |
| IPv6 | 46–61 MB/s | 约 3 秒 |

统一用 `main/scripts/download-artifact.cjs`：默认 **IPv6 优先 → 失败回退 IPv4**，每个协议族可重试，证书校验不变；**不要再写 `curl -4` / `-6` 或任何固定地址族的命令**。

```bash
# 发布后验证（sha256 不符会保留 .part 并以退出码 3 失败）
node main/scripts/download-artifact.cjs \
  --url https://github.com/jadesLL/Engram/releases/download/installer-latest/Engram-source-setup.exe \
  --out "$TEMP/Engram-source-setup.exe" --sha256 <sha256>

# 先看会走哪一族、解析到什么地址（不发请求）
node main/scripts/download-artifact.cjs --url <URL> --out <文件> --dry-run
```

- 成功最后一行固定格式，可直接 grep 断言：`DONE family=IPv6 remote=<IP> bytes=<n> time=<s> speed=<MB/s> sha256=<hex>`。
- 没有 IPv6 出口的机器（客户机、纯 IPv4 网络）自动回退 IPv4，行为与以前一致；排查时才用 `--family ipv6|ipv4`，DNS 不可用或要固定地址用 `--resolve 主机=地址`（可重复）。
- 私有 Release 附件用 `--header "Authorization: token <令牌>"`；令牌别留在 shell 历史里。
- 退出码：`0` 成功 / `1` 下载失败 / `2` 参数错误 / `3` sha256 不匹配 / `4` 输出已存在（加 `--force`）。
- **反面案例**：2026-11-06 19:20 的安装器发布验证脚本把每个 curl 都写成 `-4`，130MB 下了约 8 分钟（约 270 KB/s）；同一个文件换 IPv6 后 3 秒。**这不是网络问题，是命令写死了地址族。**
- 回归测试：`node --test main/scripts/download-artifact.test.cjs`（已挂在 `pnpm test` 链上，离线可跑）。

## 镜像地址（重要）

```bash
# 正确：三层路径 example/engram/engram（owner/repo/imagename，镜像归属 Engram 仓库）
gitea.example.com/example/engram/engram:<版本>

# 错误：两层路径 example/engram（归属用户命名空间）——1.1.5 曾用此路径，NAS 实测拉取异常，已废弃
```

部署示例：

```bash
# Docker 镜像未公开发布（原私有 Registry 不对外）
docker pull gitea.example.com/example/engram/engram:1.1.5
docker compose -f docker-compose.pull.yml up -d
```

部署 compose 注意：
- **不要写 `pull_policy: never`**——它禁止从 Registry 拉取，本地无镜像时必报"找不到镜像"（NAS 首次部署曾因此误判为拉取失败）。
- onlyoffice 若第三方镜像源拉不动，换官方 `onlyoffice/documentserver:9.4.0`。

## 应用内自更新（设置 → 版本与更新 → 服务器更新）

1.1.6 起支持网页内一键更新，服务器与桌面端共用「Gitea Releases」作为版本信号源。

### 一次性引导（Docker 部署机）

在 `docker-compose.pull.yml` 的 engram 服务 volumes 中确认有 docker.sock 挂载（模板已内置）：

```yaml
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock   # 应用内更新所需
```

然后 `docker compose -f docker-compose.pull.yml up -d` 重建容器一次。之后所有更新都可以在网页 设置 → 版本与更新 → 服务器更新 中完成，无需再登录部署机。

### 仓库与更新通道配置（设置 → 版本与更新 → 更新源配置）

所有配置保存在**服务器数据目录的 `.env` 文件**（Docker 内 `/data/.env`，随数据卷持久化，不进数据库不进代码库）：

| 配置项 | 键 | 说明 |
|---|---|---|
| Gitea 服务地址 | `UPDATE_GITEA_URL` | 版本检测来源，如 `https://gitea.example.com` |
| Gitea 仓库 | `UPDATE_GITEA_REPO` | `owner/name` 形式 |
| Gitea 访问凭据（二选一） | `UPDATE_GITEA_TOKEN`（访问令牌），或 `UPDATE_GITEA_AUTH_TYPE=password` + `UPDATE_GITEA_USERNAME` / `UPDATE_GITEA_PASSWORD`（用户名密码） | **公开仓库无需填写**；私有仓库需能读 Release |
| 更新通道 | `UPDATE_IMAGE_TAG` | 跟踪的镜像 tag：`latest` 正式发版线（默认）、`main` 主分支滚动构建（发版前测试用）。未配置时按当前容器镜像自动判断（跑在 `:main` 就继续跟 main，版本号 tag 回退 latest） |

**镜像地址与拉取凭据无需配置**：地址从当前容器镜像名推导（部署时 compose/`docker pull` 写了什么，这里就读回什么）；拉取私有 Registry 的凭据由宿主 Docker 守护进程持有（容器挂了 `/var/run/docker.sock` 时，拉取与 digest 查询都经守护进程完成，用它 `docker login` 的登录态）。

私有化部署用户把 Gitea 地址/仓库换成自己的即可。

### 测试通道：跟随主分支最新代码

不想为每个小修复发版、只想到手验证时，把部署机切到 `:main` 通道：

1. 设置 → 版本与更新 → 服务器更新 → 「更新通道」选 `main`（顶部常规设置行，改动即存）。
2. 之后每次 main 推送，ci.yml 都会重推 `:main` 镜像；页面点「立即更新」即拉到主分支最新代码。
3. 版本号在这条通道上**不变**（版本号只在发版时 bump），判断更新是否落地看 设置 → 本机应用 → 版本信息（高级，默认收起）→「应用版本」的**提交号**，与「检查更新」结果一致。

切回正式发版线：更新通道选 `latest`（或留空自动），保存后重新点「立即更新」把容器换成 `:latest` 镜像。

> `:main` 是移动 tag，同一提交号每次都覆盖重推；它不是发布产物，不应作为长期部署基线。发版后请回到 `:latest`。

### 更新流程与安全机制

- **检查更新**：比对 Gitea 最新 Release 版本号 + Registry 目标 tag 的 digest（两者取或）。`main` 通道下 Release 版本号与本地相同，故实际由 digest 驱动，提示为「主分支镜像有更新」。进入应用约 3 秒后自动检测一次，之后自适应退避复查（连续没发现更新时 2→5→10→30→60 分钟逐级拉长，有更新待处理时每分钟复查；发现更新或切回前台/网络恢复立刻回到最短间隔），有新版本时侧栏设置按钮出现红点、右上角亮起一枚绿色更新图标（不自动弹出面板，鼠标扫到才展开更新内容）。
- **一键更新（Docker）**：绿色更新图标展开后的「立即更新」或设置页的「立即更新」都直接执行下面这套流程（不再跳转/二次确认）：拉取目标 tag（默认 `latest`，可切 `main`）镜像 → 用旧镜像临时起 switcher 容器接管 → 旧容器改名 `engram-old` → 按原容器配置（端口/卷/网络/环境变量全保留）创建新容器 → 停旧起新 → 等新容器健康（最长 180s）→ 健康则删旧容器；**新容器起不来则自动回滚**重启旧容器。前端提交后轮询 `/health` 等新容器起来再自动刷新页面。
- **桌面端更新**：绿色更新图标展开后的「立即下载并安装」或设置页的「下载并安装」都是全自动：下载 Release 的 exe 安装包（带进度条）→ 静默安装覆盖 → 应用自动重启；源码模式则走「立即更新并重启」（增量拉源码 + 重建 + 自动重启）。
- 手动恢复（极端情况 switcher 也失败）：`docker start engram-old`，然后浏览器刷新。

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
| `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | APK release 签名（见 [`ANDROID.md`](./ANDROID.md)）；**未配置时发版直接失败**（2026-10-12 起：未签名 APK 装不上，不再回退未签名包当正式产物） | 本机 keystore，不入库 |
| `PUBLIC_MIRROR_TOKEN` | 同步产物到公开仓库（GitHub）Release（也是 Public Mirror 推送用的那把） | GitHub fine-grained PAT，**Contents: Read and write** |

对应 Variable（Public Mirror 已在用同一份）：`PUBLIC_MIRROR_REPO_URL` = `https://github.com/<账号>/Engram.git`。

### 发版踩坑（2026-09-28 v1.3.0 实测，两条都会让「镜像已推、Release 没建」）

1. **`RELEASE_TOKEN` 失效 = Release 步骤 401**：症状是 `release.yml` 走到「创建 Release」时 `ApiError: Unauthorized`（`invalid username, password or token`），而镜像**已经推成功**（推镜像用 `REGISTRY_TOKEN`，是另一把 token）——于是 registry 里 `:<版本>` 与 `:latest` 都到位、Release 却是空的、APK/exe 也没构建。修法：仓库 Settings → Actions → Secrets 重新生成 `RELEASE_TOKEN`（需 **write:repository**；`REGISTRY_TOKEN` 是 package 写权限，两把不能混用），然后 Actions → Release → Run workflow 输入该标签、勾 `binaries` 补发 Release 附件（Release 不存在会一并创建）；镜像也缺时再勾 `image` 补推。补发不重推标签。
2. **CHANGELOG 段落不能撑爆提取步骤的管道**：提取段落那步末尾曾用 `echo "$BODY" | head -5` 预览，段落超过管道缓冲（64 KiB）时 `head` 提前退出、写端收到 SIGPIPE，整个 release 任务以 **exit 141** 失败（v1.3.0 的 72 KiB 段落首次触发；此前各版本段落只有几 KiB 所以从未暴露）。已改为逐行读到第 5 行即停、全程不经管道——段落再长也不会再踩。

## 公开仓库产物同步（GitHub，2026-09-30 起）

GitHub 上的仓库是私有仓库的**脱敏快照**（见 [`PUBLIC-MIRROR.md`](./PUBLIC-MIRROR.md)）：正文与标签由 public-mirror 同步，但**附件没人搬**——所以此前每个公开 Release 只有 GitHub 自动附带的源码包（`Source code (zip/tar.gz)` 是 git 快照，不是安装包）。

现在由 release.yml 补上这一步，脚本 `main/scripts/sync-public-release-assets.py`：

- **发版即同步**：tag 发版路径自动把 `release-out/` 里的 exe / APK / sha256 传到 GitHub 同名 Release（`v<版本>`）；dispatch 勾选 `binaries`（补发场景）时同样同步。
- **历史回填**：dispatch 时填 `github_backfill`（如 `1.2.0,1.3.0` 或 `all`），从 Gitea Release 拉已有附件再传过去；Gitea 侧没有附件的版本会被跳过并在日志里列出（当初「二进制按需分发」的窗口内发版的版本就是这种情况）。
- **脚本从哪来**：dispatch 按 `inputs.tag` 检出的是**历史标签**，而本脚本 2026-09-30 才进仓库——旧标签的树里没有它。所以 dispatch 时先跑一步「公开同步脚本就位」：标签树里有就用标签自带的，没有就用 API 从 `main` 取一份（v1.3.3 回填时踩到过 `No such file or directory`）。tag 发版路径检出的就是当前标签，脚本一定在树里，不需要兜底。
- **幂等**：同名附件大小一致就跳过，大小不同才删旧重传；重复触发不会重复上传 170MB 的 exe。
- **不碰正文**：公开 Release 正文由 public-mirror 用**已脱敏的 CHANGELOG** 填写；CI 只在 Release 不存在时建一个空正文的壳，绝不把私有 CHANGELOG 正文带过去。
- **目标非 github.com 时自动跳过并返回 0**（与 make-public-snapshot.sh 的判定一致），本地验证可用 `SYNC_DRY_RUN=1`。
- **产物补传 / 修复**：`Actions → Repair Public Release`（`.gitea/workflows/repair-public-release.yml`）输入标签即可把 Gitea Release 里已有、但公开仓库缺的附件补传过去；它不构建产物、不碰 Release 正文，脚本以 `main` 上的修复件为准。适用场景：发版同步步骤网络中断（2026-11-07 v1.5.8 的 305MB exe 上传被 `ssl.SSLEOFError` 中断），或历史上遗留的缺附件版本。
- **判重与重试**：GitHub 会把附件名里的空格规整成点（`Engram 1.5.8.apk` → `Engram.1.5.8.apk`），脚本按「规整后同名 + 同大小」判重（否则已存在附件会被当缺失、重复上传撞 422 `already_exists`）；上传遇网络错误自动重试 3 次，4xx 不重试。

> 这些二进制是**公开发布**的：发版前必须确认产物里没有私有信息（内网地址、域名、凭据）。构建侧现有两手防护——`server/dist` 不再产出 `*.test.js`（`tsconfig.build.json`），`prepare-desktop.js` 复制时再过滤一次测试文件；设置页的示例地址一律用 `192.168.x.x` 这类文档式写法。

## Runner 环境约束（Windows 宿主机模式）

act_runner 以 Windows 宿主机模式运行（label `windows`），Docker 命令经 Docker Desktop 跑 Linux 容器。由此产生的四条硬约束（都踩过，详见下文踩坑记录）：

1. **所有 run 步骤显式 `shell: bash`**——Windows runner 默认是 pwsh/cmd。
2. **`MSYS_NO_PATHCONV: '1'` 必须设**——Git Bash 会把 docker 参数里的 `main` 转成 `C:/Program Files/Git/main`。它只管参数转换；**docker build 的上下文路径仍必须 `cd main && docker build .`**（相对 cwd），传 `main` 参数会被 docker CLI 按错误路径解析。
3. **Docker Hub 直连不通**——`desktop/Dockerfile.ci` 基础镜像固定走 DaoCloud 镜像源 `docker.m.daocloud.io/electronuserland/builder:wine`；其他基础镜像靠本机缓存。
4. **Z 盘不支持 bind mount**——CI 里容器构建一律「源码 COPY 进镜像 + `docker create`/`docker cp` 拷出产物」，不用 volume 挂载。

### 当前 Runner 部署（2026-08-23 迁移：OLD-DEV-PC → DEV-PC）

| 项 | 值 |
|---|---|
| 机器 | 开发机 DEV-PC（Windows，Docker Desktop Linux 引擎） |
| 安装目录 | `C:\Users\example\gitea-runner\`（gitea-runner.exe v3.3.0 + config.yaml + .runner） |
| 注册方式 | **全局（instance 级）**，当前在线 runner id=4，name `dev-pc-scnml1a`，labels `windows:host`——Engram 与 Example_Selection_Tool 的 CI 都由它执行（旧 id=3 `dev-pc-bbo2mil` 已离线闲置，确认无用后可在管理页删除） |
| 启动 | `gitea-runner.exe daemon --config config.yaml`。登录自启：HKCU Run 项 `EngramGiteaRunner` → `powershell -File runner-watchdog.ps1`（非管理员账户也能写）；再加计划任务 `GiteaRunnerWatchdog` 每 5 分钟重试（登录触发任务在当前非管理员账户下注册会「拒绝访问」，用 Run 键顶替即时拉起）。2026-11-08 起「启动」文件夹里的 `gitea-runner.cmd` / `gitea-runner-watchdog.cmd` 已停用并备份到 `startup-backup\` |
| 看门狗 | `runner-watchdog.ps1`（幂等；命名互斥量 `Global\EngramGiteaRunnerWatchdog` 防登录瞬时双启）：PATH 前置 `C:\Program Files\Git\bin`、`DOCKER_CONTEXT=default`，进程不在即拉起 daemon 并记 `runner-watchdog.log`；计划任务每 5 分钟跑一次，覆盖进程崩溃、开机竞态与 Docker 晚就绪。注意 **runner 上线 ≠ 能跑 job**：Docker Desktop 未就绪时 job 会失败 |
| config.yaml 关键项 | `container.docker_host: npipe:////./pipe/dockerDesktopLinuxEngine`（Windows 下 runner 默认探测 /var/run/docker.sock 失败，必须显式指向 Docker Desktop 的 Linux 引擎命名管道）；日志级别 debug（排查认领问题用，平时可调回 info） |

**迁移踩坑（旧机下线后 CI 全部排队无人认领）**：
- 旧 runner（id=1 dev-pc / id=2 仓库级 dev-pc）已于 2026-08-23 删除；注意 **runner 注册有作用域**——用仓库页 token 注册的 runner 只服务该仓库（曾导致 Engram CI 排队 6 小时无人认领而 另一示例仓库 正常），必须用全局管理页（`/-/admin/actions/runners`，注意 `/-/` 前缀）的 Registration Token 注册。
- 管理页「创建新运行器」是**下拉菜单**，Registration Token 直接嵌在菜单的只读输入框里（页面 HTML 即含，无需点击交互）。
- 派发卡死恢复：任务派给已下线 runner 的会永久排队，推送一个空提交（`git commit --allow-empty`）触发新 run 即可被在线 runner 认领。

**自愈链路踩坑（2026-11-08：重启后 runner 长期离线）**：
- 两个「启动」文件夹入口（`gitea-runner.cmd` + `gitea-runner-watchdog.cmd`）同时拉起 daemon，第二个实例抢 `.runner` 锁报 `runner file is already locked by another process` 退出；先起的实例随后也退出，而常驻看门狗循环进程没活下来——于是重启后 runner 一直离线、CI 只能排队。修复见上表「启动 / 看门狗」：入口收敛为 HKCU Run + 计划任务共用一个幂等 watchdog 脚本（互斥量防并发），旧 `.cmd` 备份到 `startup-backup\`。
- 运维检查三件套：`Get-Process gitea-runner`、`Get-ScheduledTask GiteaRunnerWatchdog`、`Get-Content runner-watchdog.log -Tail 5`。
- GitHub 公开镜像 job 从 `gitea.com` 拉 `actions/checkout`；该源 504 时 mirror 会在 21 秒内失败（重跑即可，与代码无关）。

## wine 交叉打包关键坑（desktop/Dockerfile.ci + scripts/build-desktop-ci.sh）

Linux 容器里交叉打 Windows exe 的三个必踩坑，脚本已内置修复，改动打包流程前必读：

1. **`electron-builder --config.npmRebuild=false`**：EB 内置 @electron/rebuild 会按**当前平台（Linux）**重编原生模块，覆盖预放的 win32 二进制——打出的 `better_sqlite3.node` 是 Linux ELF，exe 能装但本地模式 dlopen 必崩。
2. **`prebuild-install --platform win32`**：prebuild-install 默认按当前平台拉预编译，必须显式指定 win32。脚本内有 **MZ 头断言**（PE32 检查），非 Windows 二进制直接 fail，防止回归。
3. **打包前删 `server/node_modules` 的 `.bin` 目录与悬空 symlink**：`--prod` 安装后 `.bin` 里残留指向 devDeps 的悬空链接，NSIS 的 7za 扫描到会报 exit 1。
4. **预编译 ABI 必须由「本次实际打包的 Electron 版本」推导**（2026-09-28 v1.3.0 事故根因）：脚本原先写死 `electron-v133`（写死时的 Electron 是 35），而 9-16 已升到 Electron 36（需要 ABI 135）。CI 一路全绿，发布出去的 1.3.0 exe 里 `better_sqlite3.node` 却是 ABI 133 —— 内嵌 server 一启动就 `ERR_DLOPEN_FAILED`（`NODE_MODULE_VERSION 133 vs 135`）退出，桌面端只显示「本地服务启动失败：启动超时或内嵌服务异常」，**所有装了 1.3.0 的机器都进不去主界面**（1.2.5 及更早是 Electron 35 + ABI 133，同款预编译恰好正确）。现在：版本取 `desktop/node_modules/electron/package.json` → `desktop/scripts/lib/electron-abi.js` 推 ABI（内置表兜底、node-abi 可用时以它为准，未知主版本直接 fail）→ 下载对应 `electron-v<ABI>` 预编译 → `desktop/scripts/verify-packaged-abi.js` 静态校验（读 `.node` 里的 `node_register_module_v<ABI>` 符号，不运行它）预编译本身与 `dist/win-unpacked` 收包后的 binding。**教训：构建期「没报错」不等于产物可用**——原生模块 ABI 失配在打包阶段完全静默，只能靠产物断言兜住。

打包端到端验证标准（每次构建 exe 时必做；tag 发版 / dispatch 补发构建与本地打包同标准）：
```bash
# 1. 产物二进制平台正确
file desktop-dist/win-unpacked/resources/app.asar.unpacked/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node
# → 必须是 PE32+ executable for MS Windows
# 1.5 原生模块 ABI 与打包的 Electron 一致（静态读符号；CI 与 pack-asar 已内置，这里是独立复核）
node desktop/scripts/verify-packaged-abi.js --app-dir desktop-dist/win-unpacked
# 2. fork server 起服务
cd desktop-dist/win-unpacked && ELECTRON_RUN_AS_NODE=1 "./Engram.exe" resources/app.asar/server/dist/index.js &
curl http://localhost:18080/health   # → 200
# 3. asar 内版本号
grep -c '<版本号>' app.asar 二进制内容（或查 staging package.json 的 version 字段）
```

## 已知注意事项

- **CI 并发取消（2026-11-08 起）**：`ci.yml` 与 `public-mirror.yml` 加 `concurrency`（按 `github.ref` 分组、`cancel-in-progress: true`），同分支连续推送只跑最新一次，旧 run 自动取消（Gitea 1.26+ 支持 workflow concurrency，本实例 1.27.1）。`release.yml` 故意不加，避免取消进行中的发版。
- **Public Mirror 触发方式（2026-11-08 起）**：不再随每次 `main` 推送运行——它与 CI 共用同一台单并发 runner（`capacity: 1`，全局共享），每次 push 都要多排 2 分钟以上；改为**每天 18:30 UTC 定时 + `v*` 标签推送 + 手动 dispatch**。要立即同步公开仓库：Actions → Public Mirror → Run workflow。日常一次 push 只触发 CI（verify + `:main` 镜像）。
- **减少排队**：多个提交尽量攒成一次 `git push gitea main`，一次 push 只产生一个 CI run；`release.yml` 的 tag 发版（镜像 smoke + exe + APK）动辄 40 分钟以上，属发版专属，不要与日常推送混在同一时段；dispatch 补发同样会占用单 runner。
- **Release 附件大小**：tag 发版一次性挂 exe/APK/sha256（exe 约 110MB、部分版本 300MB 级），离线 tar.gz 约 160MB。上传返回 413 时需调大 Gitea `app.ini` 的 `[attachment] MAX_SIZE` 后重启 Gitea。
- **镜像只随发版更新**：main 日常推送不构建镜像（2026-08-20 起）；Registry 版本 tag 只对应发版产物（tag 路径自动构建；dispatch 只有勾选 `image` 补镜像时才构建推送，其余 dispatch 只补二进制产物）。发版前想提前验证 main 最新代码需本地构建（BUILDING.md 路径 B/C）。
- **本地开发 compose**（`docker-compose.yml`）仍用本地构建镜像；生产 pull 部署用 `docker-compose.pull.yml`。
- **Gitea secrets API** 字段名是 `data` 不是 `value`（PUT `/api/v1/repos/{owner}/{repo}/actions/secrets/{name}`，`{"data":"..."}`），用错报 422 "[Data]: Required"。
- **发版产物产出方式（2026-11-09 起）**：**tag 路径自动产出三件套并创建带附件 Release**；dispatch 只做单点补发——`image` 补镜像（先 smoke 再推 `:<版本>` + `:latest`）、`binaries` 补/重跑 exe+APK 并补挂 Release、`offline_image` 补离线 tar.gz、`github_backfill` 回填公开仓库。产物同时上传 Artifact 页（保留 7 天）。补发**不重推标签**（禁止移动已推标签）。
- **APK 依赖烘焙**（2026-09-04 起，tag 自动构建与 dispatch 补发走同一条链路）：`mobile/Dockerfile.ci` 构建期预热 gradle 发行版、maven 依赖与 `build-tools;34.0.0`（AGP 8.7 默认版本，镜像只装 35 时 run 期会现下载）到 `/opt/gradle-home`，消除发版时对 services.gradle.org / maven 中央仓库的运行时网络依赖。`build-apk-ci.sh` 检测到预热标记（`.warm-ok`）优先 `--offline` 构建，失败自动回退在线构建；预热层失败不阻塞镜像构建（行为与旧版一致）。

## 历史版本与镜像路径变更记录

| 版本 | 镜像路径 | 说明 |
|---|---|---|
| 1.1.4 / 1.1.5 初版 | `example/engram`（两层） | 用户命名空间归属；1.1.5 发布时 NAS 拉取异常 |
| 1.1.5 起 | `example/engram/engram`（三层） | 仓库归属，与 Example_Selection_Tool 同款形式，NAS 拉取正常 |

旧两层路径的镜像仍留在 Registry（`1.1.4`、`1.1.5`），但不再更新；新发版全部走三层路径。
