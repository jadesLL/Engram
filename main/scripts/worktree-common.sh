#!/usr/bin/env bash

set -euo pipefail

engram_log() {
  printf '%s\n' "$*"
}

engram_die() {
  printf '!! %s\n' "$*" >&2
  exit 1
}

engram_validate_feature() {
  local feature="${1:-}"
  if ! [[ "$feature" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    engram_die "功能名只能包含小写字母、数字和中划线，当前值: ${feature:-<empty>}"
  fi
}

engram_discover_repo_root() {
  if [ -n "${ENGRAM_REPO_ROOT:-}" ]; then
    (
      cd "$ENGRAM_REPO_ROOT"
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
    engram_die "无法从脚本位置识别 Git common directory: $app_dir"
  fi
  (
    cd "$common_dir/.."
    pwd -P
  )
}

engram_init_feature() {
  local feature="$1"
  engram_validate_feature "$feature"

  ENGRAM_FEATURE="$feature"
  ENGRAM_REPO_ROOT="$(engram_discover_repo_root)"
  ENGRAM_MAIN_DIR="$ENGRAM_REPO_ROOT/main"
  ENGRAM_SHARED_PNPM="$ENGRAM_MAIN_DIR/node_modules/pnpm/bin/pnpm.cjs"
  ENGRAM_WORKTREE="$ENGRAM_REPO_ROOT/worktrees/$feature"
  ENGRAM_BRANCH="feat/$feature"
  ENGRAM_PROJECT="engram-$feature"
  ENGRAM_IMAGE="engram:$feature"
  ENGRAM_VERIFY_IMAGE="engram:$feature-verify"
  ENGRAM_CONTAINER="engram-$feature"
  ENGRAM_ONLYOFFICE_CONTAINER="engram-$feature-onlyoffice"
  ENGRAM_VOLUME="engram-data-$feature"
  ENGRAM_SAFE_DIRECTORY="%(prefix)/$ENGRAM_WORKTREE"

  case "$ENGRAM_WORKTREE" in
    "$ENGRAM_REPO_ROOT"/worktrees/*) ;;
    *) engram_die "拒绝操作工作区之外的路径: $ENGRAM_WORKTREE" ;;
  esac
}

engram_shared_pnpm() {
  [ -f "$ENGRAM_SHARED_PNPM" ] || \
    engram_die "共享 pnpm 不存在: $ENGRAM_SHARED_PNPM"
  node "$ENGRAM_SHARED_PNPM" "$@"
}

engram_require_docker() {
  command -v docker >/dev/null 2>&1 || engram_die "未找到 docker 命令"
  docker info >/dev/null 2>&1 || engram_die "Docker 当前不可用"
}

engram_require_feature_worktree() {
  [ -d "$ENGRAM_WORKTREE/main" ] || \
    engram_die "功能 worktree 不存在: $ENGRAM_WORKTREE"
  git -c "safe.directory=$ENGRAM_WORKTREE" \
    -C "$ENGRAM_WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
    engram_die "目录不是有效 Git worktree: $ENGRAM_WORKTREE"
}

engram_configure_build_network() {
  local allow_downloads="${1:-0}"
  if [ "$allow_downloads" -eq 1 ]; then
    ENGRAM_BUILD_NETWORK="default"
    return
  fi

  ENGRAM_BUILD_NETWORK="none"
  docker image inspect node:22-slim >/dev/null 2>&1 || \
    engram_die "本机缺少 node:22-slim；未获得下载许可，拒绝拉取基础镜像"
}

engram_explain_offline_build_failure() {
  if [ "${ENGRAM_BUILD_NETWORK:-none}" = "none" ]; then
    cat >&2 <<'EOF'
!! Docker 离线构建失败。
   如果日志显示依赖或基础工具缓存缺失，必须先获得用户明确下载许可，
   再为对应命令增加 --allow-downloads；不得自行联网重试。
EOF
  fi
}

engram_cleanup_local_verification() {
  local verify_dir="$1"
  local verify_dir_windows=""
  local failed=0 cleanup_attempt

  if command -v cygpath >/dev/null 2>&1 && command -v powershell.exe >/dev/null 2>&1; then
    verify_dir_windows="$(cygpath -w "$verify_dir")"
    if ! ENGRAM_VERIFY_TEMP="$verify_dir_windows" powershell.exe -NoProfile -Command \
      '$target=$env:ENGRAM_VERIFY_TEMP; $root=Join-Path $env:LOCALAPPDATA "pnpm\store\v11\projects"; if (Test-Path -LiteralPath $root) { $rootPrefix=[IO.Path]::GetFullPath($root).TrimEnd("\") + "\"; Get-ChildItem -Force -LiteralPath $root | Where-Object { ($_.Target -join "") -eq $target } | ForEach-Object { $full=[IO.Path]::GetFullPath($_.FullName); if (-not $full.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw "Refusing path outside pnpm projects: $full" }; [IO.Directory]::Delete($full,$false) } }' \
      >/dev/null
    then
      failed=1
    fi
  fi

  case "$verify_dir" in
    /tmp/engram-verify.*|/tmp/engram-preview.*|/tmp/engram-main.*)
      for cleanup_attempt in 1 2 3 4 5; do
        if rm -rf -- "$verify_dir" && [ ! -e "$verify_dir" ]; then
          break
        fi
        sleep 1
      done
      [ ! -e "$verify_dir" ] || failed=1
      ;;
    *)
      printf '!! 拒绝删除意外验证路径: %s\n' "$verify_dir" >&2
      failed=1
      ;;
  esac
  return "$failed"
}

engram_run_local_offline_verification() {
  local source_dir="$1"
  local resolved_source verify_dir local_app_data native_cache native_source="" candidate
  local check_status=0 cleanup_status=0
  local -a native_candidates=()

  command -v node >/dev/null 2>&1 || return 1
  [ -f "$ENGRAM_SHARED_PNPM" ] || {
    printf '!! 缺少共享 pnpm: %s\n' "$ENGRAM_SHARED_PNPM" >&2
    return 1
  }
  command -v cygpath >/dev/null 2>&1 || return 1
  resolved_source="$(
    cd "$source_dir"
    pwd -P
  )"
  case "$resolved_source" in
    "$ENGRAM_MAIN_DIR"|"$ENGRAM_REPO_ROOT"/worktrees/*/main) ;;
    *)
      printf '!! 拒绝验证工作区之外的源码目录: %s\n' "$resolved_source" >&2
      return 1
      ;;
  esac

  verify_dir="$(mktemp -d -t engram-verify.XXXXXX)"
  local_app_data="$(cygpath -u "${LOCALAPPDATA:?LOCALAPPDATA 未设置}")"
  native_cache="$local_app_data/Engram/verification-native"

  shopt -s nullglob
  native_candidates=(
    "$native_cache"/better-sqlite3@*/better_sqlite3.node
    "$ENGRAM_MAIN_DIR"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
    "$(cygpath -u "${TEMP:-${TMP:-/tmp}}")"/engram-*/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
  )
  shopt -u nullglob
  # ELF 头（7f 45 4c 46）= Linux 构件，Windows 宿主机 node 加载会报
  # "not a valid Win32 application"；缓存目录可能残留 Docker 侧拷出的构件，跳过并告警。
  for candidate in "${native_candidates[@]}"; do
    if [ "$(
      head -c 4 "$candidate" 2>/dev/null | od -An -tx1 | tr -d ' \n'
    )" = "7f454c46" ]; then
      engram_log "   WARN: 跳过 Linux ELF 构件（Windows 宿主机无法加载）: $candidate"
      continue
    fi
    native_source="$candidate"
    break
  done
  [ -n "$native_source" ] || {
    printf '!! 缺少本机可用的 Windows 版 better_sqlite3.node，无法离线运行服务端测试\n' >&2
    return 1
  }

  engram_log ">> Docker 离线缓存缺失，改用本机临时目录离线验证"
  engram_log "   shared_pnpm=$ENGRAM_SHARED_PNPM ($(engram_shared_pnpm --version))"
  # 本函数通常在 if 条件中被调用：调用期间 bash 会压制函数体内的 set -e，
  # 因此每一步都必须显式检查状态（依赖 errexit 会让 test 失败被后续 build 成功掩盖）。
  (
    set -o pipefail
    (
      cd "$resolved_source" || exit 1
      tar -cf - \
        --exclude='./node_modules' \
        --exclude='./server/node_modules' \
        --exclude='./web/node_modules' \
        --exclude='./desktop/node_modules' \
        --exclude='./server/dist' \
        --exclude='./web/dist' \
        --exclude='./data' \
        --exclude='./data-test' \
        --exclude='./.env' \
        --exclude='./.env.*' \
        --exclude='./*.log' \
        .
    ) | tar -xf - -C "$verify_dir" || exit 1
    cd "$verify_dir" || exit 1
    engram_shared_pnpm install --offline --frozen-lockfile --ignore-scripts || exit 1
    native_targets=(
      "$verify_dir"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
    )
    if [ "${#native_targets[@]}" -ne 1 ] || [ ! -d "${native_targets[0]}" ]; then
      printf '!! 临时验证目录中的 better-sqlite3 位置异常\n' >&2
      exit 1
    fi
    mkdir -p "${native_targets[0]}/build/Release" || exit 1
    cp "$native_source" "${native_targets[0]}/build/Release/better_sqlite3.node" || exit 1
    engram_shared_pnpm test || exit 1
    engram_shared_pnpm typecheck || exit 1
    engram_shared_pnpm build || exit 1
  )
  check_status=$?

  engram_cleanup_local_verification "$verify_dir" || cleanup_status=$?
  [ "$check_status" -eq 0 ] && [ "$cleanup_status" -eq 0 ]
}

engram_current_main_image() {
  local base_image=""

  if docker container inspect engram >/dev/null 2>&1; then
    base_image="$(
      docker container inspect engram --format '{{.Config.Image}}'
    )"
  fi
  if [ -z "$base_image" ] || ! docker image inspect "$base_image" >/dev/null 2>&1; then
    base_image="$(
      docker image ls \
        --filter 'reference=engram:main-*' \
        --format '{{.Repository}}:{{.Tag}}' |
        head -n 1
    )"
  fi
  [ -n "$base_image" ] && docker image inspect "$base_image" >/dev/null 2>&1 || return 1
  [[ "$base_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || return 1
  printf '%s\n' "$base_image"
}

engram_build_local_offline_overlay_image() {
  local source_dir="$1"
  local temp_prefix="$2"
  local base_image="$3"
  local description="$4"
  shift 4
  local resolved_source build_dir runtime_id
  local build_status=0 cleanup_status=0

  command -v node >/dev/null 2>&1 || return 1
  command -v cygpath >/dev/null 2>&1 || return 1
  [ -f "$ENGRAM_SHARED_PNPM" ] || {
    printf '!! 缺少共享 pnpm: %s\n' "$ENGRAM_SHARED_PNPM" >&2
    return 1
  }
  docker image inspect "$base_image" >/dev/null 2>&1 || return 1
  [[ "$base_image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || return 1

  resolved_source="$(
    cd "$source_dir"
    pwd -P
  )"
  case "$resolved_source" in
    "$ENGRAM_MAIN_DIR"|"$ENGRAM_REPO_ROOT"/worktrees/*/main) ;;
    *)
      printf '!! 拒绝构建工作区之外的源码目录: %s\n' "$resolved_source" >&2
      return 1
      ;;
  esac

  build_dir="$(mktemp -d -t "${temp_prefix}.XXXXXX")"
  engram_log ">> 使用共享 pnpm 构建$description"
  engram_log "   shared_pnpm=$ENGRAM_SHARED_PNPM ($(engram_shared_pnpm --version))"
  engram_log "   base_image=$base_image"
  set +e
  (
    set -euo pipefail
    local image_context="$build_dir/image"
    (
      cd "$resolved_source"
      tar -cf - \
        --exclude='./node_modules' \
        --exclude='./server/node_modules' \
        --exclude='./web/node_modules' \
        --exclude='./desktop/node_modules' \
        --exclude='./server/dist' \
        --exclude='./web/dist' \
        --exclude='./data' \
        --exclude='./data-test' \
        --exclude='./.env' \
        --exclude='./.env.*' \
        --exclude='./*.log' \
        .
    ) | tar -xf - -C "$build_dir"
    cd "$build_dir"
    engram_shared_pnpm install --offline --frozen-lockfile --ignore-scripts
    engram_shared_pnpm build
    runtime_id="$(
      node - "$build_dir/server/dist" "$build_dir/web/dist" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const hash = crypto.createHash('sha256');
for (const root of process.argv.slice(2)) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        hash.update(path.relative(root, fullPath).split(path.sep).join('/'));
        hash.update('\0');
        hash.update(fs.readFileSync(fullPath));
      }
    }
  };
  visit(root);
}
process.stdout.write(hash.digest('hex').slice(0, 16));
NODE
    )"
    mkdir -p "$image_context/server" "$image_context/web"
    cp -a "$build_dir/server/dist" "$image_context/server/dist"
    cp -a "$build_dir/web/dist" "$image_context/web/dist"
    cat > "$image_context/Dockerfile" <<EOF
FROM $base_image
ARG ENGRAM_GIT_SHA=""
RUN --mount=type=bind,source=server/dist,target=/mnt/server-dist,ro \\
    --mount=type=bind,source=web/dist,target=/mnt/web-dist,ro \\
    mkdir -p /app/server/dist /app/.engram-runtime/$runtime_id/web \\
    && cp -a /mnt/server-dist/. /app/server/dist/ \\
    && cp -a /mnt/web-dist/. /app/.engram-runtime/$runtime_id/web/ \\
    && printf '%s' "\$ENGRAM_GIT_SHA" > /app/GIT_SHA
ENV ENGRAM_WEB_DIST=/app/.engram-runtime/$runtime_id/web
LABEL com.engram.runtime=$runtime_id
EOF
    docker build \
      --pull=false \
      --network none \
      "$@" \
      "$image_context"
  )
  build_status=$?
  set -e

  engram_cleanup_local_verification "$build_dir" || cleanup_status=$?
  [ "$build_status" -eq 0 ] && [ "$cleanup_status" -eq 0 ]
}

engram_build_local_offline_preview_image() {
  local source_dir="$1"
  local resolved_source base_image
  local relative_path
  local -a dependency_files=(
    Dockerfile
    package.json
    pnpm-workspace.yaml
    pnpm-lock.yaml
    server/package.json
    web/package.json
    desktop/package.json
  )

  resolved_source="$(
    cd "$source_dir"
    pwd -P
  )"
  case "$resolved_source" in
    "$ENGRAM_REPO_ROOT"/worktrees/*/main) ;;
    *)
      printf '!! 拒绝预览工作区之外的源码目录: %s\n' "$resolved_source" >&2
      return 1
      ;;
  esac

  for relative_path in "${dependency_files[@]}"; do
    if ! cmp -s \
      "$resolved_source/$relative_path" \
      "$ENGRAM_MAIN_DIR/$relative_path"
    then
      printf '!! %s 已改变，不能复用主镜像依赖进行离线预览\n' "$relative_path" >&2
      return 1
    fi
  done

  if ! base_image="$(engram_current_main_image)"; then
    printf '!! 缺少可复用的主运行镜像，无法创建离线预览\n' >&2
    return 1
  fi

  engram_build_local_offline_overlay_image \
    "$resolved_source" \
    engram-preview \
    "$base_image" \
    "离线预览叠加层" \
    --label com.engram.scope=feature \
    --label "com.engram.feature=$ENGRAM_FEATURE" \
    --build-arg "ENGRAM_GIT_SHA=$(git -C "$resolved_source" rev-parse HEAD)" \
    --tag "$ENGRAM_IMAGE"
}

