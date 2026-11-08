# Engram 发版手册（RELEASE）

> 本文是发版操作的唯一操作手册；流程设计背景与 DSH 对照见 [DSH 发版逻辑调研](.tmp-release-research/REPORT.md)（仓库外临时目录）与 [GITEA-CI](./GITEA-CI.md)。
> 约定：所有命令在**仓库根**或 `main/` 下执行；脚本路径相对 `main/`。发版是显式动作，推送 gitea 与打 `v*` 标签都必须先拿到用户明确批准（见根 [`AGENTS.md`](../AGENTS.md) 规则 4/8/9）。

## 0. 一页纸

```bash
# ① 发版前：三端对齐 + 版本号 + 发版说明（全部脚本化）
bash main/scripts/platform-parity-check.sh --strict --since v1.5.10   # 手机滞后清单清零 + 平台影响声明审计
cd main
node scripts/release/bump-version.mjs 1.5.11                          # 三处版本号一次改完
node scripts/release/release-notes.mjs --check                        # 未发布区格式检查
node scripts/release/release-notes.mjs --render --write               # 生成 ## v1.5.11 段落 + 安卓累积段
node scripts/release/verify-release.mjs --rehearse --strict           # 发版彩排（与 CI 同一套检查）

# ② 提交并推送（需用户批准）
git add -A && git commit -m "release: prepare v1.5.11"
git push gitea main

# ③ 打标签（需用户批准）→ CI 自动完成三件套 + Release
git tag v1.5.11 && git push gitea v1.5.11

# ④ 发版后：归档收据 + 公开仓库核对 + 三端验证
node scripts/release/archive.mjs --tag v1.5.11 --download --copy
```

一次 `v*` 标签会跑完整条链路（约 50–70 分钟，排队另计），不需要再手动 dispatch：

```
tag 推送
  └─ verify 门禁（build + typecheck + test，含 scripts/release 发版就绪测试）
  └─ 版本/说明校验（verify-release --tag v1.5.11 --strict）
  └─ 构建镜像 :1.5.11 → 起容器打 /health smoke → 通过后推 :1.5.11 + :latest
  └─ 构建 Windows exe（wine 容器）+ Android APK（签名）
  └─ 组装 release-out（exe / apk / sha256）并上传 Artifact（保留 7 天）
  └─ 创建 Gitea Release（正文 = CHANGELOG 段落 + 产物清单，附件 = 三件套）
  └─ 同步 exe/apk/sha256 到公开仓库（GitHub）同名 Release
```

## 1. 设计：为什么这样做

| 原则 | 做法 | 解决的问题 |
| --- | --- | --- |
| 版本单源 | `bump-version.mjs` 一次改 `desktop/package.json` / `web/src/version.ts` / `docker-compose.yml` 并回读校验 | 手工同步三处容易漏（2026-11-08 前的 R6） |
| 彩排前置 | `ci.yml` 在每次推送/PR 上用宿主 node 跑 `verify-release --rehearse --strict`（同一套脚本；Docker verify 内的 `readiness.test.mjs` 在没有仓库根 CHANGELOG 时自动跳过） | 发版当天才发现 CHANGELOG 缺失或格式错（R5） |
| 说明机器化 | 未发布区条目带 `[平台影响: X]`，`release-notes.mjs` 生成版本段 + **安卓累积段** | 规则 9 的安卓累积说明零校验（R4） |
| tag 即发版 | 标签触发全链路，一次创建带附件的 Release | 第二次人工 dispatch 漏勾也全绿（R1） |
| 发布收据 | `archive.mjs` 重算 sha256、生成带 schema 的 `release.json` | 归档靠一次性脚本、无 schema（R2/R10） |

## 2. 日常开发：写「未发布区」

发版说明不再手写整段，而是**合并功能时在 `CHANGELOG.md` 顶部的 `## 未发布` 区加一行**，发版时脚本聚合：

```md
## 未发布

### 新增

- [平台影响: B] 设置页支持导出诊断包（#412）
- [平台影响: A,F] 手机端新增离线队列重试（#418）

### 修复

- [平台影响: none] 修复登录页在 401 后无限重定向
```

