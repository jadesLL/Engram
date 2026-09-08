#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  verify-feature.sh [--allow-downloads] <feature>

在 Docker 中运行 build、typecheck 和 test，不在 worktree 中安装 node_modules。

默认禁用构建网络，只使用本机已有基础镜像、Docker 层和构建缓存。
--allow-downloads  仅在用户已经明确批准下载依赖后使用
EOF
}

ALLOW_DOWNLOADS=0
FEATURE=""
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
      [ -z "$FEATURE" ] || {
        usage
        engram_die "只能指定一个功能名"
      }
      FEATURE="$1"
      ;;
  esac
  shift
done

[ -n "$FEATURE" ] || {
  usage
  exit 2
}

engram_init_feature "$FEATURE"
engram_require_docker
engram_require_feature_worktree
engram_configure_build_network "$ALLOW_DOWNLOADS"

for dependency_dir in \
  "$ENGRAM_WORKTREE/main/node_modules" \
  "$ENGRAM_WORKTREE/main/server/node_modules" \
  "$ENGRAM_WORKTREE/main/web/node_modules" \
  "$ENGRAM_WORKTREE/main/desktop/node_modules"
do
  if [ -e "$dependency_dir" ]; then
    engram_log "   WARN: 发现宿主机依赖目录，Docker 会忽略它: $dependency_dir"
  fi
done

engram_log ">> Docker 验证 $FEATURE（network=$ENGRAM_BUILD_NETWORK）"
if ! docker build \
  --pull=false \
  --network "$ENGRAM_BUILD_NETWORK" \
  --target verify \
  --label com.engram.scope=feature \
  --label "com.engram.feature=$FEATURE" \
  --tag "$ENGRAM_VERIFY_IMAGE" \
  "$ENGRAM_WORKTREE/main"
then
  engram_explain_offline_build_failure
  if [ "$ENGRAM_BUILD_NETWORK" = "none" ] &&
    engram_run_local_offline_verification "$ENGRAM_WORKTREE/main"
  then
    docker image rm "$ENGRAM_VERIFY_IMAGE" >/dev/null 2>&1 || true
    engram_log "DONE: $FEATURE 已通过本机临时目录离线 build、typecheck 和 test"
    exit 0
  fi
  engram_die "Docker build/typecheck/test 未通过"
fi

image_feature="$(
  docker image inspect "$ENGRAM_VERIFY_IMAGE" \
    --format '{{index .Config.Labels "com.engram.feature"}}'
)"
[ "$image_feature" = "$FEATURE" ] || \
  engram_die "验证镜像缺少正确的功能归属标签"

engram_log "DONE: $FEATURE 已在 Docker 中通过 build、typecheck 和 test"
engram_log "DONE: verify_image=$ENGRAM_VERIFY_IMAGE"
