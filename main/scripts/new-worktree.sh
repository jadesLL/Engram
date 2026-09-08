#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  new-worktree.sh <feature>

示例:
  bash main/scripts/new-worktree.sh search-export

只创建功能分支和 worktree，不安装 pnpm 依赖，也不创建 Docker 资源。
完成代码修改后使用 verify-feature.sh 验证，按需使用 preview-feature.sh 启动预览。
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

FEATURE="${1:-}"
[ "$#" -eq 1 ] || {
  usage
  exit 2
}

engram_init_feature "$FEATURE"

check_absent() {
  [ ! -e "$ENGRAM_WORKTREE" ] || engram_die "worktree 已存在: $ENGRAM_WORKTREE"
  if git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"; then
    engram_die "分支已存在: $ENGRAM_BRANCH"
  fi
}

COMPLETE=0
rollback_creation() {
  local exit_code=$?
  if [ "$COMPLETE" -eq 1 ]; then
    return
  fi
  set +e
  engram_log "!! 创建未完成，回滚本次 Git worktree"
  if [ -e "$ENGRAM_WORKTREE" ]; then
    git -C "$ENGRAM_REPO_ROOT" worktree remove "$ENGRAM_WORKTREE"
  fi
  if git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"; then
    git -C "$ENGRAM_REPO_ROOT" branch -d "$ENGRAM_BRANCH"
  fi
  for safe_value in "$ENGRAM_SAFE_DIRECTORY" "$ENGRAM_WORKTREE"; do
    if git config --global --get-all safe.directory 2>/dev/null |
      grep -Fx "$safe_value" >/dev/null
    then
      git config --global --fixed-value --unset-all safe.directory "$safe_value"
    fi
  done
  git -C "$ENGRAM_REPO_ROOT" worktree prune
  exit "$exit_code"
}
trap rollback_creation EXIT

engram_log ">> 检查 worktree 与分支名称"
check_absent

engram_log ">> 创建 worktree $ENGRAM_WORKTREE"
git -C "$ENGRAM_REPO_ROOT" worktree add "$ENGRAM_WORKTREE" -b "$ENGRAM_BRANCH" main

if ! git config --global --get-all safe.directory | grep -Fx "$ENGRAM_SAFE_DIRECTORY" >/dev/null; then
  git config --global --add safe.directory "$ENGRAM_SAFE_DIRECTORY"
fi

for dependency_dir in \
  "$ENGRAM_WORKTREE/main/node_modules" \
  "$ENGRAM_WORKTREE/main/server/node_modules" \
  "$ENGRAM_WORKTREE/main/web/node_modules" \
  "$ENGRAM_WORKTREE/main/desktop/node_modules"
do
  [ ! -e "$dependency_dir" ] || \
    engram_die "新 worktree 不应包含宿主机依赖目录: $dependency_dir"
done

COMPLETE=1
engram_log "DONE: worktree=$ENGRAM_WORKTREE"
engram_log "DONE: branch=$ENGRAM_BRANCH"
engram_log "NEXT: bash main/scripts/verify-feature.sh $FEATURE"
engram_log "NEXT: bash main/scripts/preview-feature.sh $FEATURE <host-port>"
