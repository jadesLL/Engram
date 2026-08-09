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
      exampleproject_die "未知参数: $1"
      ;;
    *)
      [ -z "$FEATURE" ] || {
        usage
        exampleproject_die "只能指定一个功能名"
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

exampleproject_init_feature "$FEATURE"
exampleproject_require_docker
exampleproject_require_feature_worktree
exampleproject_configure_build_network "$ALLOW_DOWNLOADS"

for dependency_dir in \
  "$WIKILLM_WORKTREE/main/node_modules" \
  "$WIKILLM_WORKTREE/main/server/node_modules" \
  "$WIKILLM_WORKTREE/main/web/node_modules" \
  "$WIKILLM_WORKTREE/main/desktop/node_modules"
do
  if [ -e "$dependency_dir" ]; then
    exampleproject_log "   WARN: 发现宿主机依赖目录，Docker 会忽略它: $dependency_dir"
  fi
done

exampleproject_log ">> Docker 验证 $FEATURE（network=$WIKILLM_BUILD_NETWORK）"
if ! docker build \
  --pull=false \
  --network "$WIKILLM_BUILD_NETWORK" \
  --target verify \
  --label com.exampleproject.scope=feature \
  --label "com.exampleproject.feature=$FEATURE" \
  --tag "$WIKILLM_VERIFY_IMAGE" \
  "$WIKILLM_WORKTREE/main"
then
  exampleproject_explain_offline_build_failure
  exampleproject_die "Docker build/typecheck/test 未通过"
fi

image_feature="$(
  docker image inspect "$WIKILLM_VERIFY_IMAGE" \
    --format '{{index .Config.Labels "com.exampleproject.feature"}}'
)"
[ "$image_feature" = "$FEATURE" ] || \
  exampleproject_die "验证镜像缺少正确的功能归属标签"

exampleproject_log "DONE: $FEATURE 已在 Docker 中通过 build、typecheck 和 test"
exampleproject_log "DONE: verify_image=$WIKILLM_VERIFY_IMAGE"
