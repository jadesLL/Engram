# ---------- 桥接服务构建（独立包，仅装 bridge 自身依赖） ----------
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
RUN pnpm config set registry https://registry.npmmirror.com
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src src
RUN pnpm build

# ---------- 桥接服务运行时 ----------
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8090
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 8090
CMD ["node", "dist/server.js"]
