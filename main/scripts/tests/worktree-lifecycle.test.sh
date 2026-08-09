#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FEATURE="lifecycle-smoke-$$"
DIRTY_FEATURE="lifecycle-dirty-$$"
CREATE_FEATURE="lifecycle-create-$$"
DEPLOY_FEATURE="lifecycle-deploy-$$"
TEST_REPO="$(mktemp -d -t exampleproject-lifecycle.XXXXXX)"
TEST_MAIN_VOLUME="exampleproject-test-main-$$"

remove_safe_directory() {
  local value="$1"
  git config --global --fixed-value --unset-all safe.directory "$value" 2>/dev/null || true
}

cleanup_test() {
  local exit_code=$?
  set +e
  if [ -d "$TEST_REPO/.git" ]; then
    WIKILLM_REPO_ROOT="$TEST_REPO" \
      bash "$SCRIPT_DIR/cleanup-feature.sh" --docker-only "$FEATURE" >/dev/null 2>&1
    WIKILLM_REPO_ROOT="$TEST_REPO" \
      bash "$SCRIPT_DIR/cleanup-feature.sh" --docker-only "$DIRTY_FEATURE" >/dev/null 2>&1
    WIKILLM_REPO_ROOT="$TEST_REPO" \
      bash "$SCRIPT_DIR/cleanup-feature.sh" --docker-only "$CREATE_FEATURE" >/dev/null 2>&1
    WIKILLM_REPO_ROOT="$TEST_REPO" \
      bash "$SCRIPT_DIR/cleanup-feature.sh" --docker-only "$DEPLOY_FEATURE" >/dev/null 2>&1
  fi
  remove_safe_directory "%(prefix)/$TEST_REPO/worktrees/$FEATURE"
  remove_safe_directory "$TEST_REPO/worktrees/$FEATURE"
  remove_safe_directory "%(prefix)/$TEST_REPO/worktrees/$DIRTY_FEATURE"
  remove_safe_directory "$TEST_REPO/worktrees/$DIRTY_FEATURE"
  remove_safe_directory "%(prefix)/$TEST_REPO/worktrees/$CREATE_FEATURE"
  remove_safe_directory "$TEST_REPO/worktrees/$CREATE_FEATURE"
  remove_safe_directory "%(prefix)/$TEST_REPO/worktrees/$DEPLOY_FEATURE"
  remove_safe_directory "$TEST_REPO/worktrees/$DEPLOY_FEATURE"
  docker volume rm "$TEST_MAIN_VOLUME" >/dev/null 2>&1 || true
  case "$TEST_REPO" in
    */exampleproject-lifecycle.*) rm -rf -- "$TEST_REPO" ;;
    *) printf '!! 拒绝删除意外测试路径: %s\n' "$TEST_REPO" >&2 ;;
  esac
  exit "$exit_code"
}
trap cleanup_test EXIT

assert_absent() {
  local kind="$1"
  local name="$2"
  case "$kind" in
    container)
      [ -z "$(docker ps -aq --filter "name=^/${name}$")" ]
      ;;
    volume)
      ! docker volume inspect "$name" >/dev/null 2>&1
      ;;
    network)
      ! docker network inspect "$name" >/dev/null 2>&1
      ;;
    image)
      ! docker image inspect "$name" >/dev/null 2>&1
      ;;
    *)
      printf '未知断言类型: %s\n' "$kind" >&2
      return 1
      ;;
  esac
}

