#!/usr/bin/env bash

set -euo pipefail

exampleproject_log() {
  printf '%s\n' "$*"
}

exampleproject_die() {
  printf '!! %s\n' "$*" >&2
  exit 1
}

exampleproject_validate_feature() {
  local feature="${1:-}"
  if ! [[ "$feature" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    exampleproject_die "功能名只能包含小写字母、数字和中划线，当前值: ${feature:-<empty>}"
  fi
}

exampleproject_discover_repo_root() {
  if [ -n "${WIKILLM_REPO_ROOT:-}" ]; then
    (
      cd "$WIKILLM_REPO_ROOT"
      pwd -P
    )
    return
  fi

  local script_dir app_dir checkout_root common_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  app_dir="$(cd "$script_dir/.." && pwd -P)"
  checkout_root="$(cd "$app_dir/.." && pwd -P)"
  if ! common_dir="$(
    git -c "safe.directory=$checkout_root" \
      -C "$app_dir" rev-parse --path-format=absolute --git-common-dir
  )"; then
    exampleproject_die "无法从脚本位置识别 Git common directory: $app_dir"
  fi
  (
    cd "$common_dir/.."
    pwd -P
  )
}

exampleproject_init_feature() {
  local feature="$1"
  exampleproject_validate_feature "$feature"

  WIKILLM_FEATURE="$feature"
  WIKILLM_REPO_ROOT="$(exampleproject_discover_repo_root)"
  WIKILLM_MAIN_DIR="$WIKILLM_REPO_ROOT/main"
  WIKILLM_WORKTREE="$WIKILLM_REPO_ROOT/worktrees/$feature"
  WIKILLM_BRANCH="feat/$feature"
  WIKILLM_PROJECT="exampleproject-$feature"
  WIKILLM_IMAGE="example-wiki:$feature"
  WIKILLM_CONTAINER="example-wiki-$feature"
  WIKILLM_ONLYOFFICE_CONTAINER="example-wiki-$feature-onlyoffice"
  WIKILLM_VOLUME="example-wiki-data-$feature"
  WIKILLM_SAFE_DIRECTORY="%(prefix)/$WIKILLM_WORKTREE"

  case "$WIKILLM_WORKTREE" in
    "$WIKILLM_REPO_ROOT"/worktrees/*) ;;
    *) exampleproject_die "拒绝操作工作区之外的路径: $WIKILLM_WORKTREE" ;;
  esac
}

exampleproject_require_docker() {
  command -v docker >/dev/null 2>&1 || exampleproject_die "未找到 docker 命令"
  docker info >/dev/null 2>&1 || exampleproject_die "Docker 当前不可用"
}

exampleproject_acquire_merge_lock() {
  if [ "${WIKILLM_LOCK_HELD:-0}" = "1" ]; then
    return
  fi

  local common_dir
  common_dir="$(git -C "$WIKILLM_REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)"
  WIKILLM_LOCK_DIR="$common_dir/exampleproject-merge.lock"
  if ! mkdir "$WIKILLM_LOCK_DIR" 2>/dev/null; then
    exampleproject_die "已有合并或清理流程占用锁: $WIKILLM_LOCK_DIR"
  fi
  printf 'pid=%s\nfeature=%s\nstarted=%s\n' "$$" "$WIKILLM_FEATURE" "$(date -Iseconds)" \
    > "$WIKILLM_LOCK_DIR/owner"
  WIKILLM_LOCK_HELD=1
  trap exampleproject_release_merge_lock EXIT
}

exampleproject_release_merge_lock() {
  if [ "${WIKILLM_LOCK_HELD:-0}" = "1" ] && [ -n "${WIKILLM_LOCK_DIR:-}" ]; then
    rm -f -- "$WIKILLM_LOCK_DIR/owner" 2>/dev/null || true
    if ! rmdir -- "$WIKILLM_LOCK_DIR" 2>/dev/null; then
      printf '!! 无法释放合并锁: %s\n' "$WIKILLM_LOCK_DIR" >&2
    fi
    WIKILLM_LOCK_HELD=0
  fi
  return 0
}

exampleproject_feature_container_ids() {
  {
    docker ps -aq --filter "label=com.exampleproject.feature=$WIKILLM_FEATURE"
    docker ps -aq --filter "label=com.docker.compose.project=$WIKILLM_PROJECT"
    docker ps -a --format '{{.ID}}|{{.Names}}' |
      awk -F'|' \
        -v app="$WIKILLM_CONTAINER" \
        -v office="$WIKILLM_ONLYOFFICE_CONTAINER" \
        '$2 == app || $2 == office { print $1 }'
  } | awk 'NF && !seen[$0]++'
}

exampleproject_feature_volume_names() {
  {
    docker volume ls -q --filter "label=com.exampleproject.feature=$WIKILLM_FEATURE"
    docker volume ls -q --filter "label=com.docker.compose.project=$WIKILLM_PROJECT"
    for name in \
      "$WIKILLM_VOLUME" \
      "$WIKILLM_ONLYOFFICE_CONTAINER-data" \
      "$WIKILLM_ONLYOFFICE_CONTAINER-lib" \
      "$WIKILLM_ONLYOFFICE_CONTAINER-logs"
    do
      if docker volume inspect "$name" >/dev/null 2>&1; then
        printf '%s\n' "$name"
      fi
    done
  } | awk 'NF && !seen[$0]++'
}

exampleproject_feature_network_names() {
  {
    docker network ls -q --filter "label=com.exampleproject.feature=$WIKILLM_FEATURE" |
      while IFS= read -r id; do
        [ -n "$id" ] && docker network inspect "$id" --format '{{.Name}}'
      done
    docker network ls -q --filter "label=com.docker.compose.project=$WIKILLM_PROJECT" |
      while IFS= read -r id; do
        [ -n "$id" ] && docker network inspect "$id" --format '{{.Name}}'
      done
    local legacy_network="${WIKILLM_PROJECT}_default"
    if docker network inspect "$legacy_network" >/dev/null 2>&1; then
      printf '%s\n' "$legacy_network"
    fi
  } | awk 'NF && !seen[$0]++'
}

exampleproject_feature_image_ids() {
  docker image ls -q --filter "label=com.exampleproject.feature=$WIKILLM_FEATURE" |
    awk 'NF && !seen[$0]++'
}

exampleproject_print_feature_status() {
  exampleproject_log "feature=$WIKILLM_FEATURE"
  exampleproject_log "worktree=$WIKILLM_WORKTREE"
  exampleproject_log "branch=$WIKILLM_BRANCH"

  if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
    if git -C "$WIKILLM_REPO_ROOT" merge-base --is-ancestor "$WIKILLM_BRANCH" main; then
      exampleproject_log "branch_state=merged"
    else
      exampleproject_log "branch_state=not-merged"
    fi
  else
    exampleproject_log "branch_state=absent"
  fi

  if [ -e "$WIKILLM_WORKTREE" ]; then
    local worktree_status
    worktree_status="$(
      git -c "safe.directory=$WIKILLM_WORKTREE" \
        -C "$WIKILLM_WORKTREE" status --porcelain
    )"
    if [ -n "$worktree_status" ]; then
      exampleproject_log "worktree_state=present-dirty"
    else
      exampleproject_log "worktree_state=present-clean"
    fi
  else
    exampleproject_log "worktree_state=absent"
  fi

  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    exampleproject_log "docker_state=unavailable"
    return
  fi

  local values
  values="$(exampleproject_feature_container_ids | xargs 2>/dev/null || true)"
  exampleproject_log "containers=${values:-none}"
  values="$(exampleproject_feature_volume_names | xargs 2>/dev/null || true)"
  exampleproject_log "volumes=${values:-none}"
  values="$(exampleproject_feature_network_names | xargs 2>/dev/null || true)"
  exampleproject_log "networks=${values:-none}"
  values="$(exampleproject_feature_image_ids | xargs 2>/dev/null || true)"
  if docker image inspect "$WIKILLM_IMAGE" >/dev/null 2>&1; then
    values="$WIKILLM_IMAGE ${values:-}"
  fi
  exampleproject_log "images=${values:-none}"
}

exampleproject_assert_feature_cleanup_safe() {
  if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
    if ! git -C "$WIKILLM_REPO_ROOT" merge-base --is-ancestor "$WIKILLM_BRANCH" main; then
      exampleproject_die "分支 $WIKILLM_BRANCH 尚未并入 main，拒绝清理"
    fi
  elif [ -e "$WIKILLM_WORKTREE" ]; then
    exampleproject_die "worktree 仍存在但分支 $WIKILLM_BRANCH 不存在，拒绝推断其归属"
  fi

  if [ -e "$WIKILLM_WORKTREE" ]; then
    local status
    status="$(git -c "safe.directory=$WIKILLM_WORKTREE" -C "$WIKILLM_WORKTREE" status --porcelain)"
    if [ -n "$status" ]; then
      printf '%s\n' "$status" >&2
      exampleproject_die "worktree 有未提交内容，拒绝清理: $WIKILLM_WORKTREE"
    fi
  fi
}

exampleproject_cleanup_feature_docker() {
  exampleproject_require_docker

  local failed=0
  local -a container_ids=()
  local -a volume_names=()
  local -a network_names=()
  local -a image_ids=()
  mapfile -t container_ids < <(exampleproject_feature_container_ids)
  mapfile -t volume_names < <(exampleproject_feature_volume_names)
  mapfile -t network_names < <(exampleproject_feature_network_names)
  mapfile -t image_ids < <(exampleproject_feature_image_ids)

  exampleproject_log ">> 清理 Docker 容器"
  local id name running
  for id in "${container_ids[@]}"; do
    [ -n "$id" ] || continue
    name="$(docker inspect "$id" --format '{{.Name}}' | sed 's#^/##')"
    running="$(docker inspect "$id" --format '{{.State.Running}}')"
    if [ "$running" = "true" ] && [[ "$name" == *-onlyoffice ]]; then
      docker exec "$id" documentserver-prepare4shutdown.sh >/dev/null 2>&1 || \
        exampleproject_log "   WARN: $name 未响应优雅关闭请求，继续删除功能容器"
    fi
    if ! docker rm -f "$id"; then
      printf '!! 删除容器失败: %s\n' "$name" >&2
      failed=1
    fi
  done

  exampleproject_log ">> 清理 Docker 数据卷"
  local volume
  for volume in "${volume_names[@]}"; do
    [ -n "$volume" ] || continue
    if ! docker volume rm "$volume"; then
      printf '!! 删除数据卷失败: %s\n' "$volume" >&2
      failed=1
    fi
  done

  exampleproject_log ">> 清理 Docker 网络"
  local network
  for network in "${network_names[@]}"; do
    [ -n "$network" ] || continue
    if ! docker network rm "$network"; then
      printf '!! 删除网络失败: %s\n' "$network" >&2
      failed=1
    fi
  done

  exampleproject_log ">> 清理 Docker 功能镜像"
  if docker image inspect "$WIKILLM_IMAGE" >/dev/null 2>&1; then
    if ! docker image rm "$WIKILLM_IMAGE"; then
      printf '!! 删除镜像标签失败: %s\n' "$WIKILLM_IMAGE" >&2
      failed=1
    fi
  fi
  for id in "${image_ids[@]}"; do
    [ -n "$id" ] || continue
    if docker image inspect "$id" >/dev/null 2>&1; then
      if ! docker image rm "$id"; then
        printf '!! 删除功能镜像失败: %s\n' "$id" >&2
        failed=1
      fi
    fi
  done

  if ! exampleproject_verify_feature_docker_clean; then
    failed=1
  fi
  return "$failed"
}

exampleproject_verify_feature_docker_clean() {
  local failed=0 values

  values="$(exampleproject_feature_container_ids | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留容器: %s\n' "$values" >&2
    failed=1
  fi
  values="$(exampleproject_feature_volume_names | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留数据卷: %s\n' "$values" >&2
    failed=1
  fi
  values="$(exampleproject_feature_network_names | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留网络: %s\n' "$values" >&2
    failed=1
  fi
  values="$(exampleproject_feature_image_ids | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留功能镜像: %s\n' "$values" >&2
    failed=1
  fi
  if docker image inspect "$WIKILLM_IMAGE" >/dev/null 2>&1; then
    printf '!! 残留功能镜像标签: %s\n' "$WIKILLM_IMAGE" >&2
    failed=1
  fi

  if [ "$failed" -eq 0 ]; then
    exampleproject_log "   Docker 功能资源残留检查通过"
  fi
  return "$failed"
}

exampleproject_cleanup_feature_git() {
  local failed=0

  exampleproject_log ">> 移除 Git worktree"
  if [ -e "$WIKILLM_WORKTREE" ]; then
    if ! git -C "$WIKILLM_REPO_ROOT" worktree remove "$WIKILLM_WORKTREE"; then
      printf '!! 删除 worktree 失败: %s\n' "$WIKILLM_WORKTREE" >&2
      failed=1
    fi
  fi

  if ! git -C "$WIKILLM_REPO_ROOT" worktree prune; then
    printf '!! git worktree prune 执行失败\n' >&2
    failed=1
  fi

  if [ "$failed" -eq 0 ] &&
    git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"
  then
    exampleproject_log ">> 删除已合并功能分支"
    if ! git -C "$WIKILLM_REPO_ROOT" branch -d "$WIKILLM_BRANCH"; then
      printf '!! 删除分支失败: %s\n' "$WIKILLM_BRANCH" >&2
      failed=1
    fi
  fi

  exampleproject_log ">> 清理 Git safe.directory 记录"
  local safe_value
  if [ ! -e "$WIKILLM_WORKTREE" ]; then
    for safe_value in "$WIKILLM_SAFE_DIRECTORY" "$WIKILLM_WORKTREE"; do
      if git config --global --get-all safe.directory 2>/dev/null |
        grep -Fx "$safe_value" >/dev/null
      then
        if ! git config --global --fixed-value --unset-all safe.directory "$safe_value"; then
          printf '!! 删除 safe.directory 失败: %s\n' "$safe_value" >&2
          failed=1
        fi
      fi
    done
  else
    exampleproject_log "   worktree 仍存在，保留其 safe.directory 记录"
  fi

  if ! git -C "$WIKILLM_REPO_ROOT" worktree prune; then
    printf '!! git worktree prune 复验前执行失败\n' >&2
    failed=1
  fi
  if ! exampleproject_verify_feature_git_clean; then
    failed=1
  fi
  return "$failed"
}

exampleproject_verify_feature_git_clean() {
  local failed=0
  if git -C "$WIKILLM_REPO_ROOT" worktree list --porcelain |
    sed -n 's/^worktree //p' |
    grep -Fx "$WIKILLM_WORKTREE" >/dev/null
  then
    printf '!! worktree 仍在 Git 注册表中: %s\n' "$WIKILLM_WORKTREE" >&2
    failed=1
  fi
  if [ -e "$WIKILLM_WORKTREE" ]; then
    printf '!! worktree 目录仍存在: %s\n' "$WIKILLM_WORKTREE" >&2
    failed=1
  fi
  if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$WIKILLM_BRANCH"; then
    printf '!! 功能分支仍存在: %s\n' "$WIKILLM_BRANCH" >&2
    failed=1
  fi
  local safe_value
  for safe_value in "$WIKILLM_SAFE_DIRECTORY" "$WIKILLM_WORKTREE"; do
    if git config --global --get-all safe.directory 2>/dev/null |
      grep -Fx "$safe_value" >/dev/null
    then
      printf '!! safe.directory 记录仍存在: %s\n' "$safe_value" >&2
      failed=1
    fi
  done
  if [ "$failed" -eq 0 ]; then
    exampleproject_log "   Git worktree 与功能分支残留检查通过"
  fi
  return "$failed"
}

exampleproject_image_used_by_container() {
  local image_id="$1"
  docker ps -aq |
    while IFS= read -r container_id; do
      [ -n "$container_id" ] || continue
      docker inspect "$container_id" --format '{{.Image}}'
    done |
    grep -Fx "$image_id" >/dev/null
}

exampleproject_cleanup_old_main_images() {
  exampleproject_require_docker

  local current_tag current_image_id failed=0
  current_tag="example-wiki:main-$(git -C "$WIKILLM_REPO_ROOT" rev-parse --short=12 HEAD)"
  current_image_id="$(docker inspect example-wiki --format '{{.Image}}' 2>/dev/null || true)"
  [ -n "$current_image_id" ] || exampleproject_die "主容器 example-wiki 不存在，无法判断应保留的主镜像"

  exampleproject_log ">> 清理未被容器引用的旧主镜像"
  local repository tag image_ref image_id
  while IFS='|' read -r repository tag; do
    [ "$repository" = "example-wiki" ] || continue
    if [[ "$tag" != main-* && "$tag" != pre-* && ! "$tag" =~ ^[0-9a-f]{7,40}$ ]]; then
      continue
    fi
    if git -C "$WIKILLM_REPO_ROOT" show-ref --verify --quiet "refs/heads/feat/$tag"; then
      exampleproject_log "   保留活动功能分支镜像: $repository:$tag"
      continue
    fi
    image_ref="$repository:$tag"
    [ "$image_ref" != "$current_tag" ] || continue
    image_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
    if [ "$image_id" != "$current_image_id" ] && exampleproject_image_used_by_container "$image_id"; then
      exampleproject_log "   保留仍被其他容器引用的镜像: $image_ref"
      continue
    fi
    if ! docker image rm "$image_ref"; then
      printf '!! 删除旧主镜像失败: %s\n' "$image_ref" >&2
      failed=1
    fi
  done < <(docker image ls --format '{{.Repository}}|{{.Tag}}')
  return "$failed"
}
