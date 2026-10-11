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
# .npmrc 必须在依赖层之后复制：它是给宿主机/客户机 pnpm install 的下载镜像（electron、
# better-sqlite3 postinstall），镜像内 verify 的单测会断言它在位；放前面会让依赖层每次失效
COPY .npmrc ./
# 安装镜像配置回归测试读取 Dockerfile，放在依赖层之后，避免重新安装依赖。
COPY Dockerfile ./
COPY server server
COPY web web
# desktop/scripts：依赖同步（sync-deps.js）与桌面端脚本的单测，随 verify 目标一起跑
COPY desktop desktop
# installer/scripts/tests：根 test script 会跑安装器脚本单测（node 原生 assert，无依赖）；
# 其用例校验 scripts/install-engram.ps1 与 update-from-source.ps1 的 BOM/内容
COPY installer installer
COPY scripts scripts
# mobile：web 端的安卓接线护栏单测（web/src/lib/mobileLayout.test.ts）要读
# mobile/capacitor.config.json 与 android 源码，缺了它 verify 目标直接红。
# 构建产物（web-dist、assets/public）已由 .dockerignore 挡掉，只进源码。
COPY mobile mobile
# /app/VERSION：应用内自更新的版本比对依据（server /api/update 读取）
RUN pnpm --filter @engram/web build && pnpm --filter @engram/server build \
  && node -p "require('./desktop/package.json').version" > /app/VERSION
# /app/GIT_SHA：构建期烤入的提交号，镜像内无 .git 时由 server codeIdentity() 读取。
# ARG 紧贴用到它的 RUN 声明：提交号每次推送都不同，Docker 会让 ARG 声明点之后的层缓存全部失效，
# 声明在依赖安装与源码构建之前会导致每次推送重下依赖（runner 无外网时构建直接失败）。
ARG ENGRAM_GIT_SHA=""
RUN printf '%s' "$ENGRAM_GIT_SHA" > /app/GIT_SHA

# ---------- 生产依赖（编译 better-sqlite3 原生模块） ----------
FROM node:22-slim AS deps
# 显式使用 HTTPS；只替换域名会保留基础镜像的 HTTP 协议，下载 .deb 时曾返回 403。
# 同时兼容基础镜像中 HTTP/HTTPS 两种源地址，保留 Debian 自带的签名与 TLS 校验。
# slim 缺少系统 CA：用 Node 内置的 Mozilla 根证书引导 APT，随后安装 Debian CA 包。
RUN sed -i \
  -e 's|https\?://deb\.debian\.org|https://mirrors.tuna.tsinghua.edu.cn|g' \
  -e 's|https\?://security\.debian\.org|https://mirrors.tuna.tsinghua.edu.cn|g' \
  /etc/apt/sources.list.d/debian.sources \
  && corepack enable && corepack prepare pnpm@10.20.0 --activate \
  && pnpm config set registry https://registry.npmmirror.com \
  && node -e "require('node:fs').writeFileSync('/tmp/engram-node-ca.pem', require('node:tls').rootCertificates.join('\n') + '\n')" \
  && apt-get -o Acquire::https::CaInfo=/tmp/engram-node-ca.pem -o APT::Update::Error-Mode=any update \
  && apt-get -o Acquire::https::CaInfo=/tmp/engram-node-ca.pem install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -f /tmp/engram-node-ca.pem \
  && rm -rf /var/lib/apt/lists/*
# node-gyp 兜底不能靠构建时临时下载：`npx --yes node-gyp` 每次都要联网取包（受限网络直接挂死，
# 产物也不可复现）。镜像内固定预装 node-gyp@12.4.0 —— 版本取自 pnpm-lock.yaml 中被
# @electron/rebuild@4.2.0 依赖的那一份（12.4.0），与仓库其它地方保持一致；下方的编译
# 失败兜底因此不再需要网络。
RUN npm install -g --no-fund --no-audit --registry https://registry.npmmirror.com node-gyp@12.4.0
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
  && (npm run install || node-gyp rebuild --release) \
  && ls build/Release/better_sqlite3.node

# ---------- 测试环境（开发依赖 + 原生绑定） ----------
FROM build AS test
# better-sqlite3 版本号不写死：pnpm 的目录名带版本（better-sqlite3@<版本>），写死会在依赖升版时
# 让 COPY 源路径不存在、镜像构建直接失败（审计实查的坑）。这里用通配符源先把 deps 阶段编译好的
# build 目录取到固定暂存路径，再用 shell glob 放回 build 阶段 pnpm 布局里的同名位置。
COPY --from=deps /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build /tmp/engram-better-sqlite3-build
RUN set -eu; \
    set -- /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; \
    if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then \
      echo "better-sqlite3 在 pnpm 布局中的目录匹配异常（匹配 $# 个），请检查 Dockerfile 的 glob" >&2; \
      exit 1; \
    fi; \
    mkdir -p "$1/build"; \
    cp -a /tmp/engram-better-sqlite3-build/. "$1/build/"; \
    rm -rf /tmp/engram-better-sqlite3-build; \
    ls "$1/build/Release/better_sqlite3.node"
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
# 运行用户保持 root（不做非 root 化）：/data 是宿主机绑定目录或既有命名卷（NAS / 客户机上的
# 数据卷由 root 创建），改成 node 用户会因卷属主不匹配写不进知识库，历史安装全部受影响；
# 卷属主迁移不在这一个镜像能覆盖的范围内（审计项 2c：有破坏既有安装的风险就不改）。
VOLUME /data
EXPOSE 8080
# 与 compose（docker-compose.yml / unc / nas / pull 同款配置）一致的容器内健康检查：
# node 直连容器内 8080 的 /health，200 才算健康。镜像自带判定，部署侧漏配 healthcheck 时也可用。
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD node -e "require('http').get('http://localhost:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
WORKDIR /app/server
CMD ["node", "dist/index.js"]
