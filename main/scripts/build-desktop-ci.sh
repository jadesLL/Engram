# CI 环境下构建 Windows NSIS 安装包（在 electronuserland/builder:wine 容器内执行）
# 由 desktop/Dockerfile.ci 调用：构建上下文为 main/ 目录，WORKDIR /work，源码已 COPY 到 /work
# 前置 env（Dockerfile.ci 已写入）：
#   ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR —— npmmirror 镜像加速
# 与本地 AGENTS.md 手动两步法的差异：CI 无 Windows Defender，electron-builder 完整流程
# 可直接走到 asar 阶段，无需 pack-asar.js 手动绕行。
set -euo pipefail

cd "$(dirname "$0")/.."   # /work（main/ 源码根）

echo ">> 环境信息"
node --version
corepack --version || true

echo ">> 激活 pnpm@10.20.0 + npmmirror 源"
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm config set registry https://registry.npmmirror.com

echo ">> 安装依赖（含 desktop 构建依赖）"
pnpm install --frozen-lockfile --ignore-scripts

echo ">> better-sqlite3 拉取 Node ABI 预编译（服务端测试用；Electron ABI 稍后由 @electron/rebuild 重编）"
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
npm run install || npx --yes node-gyp rebuild --release
cd -

echo ">> 构建 server（tsc）+ web（vite）"
pnpm --filter @engram/server build
pnpm --filter @engram/web build

echo ">> 复制构建产物到 desktop/（prepare-desktop.js）"
node desktop/scripts/prepare-desktop.js

echo ">> 安装 desktop/server 生产依赖（win32-x64 交叉安装原生模块预编译包）"
pnpm -C desktop/server install --prod \
  --node-linker=hoisted --ignore-workspace --no-frozen-lockfile \
  --config.os=win32 --config.cpu=x64 --config.arch=x64

echo ">> 拉取 better-sqlite3 的 Electron win32-x64 预编译"
cd desktop/server/node_modules/better-sqlite3
# GitHub releases 在受限网络不可达，prebuild-install 走 npmmirror 二进制镜像
#（prebuild-install 把 electron 版本映射为 ABI 名 v133 后拼到镜像路径下）
npx --yes prebuild-install -r electron -t 35.7.5 --arch x64 --platform win32 \
  --download https://registry.npmmirror.com/-/binary/better-sqlite3 || {
  echo ">> prebuild-install 失败，尝试源码编译（wine 交叉编译 win32-x64）"
  npx --yes node-gyp rebuild --release --target=35.7.5 --runtime=electron --arch=x64 --dist-url=https://electronjs.org/headers/
}
ls build/Release/better_sqlite3.node
# 断言是 Windows PE 二进制（MZ 头），防止被装成 Linux ELF 装进 exe 本地模式必崩
if ! head -c 2 build/Release/better_sqlite3.node | grep -q MZ; then
  echo "错误：better_sqlite3.node 不是 Windows PE 二进制（win32-x64 prebuild 拉取失败）"
  exit 1
fi
cd -

echo ">> 打包 NSIS（electron-builder 完整流程，wine）"
cd desktop
# EB 需要 desktop 的 devDependencies（electron、electron-builder）
pnpm install --frozen-lockfile --ignore-scripts

echo ">> 清理 .bin 与悬空符号链接（staging 只带生产依赖，npx/prebuild-install 产生的嵌套"
echo "   node_modules/.bin 悬空链接会让 NSIS 的 7za 扫描报错 exit 1；运行时 node dist/index.js 不需要 CLI 入口）"
find server/node_modules -type d -name .bin -prune -exec rm -rf {} + 2>/dev/null || true
find server/node_modules -xtype l -delete 2>/dev/null || true

# electron zip 由 EB 下载；wine 下无 Defender，走完整流程（下载+解压+asar+NSIS）
# npmRebuild=false：EB 内置 @electron/rebuild 会按当前平台（Linux）重编原生模块，
# 覆盖掉上面预放的 Electron win32-x64 prebuild 二进制；CI 里二进制已就绪，必须跳过重编。
# 托盘图标：package.json files 里的「icon.png」指 desktop 根文件（main.js trayIcon() 在 asar
# 根找 icon.png），仓库里只有 build/icon.png，不拷贝则 glob 静默落空、发布版 asar 无托盘图标
# （v1.1.39/1.1.40 托盘空白的根因；对齐 pack-asar.js 手动打包的 staging 布局）。
cp build/icon.png icon.png
npx electron-builder --win nsis --config.npmRebuild=false

echo ">> 产物清单"
ls -la dist/*.exe