engram_normalize_runtime_dockerfile() {
  awk '
    /^# ---------- 一次完成构建、类型检查和测试 ----------/ { skip = 1; next }
    skip && /^# ---------- 运行时 ----------/ { skip = 0 }
    !skip { print }
  '
}

engram_build_local_offline_main_image() {
  local source_dir="$1"
  local image="$2"
  local revision="$3"
  local extra_tag="${4:-}"
  local resolved_source base_image base_revision source_revision
  local base_dockerfile current_dockerfile relative_path
  local -a dependency_files=(
    package.json
    pnpm-workspace.yaml
    pnpm-lock.yaml
    server/package.json
    web/package.json
    desktop/package.json
  )
  local -a image_args=(
    --label "org.opencontainers.image.revision=$revision"
    --label org.opencontainers.image.source=local-main
    --tag "$image"
  )

  resolved_source="$(
    cd "$source_dir"
    pwd -P
  )"
  case "$resolved_source" in
    "$ENGRAM_MAIN_DIR"|"$ENGRAM_REPO_ROOT"/worktrees/*/main) ;;
    *)
      printf '!! 拒绝部署工作区之外的源码目录: %s\n' "$resolved_source" >&2
      return 1
      ;;
  esac
  if ! base_image="$(engram_current_main_image)"; then
    printf '!! 缺少可复用的主运行镜像，无法创建离线主镜像\n' >&2
    return 1
  fi
  base_revision="$(
    docker image inspect "$base_image" \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
  )"
  if [ -z "$base_revision" ] ||
    ! git -C "$resolved_source" rev-parse --verify "${base_revision}^{commit}" >/dev/null 2>&1
  then
    printf '!! 主运行镜像缺少可核对的 Git revision: %s\n' "${base_revision:-<empty>}" >&2
    return 1
  fi
  source_revision="$(git -C "$resolved_source" rev-parse HEAD)"
  # 离线叠加层同样烤入提交号（/app/GIT_SHA），否则镜像会沿用基底镜像的旧提交号
  image_args+=(--build-arg "ENGRAM_GIT_SHA=$source_revision")
  for relative_path in "${dependency_files[@]}"; do
    if ! git -C "$resolved_source" diff --quiet \
      "$base_revision" "$source_revision" -- "main/$relative_path"
    then
      printf '!! %s 相对主运行镜像已改变，不能复用旧依赖部署\n' "$relative_path" >&2
      return 1
    fi
  done

  base_dockerfile="$(
    git -C "$resolved_source" show "$base_revision:main/Dockerfile" |
      engram_normalize_runtime_dockerfile
  )"
  current_dockerfile="$(
    engram_normalize_runtime_dockerfile < "$resolved_source/Dockerfile"
  )"
  if [ "$base_dockerfile" != "$current_dockerfile" ]; then
    printf '!! Docker 运行阶段相对主镜像已改变，不能使用离线叠加部署\n' >&2
    return 1
  fi
  if [ -n "$extra_tag" ]; then
    image_args+=(--tag "$extra_tag")
  fi

  engram_build_local_offline_overlay_image \
    "$resolved_source" \
    engram-main \
    "$base_image" \
    "离线主镜像叠加层" \
    "${image_args[@]}"
}

engram_acquire_merge_lock() {
  if [ "${ENGRAM_LOCK_HELD:-0}" = "1" ]; then
    return
  fi

  local common_dir
  common_dir="$(git -C "$ENGRAM_REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)"
  ENGRAM_LOCK_DIR="$common_dir/engram-merge.lock"
  if ! mkdir "$ENGRAM_LOCK_DIR" 2>/dev/null; then
    engram_die "已有合并或清理流程占用锁: $ENGRAM_LOCK_DIR"
  fi
  printf 'pid=%s\nfeature=%s\nstarted=%s\n' "$$" "$ENGRAM_FEATURE" "$(date -Iseconds)" \
    > "$ENGRAM_LOCK_DIR/owner"
  ENGRAM_LOCK_HELD=1
  trap engram_release_merge_lock EXIT
}

engram_release_merge_lock() {
  if [ "${ENGRAM_LOCK_HELD:-0}" = "1" ] && [ -n "${ENGRAM_LOCK_DIR:-}" ]; then
    rm -f -- "$ENGRAM_LOCK_DIR/owner" 2>/dev/null || true
    if ! rmdir -- "$ENGRAM_LOCK_DIR" 2>/dev/null; then
      printf '!! 无法释放合并锁: %s\n' "$ENGRAM_LOCK_DIR" >&2
    fi
    ENGRAM_LOCK_HELD=0
  fi
  return 0
}

engram_feature_container_ids() {
  {
    docker ps -aq --filter "label=com.engram.feature=$ENGRAM_FEATURE"
    docker ps -aq --filter "label=com.docker.compose.project=$ENGRAM_PROJECT"
    docker ps -a --format '{{.ID}}|{{.Names}}' |
      awk -F'|' \
        -v app="$ENGRAM_CONTAINER" \
        -v office="$ENGRAM_ONLYOFFICE_CONTAINER" \
        '$2 == app || $2 == office { print $1 }'
  } | awk 'NF && !seen[$0]++'
}

engram_feature_volume_names() {
  {
    docker volume ls -q --filter "label=com.engram.feature=$ENGRAM_FEATURE"
    docker volume ls -q --filter "label=com.docker.compose.project=$ENGRAM_PROJECT"
    for name in \
      "$ENGRAM_VOLUME" \
      "$ENGRAM_ONLYOFFICE_CONTAINER-data" \
      "$ENGRAM_ONLYOFFICE_CONTAINER-lib" \
      "$ENGRAM_ONLYOFFICE_CONTAINER-logs"
    do
      if docker volume inspect "$name" >/dev/null 2>&1; then
        printf '%s\n' "$name"
      fi
    done
  } | awk 'NF && !seen[$0]++'
}

engram_feature_network_names() {
  {
    docker network ls -q --filter "label=com.engram.feature=$ENGRAM_FEATURE" |
      while IFS= read -r id; do
        [ -n "$id" ] && docker network inspect "$id" --format '{{.Name}}'
      done
    docker network ls -q --filter "label=com.docker.compose.project=$ENGRAM_PROJECT" |
      while IFS= read -r id; do
        [ -n "$id" ] && docker network inspect "$id" --format '{{.Name}}'
      done
    local legacy_network="${ENGRAM_PROJECT}_default"
    if docker network inspect "$legacy_network" >/dev/null 2>&1; then
      printf '%s\n' "$legacy_network"
    fi
  } | awk 'NF && !seen[$0]++'
}

engram_feature_image_ids() {
  docker image ls -q --filter "label=com.engram.feature=$ENGRAM_FEATURE" |
    awk 'NF && !seen[$0]++'
}

engram_print_feature_status() {
  engram_log "feature=$ENGRAM_FEATURE"
  engram_log "worktree=$ENGRAM_WORKTREE"
  engram_log "branch=$ENGRAM_BRANCH"

  if git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"; then
    if git -C "$ENGRAM_REPO_ROOT" merge-base --is-ancestor "$ENGRAM_BRANCH" main; then
      engram_log "branch_state=merged"
    else
      engram_log "branch_state=not-merged"
    fi
  else
    engram_log "branch_state=absent"
  fi

  if [ -e "$ENGRAM_WORKTREE" ]; then
    local worktree_status
    worktree_status="$(
      git -c "safe.directory=$ENGRAM_WORKTREE" \
        -C "$ENGRAM_WORKTREE" status --porcelain
    )"
    if [ -n "$worktree_status" ]; then
      engram_log "worktree_state=present-dirty"
    else
      engram_log "worktree_state=present-clean"
    fi
  else
    engram_log "worktree_state=absent"
  fi

  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    engram_log "docker_state=unavailable"
    return
  fi

  local values
  values="$(engram_feature_container_ids | xargs 2>/dev/null || true)"
  engram_log "containers=${values:-none}"
  values="$(engram_feature_volume_names | xargs 2>/dev/null || true)"
  engram_log "volumes=${values:-none}"
  values="$(engram_feature_network_names | xargs 2>/dev/null || true)"
  engram_log "networks=${values:-none}"
  values="$(engram_feature_image_ids | xargs 2>/dev/null || true)"
  local image_tag
  for image_tag in "$ENGRAM_IMAGE" "$ENGRAM_VERIFY_IMAGE"; do
    if docker image inspect "$image_tag" >/dev/null 2>&1; then
      values="$image_tag ${values:-}"
    fi
  done
  engram_log "images=${values:-none}"
}

engram_assert_feature_cleanup_safe() {
  if git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"; then
    if ! git -C "$ENGRAM_REPO_ROOT" merge-base --is-ancestor "$ENGRAM_BRANCH" main; then
      engram_die "分支 $ENGRAM_BRANCH 尚未并入 main，拒绝清理"
    fi
  elif [ -e "$ENGRAM_WORKTREE" ]; then
    engram_die "worktree 仍存在但分支 $ENGRAM_BRANCH 不存在，拒绝推断其归属"
  fi

  if [ -e "$ENGRAM_WORKTREE" ]; then
    local status
    status="$(git -c "safe.directory=$ENGRAM_WORKTREE" -C "$ENGRAM_WORKTREE" status --porcelain)"
    if [ -n "$status" ]; then
      printf '%s\n' "$status" >&2
      engram_die "worktree 有未提交内容，拒绝清理: $ENGRAM_WORKTREE"
    fi
  fi
}

engram_cleanup_feature_docker() {
  engram_require_docker

  local failed=0
  local -a container_ids=()
  local -a volume_names=()
  local -a network_names=()
  local -a image_ids=()
  mapfile -t container_ids < <(engram_feature_container_ids)
  mapfile -t volume_names < <(engram_feature_volume_names)
  mapfile -t network_names < <(engram_feature_network_names)
  mapfile -t image_ids < <(engram_feature_image_ids)

  engram_log ">> 清理 Docker 容器"
  local id name running
  for id in "${container_ids[@]}"; do
    [ -n "$id" ] || continue
    name="$(docker inspect "$id" --format '{{.Name}}' | sed 's#^/##')"
    running="$(docker inspect "$id" --format '{{.State.Running}}')"
    if [ "$running" = "true" ] && [[ "$name" == *-onlyoffice ]]; then
      docker exec "$id" documentserver-prepare4shutdown.sh >/dev/null 2>&1 || \
        engram_log "   WARN: $name 未响应优雅关闭请求，继续删除功能容器"
    fi
    if ! docker rm -f "$id"; then
      printf '!! 删除容器失败: %s\n' "$name" >&2
      failed=1
    fi
  done

  engram_log ">> 清理 Docker 数据卷"
  local volume
  for volume in "${volume_names[@]}"; do
    [ -n "$volume" ] || continue
    if ! docker volume rm "$volume"; then
      printf '!! 删除数据卷失败: %s\n' "$volume" >&2
      failed=1
    fi
  done

  engram_log ">> 清理 Docker 网络"
  local network
  for network in "${network_names[@]}"; do
    [ -n "$network" ] || continue
    if ! docker network rm "$network"; then
      printf '!! 删除网络失败: %s\n' "$network" >&2
      failed=1
    fi
  done

  engram_log ">> 清理 Docker 功能镜像"
  local image_tag
  for image_tag in "$ENGRAM_IMAGE" "$ENGRAM_VERIFY_IMAGE"; do
    if docker image inspect "$image_tag" >/dev/null 2>&1; then
      if ! docker image rm "$image_tag"; then
        printf '!! 删除镜像标签失败: %s\n' "$image_tag" >&2
        failed=1
      fi
    fi
  done
  for id in "${image_ids[@]}"; do
    [ -n "$id" ] || continue
    if docker image inspect "$id" >/dev/null 2>&1; then
      if ! docker image rm "$id"; then
        printf '!! 删除功能镜像失败: %s\n' "$id" >&2
        failed=1
      fi
    fi
  done

  if ! engram_verify_feature_docker_clean; then
    failed=1
  fi
  return "$failed"
}

engram_verify_feature_docker_clean() {
  local failed=0 values

  values="$(engram_feature_container_ids | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留容器: %s\n' "$values" >&2
    failed=1
  fi
  values="$(engram_feature_volume_names | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留数据卷: %s\n' "$values" >&2
    failed=1
  fi
  values="$(engram_feature_network_names | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留网络: %s\n' "$values" >&2
    failed=1
  fi
  values="$(engram_feature_image_ids | xargs 2>/dev/null || true)"
  if [ -n "$values" ]; then
    printf '!! 残留功能镜像: %s\n' "$values" >&2
    failed=1
  fi
  local image_tag
  for image_tag in "$ENGRAM_IMAGE" "$ENGRAM_VERIFY_IMAGE"; do
    if docker image inspect "$image_tag" >/dev/null 2>&1; then
      printf '!! 残留功能镜像标签: %s\n' "$image_tag" >&2
      failed=1
    fi
  done

  if [ "$failed" -eq 0 ]; then
    engram_log "   Docker 功能资源残留检查通过"
  fi
  return "$failed"
}

engram_cleanup_feature_git() {
  local failed=0

  engram_log ">> 移除 Git worktree"
  if [ -e "$ENGRAM_WORKTREE" ]; then
    if ! git -C "$ENGRAM_REPO_ROOT" worktree remove "$ENGRAM_WORKTREE"; then
      printf '!! 删除 worktree 失败: %s\n' "$ENGRAM_WORKTREE" >&2
      failed=1
    fi
  fi

  if ! git -C "$ENGRAM_REPO_ROOT" worktree prune; then
    printf '!! git worktree prune 执行失败\n' >&2
    failed=1
  fi

  if [ "$failed" -eq 0 ] &&
    git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"
  then
    engram_log ">> 删除已合并功能分支"
    if ! git -C "$ENGRAM_REPO_ROOT" branch -d "$ENGRAM_BRANCH"; then
      printf '!! 删除分支失败: %s\n' "$ENGRAM_BRANCH" >&2
      failed=1
    fi
  fi

  engram_log ">> 清理 Git safe.directory 记录"
  local safe_value
  if [ ! -e "$ENGRAM_WORKTREE" ]; then
    for safe_value in "$ENGRAM_SAFE_DIRECTORY" "$ENGRAM_WORKTREE"; do
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
    engram_log "   worktree 仍存在，保留其 safe.directory 记录"
  fi

  if ! git -C "$ENGRAM_REPO_ROOT" worktree prune; then
    printf '!! git worktree prune 复验前执行失败\n' >&2
    failed=1
  fi
  if ! engram_verify_feature_git_clean; then
    failed=1
  fi
  return "$failed"
}

engram_verify_feature_git_clean() {
  local failed=0
  if git -C "$ENGRAM_REPO_ROOT" worktree list --porcelain |
    sed -n 's/^worktree //p' |
    grep -Fx "$ENGRAM_WORKTREE" >/dev/null
  then
    printf '!! worktree 仍在 Git 注册表中: %s\n' "$ENGRAM_WORKTREE" >&2
    failed=1
  fi
  if [ -e "$ENGRAM_WORKTREE" ]; then
    printf '!! worktree 目录仍存在: %s\n' "$ENGRAM_WORKTREE" >&2
    failed=1
  fi
  if git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/$ENGRAM_BRANCH"; then
    printf '!! 功能分支仍存在: %s\n' "$ENGRAM_BRANCH" >&2
    failed=1
  fi
  local safe_value
  for safe_value in "$ENGRAM_SAFE_DIRECTORY" "$ENGRAM_WORKTREE"; do
    if git config --global --get-all safe.directory 2>/dev/null |
      grep -Fx "$safe_value" >/dev/null
    then
      printf '!! safe.directory 记录仍存在: %s\n' "$safe_value" >&2
      failed=1
    fi
  done
  if [ "$failed" -eq 0 ]; then
    engram_log "   Git worktree 与功能分支残留检查通过"
  fi
  return "$failed"
}

engram_image_used_by_container() {
  local image_id="$1"
  docker ps -aq |
    while IFS= read -r container_id; do
      [ -n "$container_id" ] || continue
      docker inspect "$container_id" --format '{{.Image}}'
    done |
    grep -Fx "$image_id" >/dev/null
}

engram_cleanup_old_main_images() {
  engram_require_docker

  local current_tag current_image_id failed=0
  current_tag="engram:main-$(git -C "$ENGRAM_REPO_ROOT" rev-parse --short=12 HEAD)"
  current_image_id="$(docker inspect engram --format '{{.Image}}' 2>/dev/null || true)"
  [ -n "$current_image_id" ] || engram_die "主容器 engram 不存在，无法判断应保留的主镜像"

  engram_log ">> 清理未被容器引用的旧主镜像"
  local repository tag image_ref image_id
  while IFS='|' read -r repository tag; do
    [ "$repository" = "engram" ] || continue
    if [[ "$tag" != main-* && "$tag" != pre-* && ! "$tag" =~ ^[0-9a-f]{7,40}$ ]]; then
      continue
    fi
    if git -C "$ENGRAM_REPO_ROOT" show-ref --verify --quiet "refs/heads/feat/$tag"; then
      engram_log "   保留活动功能分支镜像: $repository:$tag"
      continue
    fi
    image_ref="$repository:$tag"
    [ "$image_ref" != "$current_tag" ] || continue
    image_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
    if [ "$image_id" != "$current_image_id" ] && engram_image_used_by_container "$image_id"; then
      engram_log "   保留仍被其他容器引用的镜像: $image_ref"
      continue
    fi
    if ! docker image rm "$image_ref"; then
      printf '!! 删除旧主镜像失败: %s\n' "$image_ref" >&2
      failed=1
    fi
  done < <(docker image ls --format '{{.Repository}}|{{.Tag}}')
  return "$failed"
}
