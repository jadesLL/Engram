#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  merge-feature.sh [--deploy] <feature>
  merge-feature.sh --finish [--deploy] <feature>

默认流程：
  1. 串行合并 feat/<feature> 到 main
  2. 在 main 运行 test、typecheck 和 build
  3. 精确清理该功能的 Docker 资源、worktree 和分支
  4. 复验所有功能资源均无残留

--deploy  在检查通过后重建并部署主环境；必须获得独立的部署批准
--finish  合并已完成或冲突已解决后，继续检查、可选部署和清理
EOF
}

DEPLOY=0
FINISH=0
FEATURE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deploy)
      DEPLOY=1
      ;;
    --finish)
      FINISH=1
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
exampleproject_acquire_merge_lock
DEPLOY_FLAG=""
if [ "$DEPLOY" -eq 1 ]; then
  DEPLOY_FLAG=" --deploy"
fi

if [ ! -d "$WIKILLM_MAIN_DIR" ]; then
  exampleproject_die "主应用目录不存在: $WIKILLM_MAIN_DIR"
fi
if [ -n "$(git -C "$WIKILLM_REPO_ROOT" status --porcelain)" ]; then
  git -C "$WIKILLM_REPO_ROOT" status --short >&2
  exampleproject_die "main 工作区有未提交改动，拒绝合并"
fi
if ! git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
  exampleproject_die "功能分支不存在: $WIKILLM_BRANCH"
fi
if [ -e "$WIKILLM_WORKTREE" ]; then
  FEATURE_STATUS="$(
    git -c "safe.directory=$WIKILLM_WORKTREE" \
      -C "$WIKILLM_WORKTREE" status --porcelain
  )"
  if [ -n "$FEATURE_STATUS" ]; then
    printf '%s\n' "$FEATURE_STATUS" >&2
    exampleproject_die "功能 worktree 有未提交改动，拒绝合并"
  fi
fi

git -C "$WIKILLM_REPO_ROOT" switch main

if git -C "$WIKILLM_REPO_ROOT" merge-base --is-ancestor "$WIKILLM_BRANCH" main; then
  exampleproject_log ">> $WIKILLM_BRANCH 已在 main 中，继续检查和清理"
elif [ "$FINISH" -eq 1 ]; then
  exampleproject_die "--finish 要求 $WIKILLM_BRANCH 已完整并入 main"
else
  exampleproject_log ">> 合并 $WIKILLM_BRANCH -> main"
  if ! git -C "$WIKILLM_REPO_ROOT" merge --no-ff --no-edit "$WIKILLM_BRANCH"; then
    cat >&2 <<EOF
!! 合并发生冲突。解决并提交后运行：
   bash main/scripts/merge-feature.sh --finish$DEPLOY_FLAG $FEATURE
功能 worktree 和 Docker 预览资源已保留。
EOF
    exit 1
  fi
fi

if git -C "$WIKILLM_REPO_ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  exampleproject_die "main 仍处于未完成的合并状态"
fi
if ! git -C "$WIKILLM_REPO_ROOT" merge-base --is-ancestor "$WIKILLM_BRANCH" main; then
  exampleproject_die "合并后分支仍不是 main 的祖先，拒绝继续"
fi

cleanup_local_verification() {
  local verify_dir="$1"
  local verify_dir_windows=""
  local failed=0

  if command -v cygpath >/dev/null 2>&1 && command -v powershell.exe >/dev/null 2>&1; then
    verify_dir_windows="$(cygpath -w "$verify_dir")"
    if ! WIKILLM_VERIFY_TEMP="$verify_dir_windows" powershell.exe -NoProfile -Command \
      '$target=$env:WIKILLM_VERIFY_TEMP; $root=Join-Path $env:LOCALAPPDATA "pnpm\store\v11\projects"; if (Test-Path -LiteralPath $root) { Get-ChildItem -Force -LiteralPath $root | Where-Object { ($_.Target -join "") -eq $target } | Remove-Item -Force }' \
      >/dev/null
    then
      failed=1
    fi
  fi

  case "$verify_dir" in
    /tmp/exampleproject-verify.*)
      rm -rf -- "$verify_dir" || failed=1
      ;;
    *)
      printf '!! 拒绝删除意外验证路径: %s\n' "$verify_dir" >&2
      failed=1
      ;;
  esac
  return "$failed"
}