create_docker_fixture() {
  local feature="$1"
  local project="exampleproject-$feature"
  local image="example-wiki:$feature"
  local container="example-wiki-$feature"
  local extra_container="exampleproject-extra-$feature"
  local volume="example-wiki-data-$feature"
  local extra_volume="exampleproject-extra-data-$feature"
  local network="${project}_default"

  docker tag node:22-slim "$image"
  docker volume create \
    --label com.exampleproject.scope=feature \
    --label "com.exampleproject.feature=$feature" \
    "$volume" >/dev/null
  docker volume create \
    --label com.exampleproject.scope=feature \
    --label "com.exampleproject.feature=$feature" \
    "$extra_volume" >/dev/null
  docker network create \
    --label com.exampleproject.scope=feature \
    --label "com.exampleproject.feature=$feature" \
    --label "com.docker.compose.project=$project" \
    "$network" >/dev/null
  MSYS_NO_PATHCONV=1 docker create \
    --name "$container" \
    --label com.exampleproject.scope=feature \
    --label "com.exampleproject.feature=$feature" \
    --label "com.docker.compose.project=$project" \
    --network "$network" \
    --mount "type=volume,source=$volume,target=/data" \
    "$image" sleep 300 >/dev/null
  MSYS_NO_PATHCONV=1 docker create \
    --name "$extra_container" \
    --label com.exampleproject.scope=feature \
    --label "com.exampleproject.feature=$feature" \
    --network "$network" \
    "$image" sleep 300 >/dev/null
}

printf '== shell syntax ==\n'
for script in \
  "$SCRIPT_DIR/worktree-common.sh" \
  "$SCRIPT_DIR/cleanup-feature.sh" \
  "$SCRIPT_DIR/new-worktree.sh" \
  "$SCRIPT_DIR/merge-feature.sh"
do
  bash -n "$script"
done

printf '== compose interpolation ==\n'
WIKILLM_FEATURE="$FEATURE" WIKILLM_PORT=18081 \
  docker compose \
    --project-name "exampleproject-$FEATURE" \
    -f "$SCRIPT_DIR/../docker-compose.worktree.yml" \
    config >/dev/null

printf '== temporary git repository ==\n'
git init --initial-branch=main "$TEST_REPO" >/dev/null
git -C "$TEST_REPO" config user.name "ExampleProject Script Test"
git -C "$TEST_REPO" config user.email "scripts@example.invalid"
mkdir -p "$TEST_REPO/main" "$TEST_REPO/worktrees"
printf '/worktrees/*\n' > "$TEST_REPO/.gitignore"
printf 'base\n' > "$TEST_REPO/main/base.txt"
cp "$SCRIPT_DIR/../docker-compose.worktree.yml" "$TEST_REPO/main/docker-compose.worktree.yml"
cat > "$TEST_REPO/main/Dockerfile" <<'EOF'
FROM node:22-slim
CMD ["node", "-e", "require('node:http').createServer((_req,res)=>res.end('ok')).listen(8080,'0.0.0.0')"]
EOF
git -C "$TEST_REPO" add .gitignore main/base.txt main/docker-compose.worktree.yml main/Dockerfile
git -C "$TEST_REPO" commit -m "test: base" >/dev/null

printf '== create worktree with labeled preview resources ==\n'
docker volume create "$TEST_MAIN_VOLUME" >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$TEST_MAIN_VOLUME:/dst" \
  node:22-slim sh -c 'printf seeded > /dst/seed.txt'
CREATE_PORT="$(
  node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
)"
WIKILLM_REPO_ROOT="$TEST_REPO" \
WIKILLM_MAIN_VOLUME="$TEST_MAIN_VOLUME" \
  bash "$SCRIPT_DIR/new-worktree.sh" "$CREATE_FEATURE" "$CREATE_PORT"
MSYS_NO_PATHCONV=1 docker exec "example-wiki-$CREATE_FEATURE" test -f /data/seed.txt
test "$(
  docker inspect "example-wiki-$CREATE_FEATURE" \
    --format '{{index .Config.Labels "com.exampleproject.feature"}}'
)" = "$CREATE_FEATURE"
test "$(
  docker image inspect "example-wiki:$CREATE_FEATURE" \
    --format '{{index .Config.Labels "com.exampleproject.feature"}}'
)" = "$CREATE_FEATURE"
WIKILLM_REPO_ROOT="$TEST_REPO" \
  bash "$SCRIPT_DIR/cleanup-feature.sh" "$CREATE_FEATURE"
assert_absent container "example-wiki-$CREATE_FEATURE"
assert_absent volume "example-wiki-data-$CREATE_FEATURE"
assert_absent network "exampleproject-${CREATE_FEATURE}_default"
assert_absent image "example-wiki:$CREATE_FEATURE"

