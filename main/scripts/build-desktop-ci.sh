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
pnpm --filter @example-wiki/server build
pnpm --filter @example-wiki/web build

echo ">> 复制构建产物到 desktop/（prepare-desktop.js）"
node desktop/scripts/prepare-desktop.js

echo ">> 安装 desktop/server 生产依赖（win32-x64 交叉安装原生模块预编译包）"
pnpm -C desktop/server install --prod \
  --node-linker=hoisted --ignore-workspace --no-frozen-lockfile \
  --config.os=win32 --config.cpu=x64 --config.arch=x64

echo ">> 重编 better-sqlite3 到 Electron win32-x64 ABI"
cd desktop/server/node_modules/better-sqlite3
npx --yes @electron/rebuild -f -m . --arch x64 || {
  echo ">> @electron/rebuild 失败，回退 prebuild-install 直接拉 Electron win32-x64 预编译"
  npx --yes prebuild-install -r electron -t 35.7.5 --arch x64 || {
    echo ">> prebuild-install 也失败，尝试源码编译（wine）"
    npx --yes node-gyp rebuild --release --target=35.7.5 --runtime=electron --arch=x64 --dist-url=https://npmmirror.com/mirrors/electron/
  }
}
ls build/Release/better_sqlite3.node
cd -

echo ">> 打包 NSIS（electron-builder 完整流程，wine）"
cd desktop
# EB 需要 desktop 的 devDependencies（electron、electron-builder）
pnpm install --frozen-lockfile --ignore-scripts
# electron zip 由 EB 下载；wine 下无 Defender，走完整流程（下载+解压+asar+NSIS）
npx electron-builder --win nsis

echo ">> 产物清单"
ls -la dist/*.exe