规则：

- 每条必须以 `- [平台影响: X] ` 开头；X 取 `A–F` 或 `none`，跨类用逗号：`[平台影响: B,F]`。含义见 [PLATFORM-PARALLEL-DEV](./PLATFORM-PARALLEL-DEV.md) §4.1。
- 分类用 `### 新增` / `### 修复` / `### 体验优化` / `### 内部` 等 `### 标题`，没有分类会归到「其他」。
- 一条对应一个用户可感知的变化；纯 CI/文档改动写 `none`。
- 提交信息末行仍按规则写 `平台影响: ...`（两者保持一致）。
- 只写「本版本新增」；**安卓累积段由脚本从历史段落自动汇总，不要手写**。
- **首次使用本流程时**：此前已经合入 main、但没在「未发布区」登记过的提交（含 v1.5.10 之后的全部改动），发版前必须先人工补登成条目，否则版本段落会漏内容；之后按「合并即登记」执行。

## 3. 发版准备（约 15–30 分钟）

### 3.1 前置门禁

```bash
bash main/scripts/platform-parity-check.sh --strict --since v1.5.10
```

- `--since` 传「上一次发版 tag」；**不传时脚本会自动取最近 tag**（本次改造起），不再出现「带 --strict 但审计整段没跑」的空转。
- 同时人工确认 `main/docs/MOBILE-SYNC-LEDGER.md` 里「目标版本 = 本次版本」的待办已清零。

### 3.2 改版本号

```bash
cd main
node scripts/release/bump-version.mjs --dry-run 1.5.11   # 先看会改什么
node scripts/release/bump-version.mjs 1.5.11
```

- 参数支持 `major|minor|patch` 或显式版本（显式版本必须大于当前版本）。
- 一次改三处并回读校验，输出 diff 与下一步命令。
- 三处来源不一致时**直接失败**并列出各自值，不会带着漂移继续。
- `docker-compose.yml` 的镜像 tag 只是本地 compose 用，但属于三端契约测试的一部分，必须同步。

### 3.3 生成发版说明

```bash
node scripts/release/release-notes.mjs --check          # 未发布区逐条格式检查（无未发布区只会 WARN）
node scripts/release/release-notes.mjs --render --write  # 生成 ## v<版本>（YYYY-MM-DD）段落
```

生成内容：

1. `## v1.5.11（YYYY-MM-DD）` 段落，按 `### 分类` 聚合未发布区条目（保留 `[平台影响: ...]` 标记）；
2. `**安卓端：自 v<上一版本> 以来的累计更新**` 小节：
   - 区间只有本版本时输出「本版本包含自 v<上一版本> 以来全部安卓相关更新（见上）。」；
   - 区间跨多个版本时按版本分组列出所有 A/C/D/F 条目；
3. 清空 `## 未发布` 区（只留标题和模板注释）。

可选项：

| 参数 | 说明 |
| --- | --- |
| `--version <v>` | 覆盖版本（默认取 `desktop/package.json` 当前值） |
| `--date YYYY-MM-DD` | 覆盖日期（默认本地今天） |
| `--android-base <vX>` | 安卓累积基线；默认 = 未发布区下方第一个已发布版本。**若上一次发布没有产出 APK，必须手动指定**（如 `--android-base v1.5.6`） |
| `--summary "<文字>"` | 在版本段落顶部插入一段导语 |
| `--write` | 真正写盘；不加则只打印预览 |

> 生成后**人工扫一遍**：脚本保证格式与区间覆盖，不保证文案通顺；需要补充的句子直接编辑该段落（在 `## 未发布` 与下一个 `## ` 之间的版本段落内改）。

### 3.4 发版彩排

```bash
node scripts/release/verify-release.mjs --rehearse --strict
```

输出逐项 `[PASS]/[WARN]/[FAIL]`，覆盖：三处版本一致、当前版本段落存在且日期合法、未发布区已清空、未发布区条目格式。`ci.yml` 在每次推送/PR 上跑的是同一套检查（`verify-release --rehearse --strict`），所以**合 main 前就已经拦过一轮**；这里是发版前再确认。

