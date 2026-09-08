#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=worktree-common.sh
source "$SCRIPT_DIR/worktree-common.sh"

usage() {
  cat <<'EOF'
用法:
  merge-feature.sh [--allow-downloads] [--deploy] <feature>
  merge-feature.sh --finish [--allow-downloads] [--deploy] <feature>

默认流程：
  1. 串行合并 feat/<feature> 到 main
  2. 在 Docker 中运行 build、typecheck 和 test
  3. 精确清理该功能的 Docker 资源、worktree 和分支
  4. 复验所有功能资源均无残留

--deploy  在检查通过后重建并部署主环境；必须获得独立的部署批准
--finish  合并已完成或冲突已解决后，继续检查、可选部署和清理
--allow-downloads  仅在用户已经明确批准下载依赖后使用
EOF
}

DEPLOY=0
FINISH=0
ALLOW_DOWNLOADS=0
FEATURE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deploy)
      DEPLOY=1
      ;;
    --finish)
      FINISH=1
      ;;
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
engram_configure_build_network "$ALLOW_DOWNLOADS"
engram_acquire_merge_lock
DEPLOY_FLAG=""
if [ "$DEPLOY" -eq 1 ]; then
  DEPLOY_FLAG=" --deploy"
fi
DOWNLOAD_FLAG=""
if [ "$ALLOW_DOWNLOADS" -eq 1 ]; then
  DOWNLOAD_FLAG=" --allow-downloads"
fi

if [ ! -d "$ENGRAM_MAIN_DIR" ]; then
  engram_die "主应用目录不存在: $ENGRAM_MAIN_DIR"
fi
if [ -n "$(git -C "$ENGRAM_REPO_ROOT" status --porcelain)" ]; then
  git -C "$ENGRAM_REPO_ROOT" status --short >&2
  engram_die "main 工作区有未提交改动，拒绝合并"
fi
if ! git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"; then
  engram_die "功能分支不存在: $ENGRAM_BRANCH"
fi
if [ -e "$ENGRAM_WORKTREE" ]; then
  FEATURE_STATUS="$(
    git -c "safe.directory=$ENGRAM_WORKTREE" \
      -C "$ENGRAM_WORKTREE" status --porcelain
  )"
  if [ -n "$FEATURE_STATUS" ]; then
    printf '%s\n' "$FEATURE_STATUS" >&2
    engram_die "功能 worktree 有未提交改动，拒绝合并"
  fi
fi

git -C "$ENGRAM_REPO_ROOT" switch main

if git -C "$ENGRAM_REPO_ROOT" merge-base --is-ancestor "$ENGRAM_BRANCH" main; then
  engram_log ">> $ENGRAM_BRANCH 已在 main 中，继续检查和清理"
elif [ "$FINISH" -eq 1 ]; then
  engram_die "--finish 要求 $ENGRAM_BRANCH 已完整并入 main"
else
  engram_log ">> 合并 $ENGRAM_BRANCH -> main"
  if ! git -C "$ENGRAM_REPO_ROOT" merge --no-ff --no-edit "$ENGRAM_BRANCH"; then
    cat >&2 <<EOF
!! 合并发生冲突。解决并提交后运行：
   bash main/scripts/merge-feature.sh --finish$DEPLOY_FLAG$DOWNLOAD_FLAG $FEATURE
功能 worktree 和 Docker 预览资源已保留。
EOF
    exit 1
  fi
fi

if git -C "$ENGRAM_REPO_ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  engram_die "main 仍处于未完成的合并状态"
fi
if ! git -C "$ENGRAM_REPO_ROOT" merge-base --is-ancestor "$ENGRAM_BRANCH" main; then
  engram_die "合并后分支仍不是 main 的祖先，拒绝继续"
fi

