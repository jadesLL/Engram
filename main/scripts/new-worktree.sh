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

exampleproject_init_feature "$FEATURE"

check_absent() {
  [ ! -e "$WIKILLM_WORKTREE" ] || exampleproject_die "worktree 已存在: $WIKILLM_WORKTREE"
  if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
    exampleproject_die "分支已存在: $WIKILLM_BRANCH"
  fi
}

COMPLETE=0
rollback_creation() {
  local exit_code=$?
  if [ "$COMPLETE" -eq 1 ]; then
    return
  fi
  set +e
  exampleproject_log "!! 创建未完成，回滚本次 Git worktree"
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

exampleproject_log ">> 检查 worktree 与分支名称"
check_absent

exampleproject_log ">> 创建 worktree $WIKILLM_WORKTREE"
git -C "$WIKILLM_REPO_ROOT" worktree add "$WIKILLM_WORKTREE" -b "$WIKILLM_BRANCH" main

if ! git config --global --get-all safe.directory | grep -Fx "$WIKILLM_SAFE_DIRECTORY" >/dev/null; then
  git config --global --add safe.directory "$WIKILLM_SAFE_DIRECTORY"
fi

for dependency_dir in \
  "$WIKILLM_WORKTREE/main/node_modules" \
  "$WIKILLM_WORKTREE/main/server/node_modules" \
  "$WIKILLM_WORKTREE/main/web/node_modules" \
  "$WIKILLM_WORKTREE/main/desktop/node_modules"
do
  [ ! -e "$dependency_dir" ] || \
    exampleproject_die "新 worktree 不应包含宿主机依赖目录: $dependency_dir"
done

COMPLETE=1
exampleproject_log "DONE: worktree=$WIKILLM_WORKTREE"
exampleproject_log "DONE: branch=$WIKILLM_BRANCH"
exampleproject_log "NEXT: bash main/scripts/verify-feature.sh $FEATURE"
exampleproject_log "NEXT: bash main/scripts/preview-feature.sh $FEATURE <host-port>"
