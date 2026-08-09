#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  new-worktree.sh <feature> <host-port>

示例:
  bash main/scripts/new-worktree.sh search-export 8082
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

FEATURE="${1:-}"
PORT="${2:-}"
[ "$#" -eq 2 ] || {
  usage
  exit 2
}

exampleproject_init_feature "$FEATURE"
exampleproject_require_docker
MAIN_VOLUME="${WIKILLM_MAIN_VOLUME:-example-wiki-data}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  exampleproject_die "端口必须是 1-65535 之间的整数，当前值: $PORT"
fi
[ "$PORT" -ne 8080 ] || exampleproject_die "8080 为 main 保留端口"

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

check_absent() {
  [ ! -e "$WIKILLM_WORKTREE" ] || exampleproject_die "worktree 已存在: $WIKILLM_WORKTREE"
  if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
    exampleproject_die "分支已存在: $WIKILLM_BRANCH"
  fi
  [ -z "$(exampleproject_feature_container_ids)" ] || exampleproject_die "功能容器已存在"
  [ -z "$(exampleproject_feature_volume_names)" ] || exampleproject_die "功能数据卷已存在"
  [ -z "$(exampleproject_feature_network_names)" ] || exampleproject_die "功能网络已存在"
  [ -z "$(exampleproject_feature_image_ids)" ] || exampleproject_die "带功能标签的镜像已存在"
  if docker image inspect "$WIKILLM_IMAGE" >/dev/null 2>&1; then
    exampleproject_die "功能镜像标签已存在: $WIKILLM_IMAGE"
  fi
}

COMPLETE=0
rollback_creation() {
  local exit_code=$?
  if [ "$COMPLETE" -eq 1 ]; then
    return
  fi
  set +e
  exampleproject_log "!! 创建未完成，回滚本次功能资源"
  WIKILLM_LOCK_HELD=0 bash "$SCRIPT_DIR/cleanup-feature.sh" --docker-only "$FEATURE"
  if [ -e "$WIKILLM_WORKTREE" ]; then
    git -C "$WIKILLM_REPO_ROOT" worktree remove "$WIKILLM_WORKTREE"
  fi
  if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
    git -C "$WIKILLM_REPO_ROOT" branch -d "$WIKILLM_BRANCH"
  fi
  for safe_value in "$WIKILLM_SAFE_DIRECTORY" "$WIKILLM_WORKTREE"; do
    if git config --global --get-all safe.directory 2>/dev/null |
      grep -Fx "$safe_value" >/dev/null
    then
      git config --global --fixed-value --unset-all safe.directory "$safe_value"
    fi
  done
  git -C "$WIKILLM_REPO_ROOT" worktree prune
  exit "$exit_code"
}
trap rollback_creation EXIT

exampleproject_log ">> 检查端口与资源名"
check_port_available
check_absent

exampleproject_log ">> 创建 worktree $WIKILLM_WORKTREE"
git -C "$WIKILLM_REPO_ROOT" worktree add "$WIKILLM_WORKTREE" -b "$WIKILLM_BRANCH" main

if ! git config --global --get-all safe.directory | grep -Fx "$WIKILLM_SAFE_DIRECTORY" >/dev/null; then
  git config --global --add safe.directory "$WIKILLM_SAFE_DIRECTORY"
fi

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

exampleproject_log ">> 构建并启动功能预览"
WIKILLM_FEATURE="$FEATURE" WIKILLM_PORT="$PORT" \
  docker compose \
    --project-name "$WIKILLM_PROJECT" \
    -f "$WIKILLM_WORKTREE/main/docker-compose.worktree.yml" \
    up -d --build

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
image_feature="$(
  docker image inspect "$WIKILLM_IMAGE" \
    --format '{{index .Config.Labels "com.exampleproject.feature"}}'
)"
[ "$image_feature" = "$FEATURE" ] || exampleproject_die "功能镜像缺少正确的归属标签"

COMPLETE=1
exampleproject_log "DONE: worktree=$WIKILLM_WORKTREE"
exampleproject_log "DONE: branch=$WIKILLM_BRANCH container=$WIKILLM_CONTAINER image=$WIKILLM_IMAGE"
exampleproject_log "DONE: port=$PORT volume=$WIKILLM_VOLUME project=$WIKILLM_PROJECT"
