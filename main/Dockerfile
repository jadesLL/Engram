# ---------- 前端构建 ----------
FROM node:22-slim AS build
# 构建身份：镜像里没有 .git，构建期把提交号烤进 /app/GIT_SHA（对齐 hermes-agent 的 .hermes_build_sha）
ARG ENGRAM_GIT_SHA=""
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
RUN pnpm config set registry https://registry.npmmirror.com
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/
# 构建阶段无需原生模块，跳过 install 脚本
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY server server
COPY web web
# desktop/scripts：依赖同步（sync-deps.js）与桌面端脚本的单测，随 verify 目标一起跑
COPY desktop desktop
# installer/scripts/tests：根 test script 会跑安装器脚本单测（node 原生 assert，无依赖）；
# 其用例校验 scripts/install-engram.ps1 与 update-from-source.ps1 的 BOM/内容
COPY installer installer
COPY scripts scripts
# /app/VERSION：应用内自更新的版本比对依据（server /api/update 读取）
# /app/GIT_SHA：构建期烤入的提交号，镜像内无 .git 时由 server codeIdentity() 读取
RUN pnpm --filter @engram/web build && pnpm --filter @engram/server build \
  && node -p "require('./desktop/package.json').version" > /app/VERSION \
  && printf '%s' "$ENGRAM_GIT_SHA" > /app/GIT_SHA

# ---------- 生产依赖（编译 better-sqlite3 原生模块） ----------
FROM node:22-slim AS deps
RUN sed -i \
  -e 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' \
  -e 's|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' \
  /etc/apt/sources.list.d/debian.sources \
  && corepack enable && corepack prepare pnpm@10.20.0 --activate \
  && pnpm config set registry https://registry.npmmirror.com \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/
RUN pnpm install --prod --frozen-lockfile
# pnpm 默认拦截原生构建脚本，这里显式执行 better-sqlite3 的安装脚本
#（prebuild-install 拉预编译二进制，失败则 node-gyp 源码编译）。
# prebuild-install 默认从 GitHub releases 下载，受限网络下会长时间挂死，
# 指到 npmmirror 的二进制镜像（同宿主机安装配方）
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 \
    npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3
RUN cd /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
  && (npm run install || npx --yes node-gyp rebuild --release) \
  && ls build/Release/better_sqlite3.node

# ---------- 测试环境（开发依赖 + 原生绑定） ----------
FROM build AS test
COPY --from=deps /app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build \
  /app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build
CMD ["pnpm", "--filter", "@engram/server", "test"]

# ---------- 一次完成构建、类型检查和测试 ----------
FROM test AS verify
RUN pnpm typecheck && pnpm test
CMD ["node", "-e", "console.log('Engram verification passed')"]

# ---------- 运行时 ----------
FROM node:22-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/VERSION /app/VERSION
COPY --from=build /app/GIT_SHA /app/GIT_SHA
COPY package.json pnpm-workspace.yaml ./
COPY server/package.json ./server/
VOLUME /data
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "dist/index.js"]