run_main_checks_in_docker() {
  local revision verify_image
  revision="$(git -C "$ENGRAM_REPO_ROOT" rev-parse --short=12 HEAD)"
  verify_image="engram:pre-$revision"

  if docker image inspect "$verify_image" >/dev/null 2>&1; then
    docker image rm "$verify_image" >/dev/null
  fi

  engram_log ">> 在 Docker 中运行合并后 build/typecheck/test（network=$ENGRAM_BUILD_NETWORK）"
  if ! docker build \
    --pull=false \
    --network "$ENGRAM_BUILD_NETWORK" \
    --target verify \
    --label com.engram.scope=main-verification \
    --label "org.opencontainers.image.revision=$revision" \
    --tag "$verify_image" \
    "$ENGRAM_MAIN_DIR"
  then
    engram_explain_offline_build_failure
    if [ "$ENGRAM_BUILD_NETWORK" = "none" ] &&
      engram_run_local_offline_verification "$ENGRAM_MAIN_DIR"
    then
      docker image rm "$verify_image" >/dev/null 2>&1 || true
      return
    fi
    engram_die "合并后的 Docker build/typecheck/test 未通过"
  fi

  docker image rm "$verify_image" >/dev/null || \
    engram_die "检查通过，但临时验证镜像标签清理失败: $verify_image"
}

run_main_checks_in_docker

deploy_main() {
  local revision image compose_project="main" app_project="" office_project="" compose_args
  revision="$(git -C "$ENGRAM_REPO_ROOT" rev-parse --short=12 HEAD)"
  image="engram:main-$revision"
  if docker container inspect engram-onlyoffice >/dev/null 2>&1; then
    office_project="$(
      docker container inspect engram-onlyoffice \
        --format '{{index .Config.Labels "com.docker.compose.project"}}'
    )"
  fi
  if docker container inspect engram >/dev/null 2>&1; then
    app_project="$(
      docker container inspect engram \
        --format '{{index .Config.Labels "com.docker.compose.project"}}'
    )"
  fi
  if [ -n "$office_project" ]; then
    compose_project="$office_project"
  elif [ -n "$app_project" ]; then
    compose_project="$app_project"
  fi
  compose_args=(
    --project-name "$compose_project"
    -f "$ENGRAM_MAIN_DIR/docker-compose.unc.yml"
    -f "$ENGRAM_MAIN_DIR/docker-compose.local-deploy.yml"
  )

  engram_log ">> 构建主镜像 $image"
  bash "$SCRIPT_DIR/ensure-office-env.sh" "$ENGRAM_MAIN_DIR"
  if ! docker build \
    --pull=false \
    --network "$ENGRAM_BUILD_NETWORK" \
    --build-arg "ENGRAM_GIT_SHA=$revision" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.source=local-main" \
    --tag "$image" \
    --tag engram:local-current \
    "$ENGRAM_MAIN_DIR"
  then
    engram_explain_offline_build_failure
    if [ "$ENGRAM_BUILD_NETWORK" = "none" ] &&
      engram_build_local_offline_main_image \
        "$ENGRAM_MAIN_DIR" \
        "$image" \
        "$revision" \
        engram:local-current
    then
      engram_log ">> Docker 缓存不足，已改用共享 pnpm 生成离线主镜像"
    else
      engram_die "主镜像构建失败"
    fi
  fi

  if docker ps --format '{{.Names}}' | grep -Fx engram-onlyoffice >/dev/null; then
    docker exec engram-onlyoffice documentserver-prepare4shutdown.sh >/dev/null 2>&1 || \
      engram_log "   WARN: ONLYOFFICE 未响应优雅关闭请求，继续由 Compose 重启"
    docker compose "${compose_args[@]}" stop onlyoffice
  fi
  if docker container inspect engram >/dev/null 2>&1 &&
    [ -n "$app_project" ] &&
    [ "$app_project" != "$compose_project" ]
  then
    engram_log ">> 应用容器属于 Compose 项目 $app_project，改由 $compose_project 接管"
    docker container rm -f engram >/dev/null
  fi

  engram_log ">> 部署主环境（Compose project=$compose_project）"
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
    engram_die "主环境未通过健康检查；保留功能资源用于回退"
  fi
  engram_log "   主环境与 ONLYOFFICE 健康检查通过"
  engram_cleanup_old_main_images
}

if [ "$DEPLOY" -eq 1 ]; then
  deploy_main
else
  engram_log ">> 未传入 --deploy：不改动主环境部署"
fi

ENGRAM_LOCK_HELD=1 bash "$SCRIPT_DIR/cleanup-feature.sh" "$FEATURE"
engram_log "DONE: $FEATURE 已合并、检查通过，功能资源已全部清理"
if [ "$DEPLOY" -eq 1 ]; then
  engram_log "DONE: main 已部署并清理未被引用的旧主镜像"
fi
