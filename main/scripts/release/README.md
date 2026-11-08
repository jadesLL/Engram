# 发版脚本（scripts/release）

发版脚本层：`bump-version.mjs`（三处版本号一次改）、`release-notes.mjs`（未发布区校验 / 生成版本段落与安卓累积段）、`verify-release.mjs`（发版门禁体检）、`archive.mjs`（产物核对与发版收据），共享库在 `lib/`，单测在 `tests/`。
完整流程与参数说明见 [docs/RELEASE.md](../../docs/RELEASE.md)；CI 细节见 [docs/GITEA-CI.md](../../docs/GITEA-CI.md)。
本目录只依赖 Node >= 20 内置模块（零第三方依赖），所有命令在 `main/` 下执行（`--repo` 可覆盖），退出码 0/1/2。
单元测试：`cd main && node --test scripts/release/tests/*.test.mjs`（Node 22+ 支持 glob；目录参数在新版 Node 会被当作单个模块）。