FEATURE_WORKTREE="$TEST_REPO/worktrees/$FEATURE"
git -C "$TEST_REPO" worktree add "$FEATURE_WORKTREE" -b "feat/$FEATURE" main >/dev/null
printf 'feature\n' > "$FEATURE_WORKTREE/main/feature.txt"
git -C "$FEATURE_WORKTREE" add main/feature.txt
git -C "$FEATURE_WORKTREE" commit -m "feat: lifecycle smoke" >/dev/null
git config --global --add safe.directory "%(prefix)/$FEATURE_WORKTREE"
git config --global --add safe.directory "$FEATURE_WORKTREE"
mkdir -p "$TEST_REPO/.git/test-bin"
cat > "$TEST_REPO/.git/test-bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  test|typecheck|build)
    if [ -n "${WIKILLM_EXPECT_FILE:-}" ]; then
      test -f "$WIKILLM_EXPECT_FILE"
    fi
    printf '%s\n' "$1" >> "$WIKILLM_TEST_PNPM_LOG"
    ;;
  *)
    printf 'unexpected pnpm command: %s\n' "${1:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$TEST_REPO/.git/test-bin/pnpm"

printf '== labeled docker fixture ==\n'
docker image inspect node:22-slim >/dev/null
create_docker_fixture "$FEATURE"

printf '== merge, verify, and zero-residue cleanup ==\n'
PNPM_LOG="$TEST_REPO/.git/pnpm.log"
WIKILLM_REPO_ROOT="$TEST_REPO" \
WIKILLM_TEST_PNPM_LOG="$PNPM_LOG" \
WIKILLM_EXPECT_FILE=feature.txt \
PATH="$TEST_REPO/.git/test-bin:$PATH" \
  bash "$SCRIPT_DIR/merge-feature.sh" "$FEATURE"

test -f "$TEST_REPO/main/feature.txt"
test "$(tr '\n' ' ' < "$PNPM_LOG")" = "test typecheck build "
test ! -e "$FEATURE_WORKTREE"
! git -C "$TEST_REPO" show-ref --verify --quiet "refs/heads/feat/$FEATURE"
assert_absent container "example-wiki-$FEATURE"
assert_absent container "exampleproject-extra-$FEATURE"
assert_absent volume "example-wiki-data-$FEATURE"
assert_absent volume "exampleproject-extra-data-$FEATURE"
assert_absent network "exampleproject-$FEATURE"
assert_absent network "exampleproject-${FEATURE}_default"
assert_absent image "example-wiki:$FEATURE"
! git config --global --get-all safe.directory | grep -Fx "$FEATURE_WORKTREE" >/dev/null
! git config --global --get-all safe.directory | grep -Fx "%(prefix)/$FEATURE_WORKTREE" >/dev/null

printf '== dirty worktree refusal ==\n'
DIRTY_WORKTREE="$TEST_REPO/worktrees/$DIRTY_FEATURE"
git -C "$TEST_REPO" worktree add "$DIRTY_WORKTREE" -b "feat/$DIRTY_FEATURE" main >/dev/null
printf 'uncommitted\n' > "$DIRTY_WORKTREE/main/uncommitted.txt"
git config --global --add safe.directory "%(prefix)/$DIRTY_WORKTREE"
create_docker_fixture "$DIRTY_FEATURE"
if WIKILLM_REPO_ROOT="$TEST_REPO" \
  bash "$SCRIPT_DIR/cleanup-feature.sh" "$DIRTY_FEATURE"
then
  printf '!! 脏 worktree 被错误清理\n' >&2
  exit 1
fi
docker volume inspect "example-wiki-data-$DIRTY_FEATURE" >/dev/null

rm -f -- "$DIRTY_WORKTREE/main/uncommitted.txt"
WIKILLM_REPO_ROOT="$TEST_REPO" \
  bash "$SCRIPT_DIR/cleanup-feature.sh" "$DIRTY_FEATURE"
assert_absent container "example-wiki-$DIRTY_FEATURE"
assert_absent volume "example-wiki-data-$DIRTY_FEATURE"
assert_absent network "exampleproject-${DIRTY_FEATURE}_default"
assert_absent image "example-wiki:$DIRTY_FEATURE"