> 发版脚本需要宿主机 Node >= 20（CI runner 已装 Node 22；本机可用任何 Node 20+ 或 DSH 自带 node）。

### 3.5 提交与推送

```bash
git add -A
git commit -m "release: prepare v1.5.11"
git push gitea main        # 需明确批准
```

- 版本号 bump 提交必须**立即推送并确认 CI 成功**（规则 5）：版本号是镜像 tag 与 Release 标签的来源。
- 推送前确认工作区干净、只包含本次发版相关改动。

## 4. 打标签：CI 自动完成三件套

```bash
git tag v1.5.11 && git push gitea v1.5.11     # 需明确批准
```

观察 **Actions → Release** 运行；阶段与预计耗时：

| 阶段 | 做什么 | 预计 |
| --- | --- | --- |
| verify | `docker build --target verify`（build+typecheck+test） | 排队 + 5–10 分钟 |
| 版本/说明校验 | `verify-release --tag v1.5.11 --strict` | 秒级 |
| 镜像 | 构建 → 起容器打 `/health` smoke → 推 `:1.5.11` 与 `:latest` | 5–10 分钟 |
| exe | wine 容器交叉打包 NSIS，产物 docker cp 拷出 | 25–35 分钟 |
| APK | Linux 容器 + keystore 签名构建 | 10–15 分钟 |
| Release | 组装产物 + sha256 → 创建带附件的 Gitea Release | 2–5 分钟 |
| 公开同步 | exe/apk/sha256 传到 GitHub 同名 Release | 5–20 分钟（取决于网络） |

- **smoke 不通过不会推 `:latest`**，`:latest` 永远指向一个启动得起来的镜像。
- 失败后的补发不再重推标签（禁止移动已推标签），见 §6。

## 5. 发版后收尾

### 5.1 归档收据

```bash
# 从 Gitea Release 下载附件并归档到 releases/<版本>/（token 走环境变量）
export GITEA_TOKEN=<有 package/Release 读权限的令牌>
node main/scripts/release/archive.mjs --tag v1.5.11 --download --copy \
  --gitea-url https://gitea.example.com --repo-path example/Engram
```

- 会重算 sha256 并和 Release 里的 `sha256-<版本>.txt` 核对；对不上直接失败。
- `releases/<版本>/release.json` 由 `lib/receipt.mjs` 校验后写入（schemaVersion=1），字段含 version/tag/date/artifacts(name,kind,size,sha256)/image/publicRelease/notes。
- 也可以 `--from release-out` 用 CI Artifact 下载后的目录，或 `--download` 直接从 Release 拉。

### 5.2 公开仓库核对

- 附件由发版流水线自动同步到 GitHub 同名 Release；失败/缺失用 **Actions → Repair Public Release** 输入标签补传（不重建、不改正文）。
- 历史版本用 dispatch 的 `github_backfill`（`1.2.0,1.3.0` 或 `all`）。
- 公开 Release 正文由 public-mirror 用脱敏 CHANGELOG 填写，附件与正文是两条链路，核对时分开看。

### 5.3 三端验证清单

| 端 | 验证 |
| --- | --- |
| Docker | `docker pull .../engram:1.5.11` → 部署机更新 → 设置 →「应用版本」显示 `1.5.11 · <提交号>`；`/health` 200 |
| Windows | 从 Release 下载 `Engram Setup 1.5.11.exe` 安装/覆盖，版本号与 `/assets` 里的前端资源一致；内置 Agent 控制台可用 |
| Android | 从 Release 下载 `Engram 1.5.11.apk` 安装，核对 versionName=1.5.11、签名（应用内「关于」） |
| 公开入口 | GitHub Release 有 exe/apk/sha256 附件，正文是脱敏 CHANGELOG |

## 6. 异常与修复

