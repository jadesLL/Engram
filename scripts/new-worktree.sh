#!/usr/bin/env bash
# 开一个新的并行功能 worktree + 独立 Docker 容器（端口/卷/镜像 tag 全隔离）。
# 由 AI Agent 执行。用法：
#   scripts/new-worktree.sh <feature> <host-port>
#   例: scripts/new-worktree.sh search-export 8082
#
# 产物：
#   worktree:  <repo>-<feature>        分支 feat/<feature>
#   镜像:      example-wiki:<feature>      （不覆盖 main 的 example-wiki:0.1.0）
#   容器:      example-wiki-<feature>
#   端口:      <host-port> -> 8080      （main 占 8080，第 N 个用 808N）
#   卷:        example-wiki-data-<feature> （从 main 卷播种当前数据快照）
set -euo pipefail

FEATURE="${1:?usage: new-worktree.sh <feature> <host-port>}"
PORT="${2:?usage: new-worktree.sh <feature> <host-port>}"

REPO="//tsclient/D/SoftwareWorkspace/Wiki知识库"
WT="$REPO-$FEATURE"
BRANCH="feat/$FEATURE"
IMG="example-wiki:$FEATURE"
CONT="example-wiki-$FEATURE"
VOL="example-wiki-data-$FEATURE"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "!! 端口必须是 1-65535 之间的整数，当前值: $PORT"
  exit 1
fi
[ "$PORT" -eq 8080 ] && { echo "!! 8080 为 main 保留端口，功能 worktree 不得使用"; exit 1; }

check_port_available() {
  node - "$PORT" <<'NODE'
const net = require('node:net');

const port = Number(process.argv[2]);
const server = net.createServer();

server.unref();
server.once('error', (error) => {
  console.error(`!! 端口 ${port} 不可用: ${error.code ?? error.message}`);
  process.exit(1);
});
server.listen({ port, exclusive: true }, () => {
  server.close(() => process.exit(0));
});
NODE
}

echo ">> [0/5] 执行前复验端口 $PORT"
if ! check_port_available; then
  echo "   停止创建；重新选择端口、更新计划后再执行。"
  exit 1
fi
echo "   端口 $PORT 未被占用，可以开始创建资源"

[ -d "$WT" ] && { echo "!! worktree 已存在: $WT"; exit 1; }
git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" && { echo "!! 分支 $BRANCH 已存在"; exit 1; }
docker ps -a --format '{{.Names}}' | grep -qx "$CONT" && { echo "!! 容器 $CONT 已存在"; exit 1; }
docker volume inspect "$VOL" >/dev/null 2>&1 && { echo "!! 数据卷 $VOL 已存在"; exit 1; }

echo ">> [1/5] git worktree add  ($BRANCH)"
git -C "$REPO" worktree add "$WT" -b "$BRANCH"
# UNC 路径必须给新 worktree 单独加 safe.directory
git config --global --add safe.directory "%(prefix)/$WT"

echo ">> [2/5] 生成 worktree 专属 compose"
cat > "$WT/docker-compose.worktree.yml" <<EOF
# $FEATURE worktree 专属部署（与 main 容器并行隔离）
services:
  example-wiki:
    image: $IMG
    build: .
    container_name: $CONT
    ports: ["$PORT:8080"]
    volumes: ["$VOL:/data"]
    environment:
      - TZ=Asia/Shanghai
      - DEFAULT_PASSWORD=CHANGE_ME_PUBLIC_SNAPSHOT_PLACEHOLDER
    restart: unless-stopped
volumes:
  $VOL: {external: true}
EOF

echo ">> [3/5] 建卷 + 从 main 卷播种当前数据（卷到卷拷贝，不碰 UNC）"
docker volume create "$VOL" >/dev/null
docker run --rm -v example-wiki-data:/src:ro -v "$VOL:/dst" \
  node:22-slim sh -c 'cp -a /src/. /dst/'

echo ">> [4/5] 构建镜像 + 启动（首次命中 cache 秒级，改代码后重建也快）"
docker compose -f "$WT/docker-compose.worktree.yml" up -d --build

echo ">> [5/5] 健康检查"
sleep 6
if curl -sf -o /dev/null "http://localhost:$PORT/"; then
  echo "DONE ✔  worktree=$WT  branch=$BRANCH  port=$PORT  vol=$VOL"
else
  echo "!! 容器起来了但 $PORT 未响应，查: docker logs $CONT"
fi