run_main_checks_in_local_temp() {
  command -v pnpm >/dev/null 2>&1 || exampleproject_die "未找到 pnpm，无法执行离线验证"
  command -v cygpath >/dev/null 2>&1 || exampleproject_die "未找到 cygpath，无法建立本地验证环境"

  local verify_dir local_app_data native_cache native_source=""
  local check_status=0 cleanup_status=0
  local -a native_candidates=()
  local -a native_targets=()
  verify_dir="$(mktemp -d -t exampleproject-verify.XXXXXX)"
  local_app_data="$(cygpath -u "${LOCALAPPDATA:?LOCALAPPDATA 未设置}")"
  native_cache="$local_app_data/ExampleProject/verification-native"

  shopt -s nullglob
  native_candidates=(
    "$native_cache"/better-sqlite3@*/better_sqlite3.node
    "$WIKILLM_MAIN_DIR"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
    "$(cygpath -u "${TEMP:-${TMP:-/tmp}}")"/ExampleProject-*/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
  )
  if [ "${#native_candidates[@]}" -gt 0 ]; then
    native_source="${native_candidates[0]}"
  fi

  exampleproject_log ">> UNC 环境使用本机临时目录离线检查"
  set +e
  (
    set -euo pipefail
    [ -n "$native_source" ] || {
      printf '!! 缺少本地 better_sqlite3.node，无法离线运行服务端测试\n' >&2
      exit 1
    }
    git -C "$WIKILLM_REPO_ROOT" archive --format=tar HEAD \
      main/package.json \
      main/pnpm-workspace.yaml \
      main/pnpm-lock.yaml \
      main/server \
      main/web \
      main/desktop |
      tar -xf - -C "$verify_dir" --strip-components=1
    cd "$verify_dir"
    pnpm install --offline --frozen-lockfile --ignore-scripts
    native_targets=(
      "$verify_dir"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
    )
    [ "${#native_targets[@]}" -eq 1 ]
    mkdir -p "${native_targets[0]}/build/Release"
    cp "$native_source" "${native_targets[0]}/build/Release/better_sqlite3.node"
    pnpm test
    pnpm typecheck
    pnpm build
  )
  check_status=$?
  set -e

  cleanup_local_verification "$verify_dir" || cleanup_status=$?
  [ "$check_status" -eq 0 ] || exampleproject_die "本地离线 test/typecheck/build 未通过"
  [ "$cleanup_status" -eq 0 ] || exampleproject_die "验证通过，但本地临时验证环境清理失败"
}

exampleproject_log ">> 在 main 运行合并后检查"
case "$WIKILLM_MAIN_DIR" in
  //*) run_main_checks_in_local_temp ;;
  *)
    (
      cd "$WIKILLM_MAIN_DIR"
      pnpm test
      pnpm typecheck
      pnpm build
    )
    ;;
esac

deploy_main() {
  exampleproject_require_docker

  local revision image compose_args
  revision="$(git -C "$WIKILLM_REPO_ROOT" rev-parse --short=12 HEAD)"
  image="example-wiki:main-$revision"
  compose_args=(
    --project-name main
    -f "$WIKILLM_MAIN_DIR/docker-compose.unc.yml"
    -f "$WIKILLM_MAIN_DIR/docker-compose.local-deploy.yml"
  )

  exampleproject_log ">> 构建主镜像 $image"
  bash "$SCRIPT_DIR/ensure-office-env.sh" "$WIKILLM_MAIN_DIR"
  docker build \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.source=local-main" \
    --tag "$image" \
    --tag example-wiki:local-current \
    "$WIKILLM_MAIN_DIR"

  if docker ps --format '{{.Names}}' | grep -Fx example-wiki-onlyoffice >/dev/null; then
    docker exec example-wiki-onlyoffice documentserver-prepare4shutdown.sh >/dev/null 2>&1 || \
      exampleproject_log "   WARN: ONLYOFFICE 未响应优雅关闭请求，继续由 Compose 重启"
    docker compose "${compose_args[@]}" stop onlyoffice
  fi

  exampleproject_log ">> 部署主环境"
  docker compose "${compose_args[@]}" up -d --no-build --remove-orphans

  local ready=0
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null http://localhost:8080/ &&
      curl -fsS -o /dev/null http://localhost:8080/onlyoffice/healthcheck
    then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" -ne 1 ]; then
    exampleproject_die "主环境未通过健康检查；保留功能资源用于回退"
  fi
  exampleproject_log "   主环境与 ONLYOFFICE 健康检查通过"
  exampleproject_cleanup_old_main_images
}

if [ "$DEPLOY" -eq 1 ]; then
  deploy_main
else
  exampleproject_log ">> 未传入 --deploy：不改动主环境部署"
fi

WIKILLM_LOCK_HELD=1 bash "$SCRIPT_DIR/cleanup-feature.sh" "$FEATURE"
exampleproject_log "DONE: $FEATURE 已合并、检查通过，功能资源已全部清理"
if [ "$DEPLOY" -eq 1 ]; then
  exampleproject_log "DONE: main 已部署并清理未被引用的旧主镜像"
fi
