# ExampleProject 工作区入口

Git 工作目录位于当前 `ExampleProject/` 目录，使用以下布局：

* `main/`：主分支中的应用源码和集成入口
* `worktrees/`：独立任务 worktree；实际检出内容不纳入主工作目录版本控制
* `releases/`：发布快照和产物；不纳入 Git

处理 `main/` 或 `worktrees/` 下的任何仓库任务前，必须从仓库根目录完整读取：

1. [`main/AGENTS.md`](./main/AGENTS.md)
2. [`main/WORKTREES.md`](./main/WORKTREES.md)

Git 命令默认从当前 `ExampleProject/` 根目录执行。不要运行仍引用旧 `Wiki知识库` 路径的 worktree 脚本，也不要在 `releases/` 中开发。

只进行本地的git管理，不处理任何远端仓库。
下载任何环境需要的文件，需要先向用户申请，不允许私自下载。使用环境若不是必须，不要在代码库中安装环境，安装到本地环境不放在代码库。

完成任何功能后，必须先自行验证功能是否正确，并截取能够证明结果的界面或终端画面。验收完成后，向用户汇报改动、检查结果、截图、分支和提交信息，并分别询问是否合并到 `main`、是否部署；没有用户对相应动作的明确批准，不得合并或部署。

项目规则：

1.优先使用中文。

## Windows 桌面端打包

桌面端安装包版本号与发布版本对齐（`desktop/package.json` 的 `version` 与 `releases/` 下最新版本号衔接，如当前 `1.0.17`）。产物写入 `releases/<version>/`，不纳入 Git。

打包在代码库外的本地目录进行（属第 17 行允许的宿主机原生任务），分两步走，绕过 Windows Defender 实时扫描锁定 `electron.exe` 导致的 `EPERM rename`：

1. **组装 win-unpacked**（不经 electron-builder 的 extract/rename）：
   - `pnpm build:desktop` 跑到 `electron-builder` 那步会因 Defender EPERM 失败，但此前 server/web 已 build、`prepare-desktop.js` 已复制产物、server 生产依赖已装、better-sqlite3 已重编（electron-builder 内置 `@electron/rebuild`，日志 `completed installing native dependencies` 即成功）。
   - 手动解压 electron zip 到 `dist/win-unpacked`（`Expand-Archive` 直接解压，无 rename，不触发 Defender）：`powershell -Command "Expand-Archive electron-v35.7.5-win32-x64.zip dist/win-unpacked"`。
   - 组装 `dist/win-unpacked/resources/app/`：复制 `main.js`/`preload.js`/`index.html` + 生成 `package.json`（`main: main.js`）+ 复制 `server`（含 dist + node_modules）+ 复制 `web/dist`。

2. **打 NSIS 安装包**（跳过 extract，直接打包已有 win-unpacked）：
   ```bash
   cd desktop && pnpm exec electron-builder --prepackaged dist/win-unpacked --win nsis
   ```
   - `--prepackaged` 跳过 electron 解压/rename，不触发 Defender 锁定；输出文件被扫描锁定时 electron-builder 自动 `waiting for unlock` 重试。
   - 产出 `desktop/dist/LLM Wiki Setup <version>.exe`，复制到 `releases/<version>/` 并记录提交 ID、构建时间、sha256。

**关键坑**：
- `zod` 必须 3.25.76（`@modelcontextprotocol/sdk@1.30` 的 zod-compat `import 'zod/v3'`，3.24.1 无 `./v3` exports 致 ESM 崩；`prepare-desktop.js` 已固定）。
- `pnpm -C desktop/server install` 需 `--ignore-workspace --no-frozen-lockfile`（脱离 workspace + 避锁文件冲突），ignored builds 的 exit 1 用 `|| true` 容忍（better-sqlite3 由 electron-builder 重编）。
- `desktop/package.json` 设 `asar: false`（非管理员环境无法创建 symlink）。
- 本地模式默认端口 18080，若被 Docker backend 占用需改 `LOCAL_PORT` 或加端口回退。
