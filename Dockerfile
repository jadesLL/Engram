# ---------- 前端构建 ----------
FROM node:22-slim AS build
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
RUN pnpm --filter @example-wiki/web build && pnpm --filter @example-wiki/server build

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
#（prebuild-install 拉预编译二进制，失败则 node-gyp 源码编译）
RUN cd /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
  && (npm run install || npx --yes node-gyp rebuild --release) \
  && ls build/Release/better_sqlite3.node

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
COPY package.json pnpm-workspace.yaml ./
COPY server/package.json ./server/
VOLUME /data
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "dist/index.js"]