printf '== deploy path with command stubs ==\n'
DEPLOY_WORKTREE="$TEST_REPO/worktrees/$DEPLOY_FEATURE"
git -C "$TEST_REPO" worktree add "$DEPLOY_WORKTREE" -b "feat/$DEPLOY_FEATURE" main >/dev/null
printf 'deploy\n' > "$DEPLOY_WORKTREE/main/deploy.txt"
git -C "$DEPLOY_WORKTREE" add main/deploy.txt
git -C "$DEPLOY_WORKTREE" commit -m "feat: deploy path smoke" >/dev/null
git config --global --add safe.directory "%(prefix)/$DEPLOY_WORKTREE"

DEPLOY_BIN="$TEST_REPO/.git/deploy-bin"
DOCKER_LOG="$TEST_REPO/.git/docker.log"
DEPLOY_PNPM_LOG="$TEST_REPO/.git/deploy-pnpm.log"
mkdir -p "$DEPLOY_BIN"
cat > "$DEPLOY_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$WIKILLM_TEST_DOCKER_LOG"
case "${1:-}" in
  info|build|ps|compose|rm|exec)
    exit 0
    ;;
  inspect)
    if [ "${2:-}" = "example-wiki" ]; then
      printf 'sha256:test-current\n'
      exit 0
    fi
    exit 1
    ;;
  image)
    case "${2:-}" in
      ls)
        if printf '%s\n' "$*" | grep -F -- '--format' >/dev/null; then
          printf '%s\n' \
            'example-wiki|main-old-test' \
            'example-wiki|pre-old-test' \
            'example-wiki|a1b2c3d' \
            'example-wiki|0.1.0'
        fi
        exit 0
        ;;
      inspect)
        case "${3:-}" in
          example-wiki:main-old-test) printf 'sha256:main-old\n'; exit 0 ;;
          example-wiki:pre-old-test) printf 'sha256:pre-old\n'; exit 0 ;;
          example-wiki:a1b2c3d) printf 'sha256:commit-old\n'; exit 0 ;;
          *) exit 1 ;;
        esac
        ;;
      rm) exit 0 ;;
    esac
    ;;
  volume|network)
    case "${2:-}" in
      ls|rm) exit 0 ;;
      inspect) exit 1 ;;
    esac
    ;;
esac
exit 0
EOF
cat > "$DEPLOY_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$DEPLOY_BIN/docker" "$DEPLOY_BIN/curl"

WIKILLM_REPO_ROOT="$TEST_REPO" \
WIKILLM_TEST_DOCKER_LOG="$DOCKER_LOG" \
WIKILLM_TEST_PNPM_LOG="$DEPLOY_PNPM_LOG" \
WIKILLM_EXPECT_FILE=deploy.txt \
PATH="$DEPLOY_BIN:$TEST_REPO/.git/test-bin:$PATH" \
  bash "$SCRIPT_DIR/merge-feature.sh" --deploy "$DEPLOY_FEATURE"

test -f "$TEST_REPO/main/deploy.txt"
test "$(tr '\n' ' ' < "$DEPLOY_PNPM_LOG")" = "test typecheck build "
grep -F "build --label" "$DOCKER_LOG" >/dev/null
grep -F "compose --project-name main" "$DOCKER_LOG" >/dev/null
grep -F "up -d --no-build --remove-orphans" "$DOCKER_LOG" >/dev/null
grep -F "image rm example-wiki:main-old-test" "$DOCKER_LOG" >/dev/null
grep -F "image rm example-wiki:pre-old-test" "$DOCKER_LOG" >/dev/null
grep -F "image rm example-wiki:a1b2c3d" "$DOCKER_LOG" >/dev/null
! grep -F "image rm example-wiki:0.1.0" "$DOCKER_LOG" >/dev/null
test ! -e "$DEPLOY_WORKTREE"
! git -C "$TEST_REPO" show-ref --verify --quiet "refs/heads/feat/$DEPLOY_FEATURE"

printf 'PASS: merge and cleanup lifecycle leaves zero feature residue\n'
