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
2.在功能和代码优化时，要兼顾desaktop和docker两个版本。
3.构建最新的安装包时要同步构建最新的同版本tar和win安装包，放入releases中相同版本号文件夹内


## Windows 桌面端打包

桌面端安装包版本号与发布版本对齐（`desktop/package.json` 的 `version` 与 `releases/` 下最新版本号衔接，如当前 `1.0.17`）。产物写入 `releases/<version>/`，不纳入 Git。

打包在代码库外的本地目录进行（属第 17 行允许的宿主机原生任务），分两步走，绕过 Windows Defender 实时扫描锁定 `electron.exe` 导致的 `EPERM rename`：

1. **组装 win-unpacked**（不经 electron-builder 的 extract/rename）：

   * `pnpm build:desktop` 跑到 `electron-builder` 那步会因 Defender EPERM 失败，但此前 server/web 已 build、`prepare-desktop.js` 已复制产物、server 生产依赖已装、better-sqlite3 已重编（electron-builder 内置 `@electron/rebuild`，日志 `completed installing native dependencies` 即成功）。
   * 手动解压 electron zip 到 `dist/win-unpacked`（`Expand-Archive` 直接解压，无 rename，不触发 Defender）：`powershell -Command "Expand-Archive electron-v35.7.5-win32-x64.zip dist/win-unpacked"`。
   * 跑 `node desktop/scripts/pack-asar.js` 生成 `dist/win-unpacked/resources/app.asar` + `app.asar.unpacked/`：组装 staging（`main.js`/`preload.js`/`index.html` + `server` + `web/dist`）→ `@electron/asar` 打包，三个原生模块（better-sqlite3/sqlite-vec/@napi-rs/canvas）解包到 `app.asar.unpacked`。
2. **打 NSIS 安装包**（跳过 extract，直接打包已有 win-unpacked）：

```bash
   cd desktop \&\& pnpm exec electron-builder --prepackaged dist/win-unpacked --win nsis
   ```

   * `--prepackaged` 跳过 electron 解压/rename，不触发 Defender 锁定；输出文件被扫描锁定时 electron-builder 自动 `waiting for unlock` 重试。
   * 产出 `desktop/dist/LLM Wiki Setup <version>.exe`，复制到 `releases/<version>/` 并记录提交 ID、构建时间、sha256。

**关键坑**：

* `zod` 必须 3.25.76（`@modelcontextprotocol/sdk@1.30` 的 zod-compat `import 'zod/v3'`，3.24.1 无 `./v3` exports 致 ESM 崩；`prepare-desktop.js` 已固定）。
* `pnpm -C desktop/server install` 需 `--node-linker=hoisted --ignore-workspace --no-frozen-lockfile`（hoisted 让原生模块为真实目录非 symlink，否则 asar 打包时 `@electron/asar` 对 unpack 的 symlink 在 `app.asar.unpacked` 重建会因非管理员无 symlink 权限失败；脱离 workspace + 避锁文件冲突），ignored builds 的 exit 1 用 `|| true` 容忍（better-sqlite3 由 electron-builder 内置 @electron/rebuild 重编）。
* `desktop/package.json` 设 `asar: true` + `asarUnpack` 解包三个原生模块；把上万 node_modules 散文件合并进单个 `app.asar`，安装从逐文件写出变单归档解压，实测 243 秒→6 秒。asar 打包靠 `pack-asar.js`（EB 因 Defender EPERM 走不到 asar 阶段）；`node-linker=hoisted` 是前提（见上条）。
* sqlite-vec 在 asar 模式下 `load` 内部 `require.resolve` 返回 `app.asar` 虚拟路径，`better-sqlite3` 的 `loadExtension` 走 native dlopen 不经 asar fs 转换会失败；`server/src/lib/db.ts` 已把路径转成 `app.asar.unpacked` 真实路径（非 asar 环境 Docker/dev 原样工作）。
* 本地模式默认端口 18080，若被 Docker backend 占用需改 `LOCAL\_PORT` 或加端口回退。

