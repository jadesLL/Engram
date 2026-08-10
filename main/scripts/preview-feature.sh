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
      exampleproject_die "未知参数: $1"
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

exampleproject_init_feature "$FEATURE"
exampleproject_require_docker
exampleproject_require_feature_worktree
exampleproject_configure_build_network "$ALLOW_DOWNLOADS"
MAIN_VOLUME="${WIKILLM_MAIN_VOLUME:-example-wiki-data}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  exampleproject_die "端口必须是 1-65535 之间的整数，当前值: $PORT"
fi
[ "$PORT" -ne 8080 ] || exampleproject_die "8080 为 main 保留端口"

VERIFY_ARGS=("$FEATURE")
if [ "$ALLOW_DOWNLOADS" -eq 1 ]; then
  VERIFY_ARGS=(--allow-downloads "$FEATURE")
fi
exampleproject_log ">> 预览前重新验证当前 worktree"
bash "$SCRIPT_DIR/verify-feature.sh" "${VERIFY_ARGS[@]}"

COMPOSE_ARGS=(
  --project-name "$WIKILLM_PROJECT"
  -f "$WIKILLM_WORKTREE/main/docker-compose.worktree.yml"
)

check_port_available() {
  local current_port=""
  if docker container inspect "$WIKILLM_CONTAINER" >/dev/null 2>&1; then
    current_port="$(
      docker port "$WIKILLM_CONTAINER" 8080/tcp 2>/dev/null |
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
if docker container inspect "$WIKILLM_CONTAINER" >/dev/null 2>&1 ||
  docker volume inspect "$WIKILLM_VOLUME" >/dev/null 2>&1 ||
  docker image inspect "$WIKILLM_IMAGE" >/dev/null 2>&1 ||
  [ -n "$(exampleproject_feature_network_names)" ]
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
    exampleproject_log "!! 预览更新未完成，保留既有功能资源用于检查"
    exit "$exit_code"
  fi

  set +e
  exampleproject_log "!! 预览创建未完成，回滚本次功能 Docker 资源"
  WIKILLM_FEATURE="$FEATURE" \
  WIKILLM_PORT="$PORT" \
  WIKILLM_BUILD_NETWORK="$WIKILLM_BUILD_NETWORK" \
    docker compose "${COMPOSE_ARGS[@]}" down --remove-orphans >/dev/null 2>&1
  docker volume rm "$WIKILLM_VOLUME" >/dev/null 2>&1
  docker image rm "$WIKILLM_IMAGE" >/dev/null 2>&1
  exit "$exit_code"
}
trap rollback_preview EXIT

check_port_available

exampleproject_log ">> 构建功能预览镜像（network=$WIKILLM_BUILD_NETWORK）"
if ! WIKILLM_FEATURE="$FEATURE" \
  WIKILLM_PORT="$PORT" \
  WIKILLM_BUILD_NETWORK="$WIKILLM_BUILD_NETWORK" \
    docker compose "${COMPOSE_ARGS[@]}" build
then
  exampleproject_explain_offline_build_failure
  if [ "$WIKILLM_BUILD_NETWORK" = "none" ] &&
    exampleproject_build_local_offline_preview_image "$WIKILLM_WORKTREE/main"
  then
    exampleproject_log ">> Docker 缓存不足，已改用共享 pnpm 生成离线预览镜像"
  else
    exampleproject_die "功能预览镜像构建失败"
  fi
fi

image_feature="$(
  docker image inspect "$WIKILLM_IMAGE" \
    --format '{{index .Config.Labels "com.exampleproject.feature"}}'
)"
[ "$image_feature" = "$FEATURE" ] || exampleproject_die "功能镜像缺少正确的归属标签"

if docker volume inspect "$WIKILLM_VOLUME" >/dev/null 2>&1; then
  volume_feature="$(
    docker volume inspect "$WIKILLM_VOLUME" \
      --format '{{index .Labels "com.exampleproject.feature"}}'
  )"
  [ "$volume_feature" = "$FEATURE" ] || \
    exampleproject_die "已有数据卷缺少正确的功能归属标签: $WIKILLM_VOLUME"
else
  exampleproject_log ">> 创建带功能归属标签的数据卷"
  docker volume create \
    --label com.exampleproject.scope=feature \
    --label "com.exampleproject.feature=$FEATURE" \
    "$WIKILLM_VOLUME" >/dev/null

  exampleproject_log ">> 从主数据卷播种隔离数据"
  docker volume inspect "$MAIN_VOLUME" >/dev/null
  MSYS_NO_PATHCONV=1 docker run --rm \
    --label com.exampleproject.scope=feature-helper \
    --label "com.exampleproject.feature=$FEATURE" \
    -v "$MAIN_VOLUME:/src:ro" \
    -v "$WIKILLM_VOLUME:/dst" \
    node:22-slim sh -c 'cp -a /src/. /dst/'
fi

exampleproject_log ">> 启动功能预览"
WIKILLM_FEATURE="$FEATURE" \
WIKILLM_PORT="$PORT" \
WIKILLM_BUILD_NETWORK="$WIKILLM_BUILD_NETWORK" \
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --remove-orphans

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/"; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || exampleproject_die "功能预览未在端口 $PORT 通过健康检查"

container_feature="$(
  docker inspect "$WIKILLM_CONTAINER" \
    --format '{{index .Config.Labels "com.exampleproject.feature"}}'
)"
[ "$container_feature" = "$FEATURE" ] || exampleproject_die "功能容器缺少正确的归属标签"

COMPLETE=1
exampleproject_log "DONE: preview=http://localhost:$PORT/"
exampleproject_log "DONE: container=$WIKILLM_CONTAINER image=$WIKILLM_IMAGE"
exampleproject_log "DONE: volume=$WIKILLM_VOLUME project=$WIKILLM_PROJECT"
