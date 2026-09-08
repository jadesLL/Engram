#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  preview-feature.sh [--allow-downloads] <feature> <host-port>

验证镜像准备完成后，按需构建并启动功能预览、隔离端口和数据卷。

默认禁用构建网络，只使用本机已有基础镜像、Docker 层和构建缓存。
--allow-downloads  仅在用户已经明确批准下载依赖后使用
EOF
}

ALLOW_DOWNLOADS=0
POSITIONAL=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-downloads)
      ALLOW_DOWNLOADS=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage
      engram_die "未知参数: $1"
      ;;
    *)
      POSITIONAL+=("$1")
      ;;
  esac
  shift
done

[ "${#POSITIONAL[@]}" -eq 2 ] || {
  usage
  exit 2
}
FEATURE="${POSITIONAL[0]}"
PORT="${POSITIONAL[1]}"

engram_init_feature "$FEATURE"
engram_require_docker
engram_require_feature_worktree
engram_configure_build_network "$ALLOW_DOWNLOADS"
MAIN_VOLUME="${ENGRAM_MAIN_VOLUME:-engram-data}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  engram_die "端口必须是 1-65535 之间的整数，当前值: $PORT"
fi
[ "$PORT" -ne 8080 ] || engram_die "8080 为 main 保留端口"

VERIFY_ARGS=("$FEATURE")
if [ "$ALLOW_DOWNLOADS" -eq 1 ]; then
  VERIFY_ARGS=(--allow-downloads "$FEATURE")
fi
engram_log ">> 预览前重新验证当前 worktree"
bash "$SCRIPT_DIR/verify-feature.sh" "${VERIFY_ARGS[@]}"

COMPOSE_ARGS=(
  --project-name "$ENGRAM_PROJECT"
  -f "$ENGRAM_WORKTREE/main/docker-compose.worktree.yml"
)

check_port_available() {
  local current_port=""
  if docker container inspect "$ENGRAM_CONTAINER" >/dev/null 2>&1; then
    current_port="$(
      docker port "$ENGRAM_CONTAINER" 8080/tcp 2>/dev/null |
        head -n 1 |
        awk -F: '{print $NF}'
    )"
  fi
  [ "$current_port" = "$PORT" ] && return

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

PREEXISTING_PREVIEW=0
if docker container inspect "$ENGRAM_CONTAINER" >/dev/null 2>&1 ||
  docker volume inspect "$ENGRAM_VOLUME" >/dev/null 2>&1 ||
  docker image inspect "$ENGRAM_IMAGE" >/dev/null 2>&1 ||
  [ -n "$(engram_feature_network_names)" ]
then
  PREEXISTING_PREVIEW=1
fi

COMPLETE=0
rollback_preview() {
  local exit_code=$?
  if [ "$COMPLETE" -eq 1 ]; then
    return
  fi
  if [ "$PREEXISTING_PREVIEW" -eq 1 ]; then
    engram_log "!! 预览更新未完成，保留既有功能资源用于检查"
    exit "$exit_code"
  fi

  set +e
  engram_log "!! 预览创建未完成，回滚本次功能 Docker 资源"
  ENGRAM_FEATURE="$FEATURE" \
  ENGRAM_PORT="$PORT" \
  ENGRAM_BUILD_NETWORK="$ENGRAM_BUILD_NETWORK" \
    docker compose "${COMPOSE_ARGS[@]}" down --remove-orphans >/dev/null 2>&1
  docker volume rm "$ENGRAM_VOLUME" >/dev/null 2>&1
  docker image rm "$ENGRAM_IMAGE" >/dev/null 2>&1
  exit "$exit_code"
}
trap rollback_preview EXIT

check_port_available

engram_log ">> 构建功能预览镜像（network=$ENGRAM_BUILD_NETWORK）"
if ! ENGRAM_FEATURE="$FEATURE" \
  ENGRAM_PORT="$PORT" \
  ENGRAM_BUILD_NETWORK="$ENGRAM_BUILD_NETWORK" \
    docker compose "${COMPOSE_ARGS[@]}" build
then
  engram_explain_offline_build_failure
  if [ "$ENGRAM_BUILD_NETWORK" = "none" ] &&
    engram_build_local_offline_preview_image "$ENGRAM_WORKTREE/main"
  then
    engram_log ">> Docker 缓存不足，已改用共享 pnpm 生成离线预览镜像"
  else
    engram_die "功能预览镜像构建失败"
  fi
fi

image_feature="$(
  docker image inspect "$ENGRAM_IMAGE" \
    --format '{{index .Config.Labels "com.engram.feature"}}'
)"
[ "$image_feature" = "$FEATURE" ] || engram_die "功能镜像缺少正确的归属标签"

if docker volume inspect "$ENGRAM_VOLUME" >/dev/null 2>&1; then
  volume_feature="$(
    docker volume inspect "$ENGRAM_VOLUME" \
      --format '{{index .Labels "com.engram.feature"}}'
  )"
  [ "$volume_feature" = "$FEATURE" ] || \
    engram_die "已有数据卷缺少正确的功能归属标签: $ENGRAM_VOLUME"
else
  engram_log ">> 创建带功能归属标签的数据卷"
  docker volume create \
    --label com.engram.scope=feature \
    --label "com.engram.feature=$FEATURE" \
    "$ENGRAM_VOLUME" >/dev/null

  engram_log ">> 从主数据卷播种隔离数据"
  docker volume inspect "$MAIN_VOLUME" >/dev/null
  MSYS_NO_PATHCONV=1 docker run --rm \
    --label com.engram.scope=feature-helper \
    --label "com.engram.feature=$FEATURE" \
    -v "$MAIN_VOLUME:/src:ro" \
    -v "$ENGRAM_VOLUME:/dst" \
    node:22-slim sh -c 'cp -a /src/. /dst/'
fi

engram_log ">> 启动功能预览"
ENGRAM_FEATURE="$FEATURE" \
ENGRAM_PORT="$PORT" \
ENGRAM_BUILD_NETWORK="$ENGRAM_BUILD_NETWORK" \
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --remove-orphans

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/"; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || engram_die "功能预览未在端口 $PORT 通过健康检查"

container_feature="$(
  docker inspect "$ENGRAM_CONTAINER" \
    --format '{{index .Config.Labels "com.engram.feature"}}'
)"
[ "$container_feature" = "$FEATURE" ] || engram_die "功能容器缺少正确的归属标签"

COMPLETE=1
engram_log "DONE: preview=http://localhost:$PORT/"
engram_log "DONE: container=$ENGRAM_CONTAINER image=$ENGRAM_IMAGE"
engram_log "DONE: volume=$ENGRAM_VOLUME project=$ENGRAM_PROJECT"
