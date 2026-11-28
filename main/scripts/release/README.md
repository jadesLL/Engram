# 发版脚本（scripts/release）

发版脚本层：`bump-version.mjs`（三处版本号一次改）、`release-notes.mjs`（未发布区校验 / 生成版本段落与安卓累积段）、`verify-release.mjs`（发版门禁体检）、`archive.mjs`（产物核对与发版收据），共享库在 `lib/`，单测在 `tests/`。
完整流程与参数说明见 [docs/RELEASE.md](../../docs/RELEASE.md)；CI 细节见 [docs/GITEA-CI.md](../../docs/GITEA-CI.md)。
本目录只依赖 Node >= 20 内置模块（零第三方依赖），所有命令在 `main/` 下执行（`--repo` 可覆盖），退出码 0/1/2。
单元测试：`cd main && node --test scripts/release/tests/*.test.mjs`（Node 22+ 支持 glob；目录参数在新版 Node 会被当作单个模块）。

## 发版看板（只读）

`watch.mjs` 在本机起一个零依赖小服务，把本机准备状态与 Gitea Actions 的发版运行聚合成一个网页：

```bash
pnpm release:watch                          # 最近一次 Release（运行中优先）
pnpm release:watch --tag v1.5.23            # 指定标签
pnpm release:watch --run 1330 --open        # 指定运行并自动开浏览器
pnpm release:watch --once                   # 只打印一份 JSON 状态
```

- 页面显示阶段时间线（准备 / 门禁 / 镜像 / exe / APK / Release / 公开同步）、每步耗时、预计剩余、日志尾、产物附件与最近几次发版耗时。
- 只监听 `127.0.0.1`，只读，不会触发任何发版动作；Gitea 凭据只在服务端使用（`GITEA_TOKEN` 或 `git credential fill`），不会下发到页面。
- 历史耗时缓存在用户目录（Windows `%LOCALAPPDATA%\Engram\release-watch\history.json`），用于校准预计剩余，不写入仓库。
