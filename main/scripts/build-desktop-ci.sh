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
# prebuild-install（better-sqlite3 原生包）默认拉 GitHub releases，受限网络静默挂死；
# 全程指到 npmmirror 二进制镜像（node-ABI 与 electron-ABI 两处拉取共用）
export npm_config_better_sqlite3_binary_host_mirror="https://registry.npmmirror.com/-/binary/better-sqlite3"
export npm_config_better_sqlite3_binary_host="https://registry.npmmirror.com/-/binary/better-sqlite3"

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
# ABI 必须由**本次实际打包的 Electron 版本**推导，绝不写死：写死会在 Electron 升版后失配，而 CI 照样
# 全绿 —— v1.3.0 的 exe 就是这么坏的（9-16 升到 Electron 36 需要 ABI 135，脚本却仍下 ABI 133 的
# 预编译；内嵌 server 一启动就 ERR_DLOPEN_FAILED，所有装了 1.3.0 的机器都卡在「本地服务启动失败」）。
BETTER_SQLITE3_VERSION="$(node -p "require('./desktop/server/node_modules/better-sqlite3/package.json').version")"
ELECTRON_VERSION="$(node -p "require('./desktop/node_modules/electron/package.json').version")"
ELECTRON_ABI="$(node -e "process.stdout.write(String(require('./desktop/scripts/lib/electron-abi.js').abiForElectronVersion(process.argv[1])))" "$ELECTRON_VERSION")"
BETTER_SQLITE3_TARBALL="better-sqlite3-v${BETTER_SQLITE3_VERSION}-electron-v${ELECTRON_ABI}-win32-x64.tar.gz"
echo "   better-sqlite3 v${BETTER_SQLITE3_VERSION} · Electron ${ELECTRON_VERSION} → ABI ${ELECTRON_ABI}"
cd desktop/server/node_modules/better-sqlite3
# GitHub releases 在受限网络不可达。prebuild-install 的镜像拼接路径不可控
#（会拼出软 404 HTML 页报 incorrect header check），直接取精确文件解压
# --retry-all-errors：npmmirror 偶发断连/5xx 在默认 --retry 下不算可重试错误（09-06 发版三连失败根因）
if curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "$BETTER_SQLITE3_TARBALL" \
  "https://registry.npmmirror.com/-/binary/better-sqlite3/v${BETTER_SQLITE3_VERSION}/$BETTER_SQLITE3_TARBALL"; then
  tar -xzf "$BETTER_SQLITE3_TARBALL"
  rm -f "$BETTER_SQLITE3_TARBALL"
else
  # 不再回退 node-gyp：本容器是 Linux 工具链（gcc），编出来只能是无用的 ELF，
  # 跑到下方 PE 断言照样失败，白烧几分钟（09-06 失败 run 的实际行为）
  echo "错误：Electron win32-x64 预编译下载失败（npmmirror 不可达），无可用回退，直接失败"
  exit 1
fi
ls build/Release/better_sqlite3.node
# 断言是 Windows PE 二进制（MZ 头），防止被装成 Linux ELF 装进 exe 本地模式必崩
if ! head -c 2 build/Release/better_sqlite3.node | grep -q MZ; then
  echo "错误：better_sqlite3.node 不是 Windows PE 二进制（win32-x64 prebuild 拉取失败）"
  exit 1
fi
cd -
# 断言预编译的 ABI 就是上面推导出来的那个（静态读 .node 里的 node_register_module_v<ABI> 符号）
node desktop/scripts/verify-packaged-abi.js \
  --binding desktop/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  --electron-version "$ELECTRON_VERSION"

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
# 启动页品牌图形 mark-dark.svg 同理：logoSvg() 在 asar 根找它，EB 不会打 build/ 目录。
cp build/icon.png icon.png
cp build/mark-dark.svg mark-dark.svg
npx electron-builder --win nsis --config.npmRebuild=false

# 收包后校验：asar 解包出来的 better_sqlite3.node 必须与 electron-builder 实际打包进去的 Electron
# 版本 ABI 一致（EB 写在 dist/builder-effective-config.yaml 里）。这一条是 v1.3.0 事故的兜底护栏：
# 上面推导错了、或者 EB 换了 Electron 版本，这里立刻失败，绝不产出「装上去打不开」的 exe。
echo ">> 校验安装包内原生模块 ABI"
node scripts/verify-packaged-abi.js --app-dir dist/win-unpacked

echo ">> 产物清单"
ls -la dist/*.exe