| 现象 | 处理 |
| --- | --- |
| tag 运行在镜像阶段失败 | 修复后用 dispatch：输入该 tag + 勾选 `image`（重建镜像、先 smoke 再推两个 tag） |
| tag 运行在 exe/APK 阶段失败（如缺 keystore secrets） | 配好 secrets 后 dispatch：输入该 tag + 勾 `binaries`（重建并补挂/创建 Release） |
| 构建成功但 Release 缺附件 | 同上 dispatch `binaries`（幂等，已存在的同名同大小附件跳过） |
| 公开仓库上传中断（SSL/网络） | **Actions → Repair Public Release** 输入标签；不要重跑整个发版 |
| 镜像启动失败但已推 `:版本` | 修复后 dispatch `image`；确认 smoke 通过后 `:latest` 才被覆盖 |
| 标签打错 / 版本号忘了 bump | **不要移动已推送的 tag**；补一个新的修复版本号重新发版（v1.5.12） |
| 需要离线 tar.gz | dispatch 勾 `offline_image`（只构建并挂包，不推镜像） |
| 历史版本补二进制 | dispatch 输入历史 tag + 勾 `binaries`（`android_build_recipe_sha` 可替换旧标签的 Android 构建环境） |
| 需要回到旧版本 | 部署机改 compose 用旧 `:版本` 并 `docker compose up -d`；桌面端重装旧 exe；仓库不保留回滚脚本 |

> 所有 dispatch 都不需要「补发整套」：修哪一步勾哪一项，其他产物不动。

## 7. 脚本参考

| 脚本 | 用途 | 关键参数 | 退出码 |
| --- | --- | --- | --- |
| `bump-version.mjs` | 三处版本号一次改 | `major\|minor\|patch\|x.y.z`、`--dry-run`、`--repo` | 0/1/2 |
| `release-notes.mjs` | 校验 / 生成版本段落与安卓累积段 | `--check`、`--render`、`--write`、`--version`、`--date`、`--android-base`、`--summary` | 0/1/2 |
| `verify-release.mjs` | 发版门禁体检 | `--rehearse`、`--tag vX`、`--artifacts <dir>`、`--strict`、`--json` | 0/1/2 |
| `archive.mjs` | 核对产物并写发版收据 | `--tag`、`--from <dir>` / `--download`、`--copy`、`--gitea-url`、`--repo-path`、`--token` | 0/1/2 |

脚本单元测试：

```bash
cd main && node --test scripts/release/tests/*.test.mjs
```

## 8. 与旧流程的对照

| 旧（≤ v1.5.10） | 新 |
| --- | --- |
| 手工改三处版本号 | `bump-version.mjs` 一条命令 + 回读校验 |
| 手写整段 CHANGELOG + 手写安卓累积段 | 未发布区逐条沉淀 → `release-notes.mjs` 聚合生成 |
| 推 tag 只产镜像 + 空 Release，再手动 dispatch binaries | 推 tag 自动产三件套 + 带附件 Release |
| 发版后手工下载、核 sha256、写自由 JSON | `archive.mjs` 核对并生成带 schema 的收据 |
| 公开仓库上传失败要重跑整轮 | Repair workflow / 单项 dispatch 补发 |

## 9. FAQ

**Q：发版准备时忘了先 bump 版本号就写了说明会怎样？**
A：`release-notes --render` 默认用当前 `desktop/package.json` 版本；先 bump 再 render，顺序不要反。反过来先 render 后 bump 会生成旧版本段落，`verify-release --tag` 会失败。

**Q：未发布区可以空着提交吗？**
A：可以，但发版前 `verify --tag` 要求未发布区为空（已 render 进版本段）；彩排只校验已有条目格式。没有未发布条目的版本也可以发（纯维护版本）。

**Q：安卓累积段生成得不全？**
A：先确认 `--android-base`。默认基线是上一个已发布版本；若上一个版本没产 APK（历史上有过按需分发窗口），显式指定更早的版本，重新 `--render --write`（需先 `git checkout CHANGELOG.md` 回退）。

**Q：能像 DSH 那样有 rc/alpha 通道吗？**
A：暂不做。Engram 的测试通道是 Docker `:main` 滚动镜像；正式发版仍是 `v*` 标签。以后要预发布通道再评估（DSH 的 dist-tag 晋级不适用于本项目）。

**Q：为什么 dispatch 不能重新推镜像？**
A：能——勾 `image`。默认不重推是为了避免「补一个附件顺手覆盖 `:latest`」的意外。
