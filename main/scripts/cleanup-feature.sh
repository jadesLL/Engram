#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  cleanup-feature.sh [--inspect] <feature>
  cleanup-feature.sh --docker-only <feature>

默认模式仅允许清理已经并入 main 且 worktree 干净的功能，并同时删除：
  - 功能 Docker 容器、数据卷、网络和镜像
  - Git worktree 和已合并功能分支

--inspect      只报告状态，不删除
--docker-only  仅清理 Docker 功能资源；用于创建失败回滚和隔离测试
EOF
}

MODE="all"
if [ "${1:-}" = "--inspect" ]; then
  MODE="inspect"
  shift
elif [ "${1:-}" = "--docker-only" ]; then
  MODE="docker-only"
  shift
fi

FEATURE="${1:-}"
[ -n "$FEATURE" ] || {
  usage
  exit 2
}
[ "$#" -eq 1 ] || {
  usage
  exit 2
}

engram_init_feature "$FEATURE"

if [ "$MODE" = "inspect" ]; then
  engram_print_feature_status
  exit 0
fi

if [ "$MODE" = "docker-only" ]; then
  engram_cleanup_feature_docker
  engram_log "DONE: $FEATURE 的 Docker 功能资源已清理并复验"
  exit 0
fi

engram_acquire_merge_lock
engram_assert_feature_cleanup_safe
engram_cleanup_feature_docker
engram_cleanup_feature_git
engram_log "DONE: $FEATURE 的 worktree、分支和 Docker 功能资源已全部清理并复验"
