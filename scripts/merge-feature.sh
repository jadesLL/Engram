#!/usr/bin/env bash
# 把一个已完成的功能分支合并回 main、重部署 main 容器、清理该功能的临时资源。
# 由 AI Agent 执行。
#
# ⚠️ 串行规则：同一时刻只能有一个 merge-feature.sh 在跑！
#    worktree 只隔离"开发"阶段；合并阶段必须排队（多个 Agent 不能同时改 main 的 ref）。
#    多功能并行开发 → 合并时按 A、B、C 依次串行执行本脚本。
#
# 前置：main 工作区必须干净（无未提交 WIP）。若 main 上有 live 开发，先提交/迁移到 feat 分支。
# 用法：
#   scripts/merge-feature.sh <feature>
#   例: scripts/merge-feature.sh ai-organize-logs
set -euo pipefail

FEATURE="${1:?usage: merge-feature.sh <feature>   或冲突解决后: merge-feature.sh --finish <feature>}"
FINISH=0
if [ "$FEATURE" = "--finish" ]; then
  FINISH=1; FEATURE="${2:?usage: merge-feature.sh --finish <feature>}"
fi
REPO="//tsclient/D/SoftwareWorkspace/Wiki知识库"
WT="$REPO-$FEATURE"
BRANCH="feat/$FEATURE"
VOL="example-wiki-data-$FEATURE"

cd "$REPO"

echo ">> [1/5] 检查 main 工作区干净"
if [ -n "$(git status --porcelain)" ]; then
  echo "!! main 工作区有未提交改动，无法安全合并："
  git status -s
  echo "   先提交/暂存 main 的改动，再重跑本脚本。"
  exit 1
fi

if [ "$FINISH" = 1 ]; then
  echo ">> [2/5] --finish 模式：跳过合并（已在冲突解决后完成），继续重部署+清理"
else
  echo ">> [2/5] 合并 $BRANCH -> main （串行：确认没有别的 merge 在跑）"
  git checkout main
  if ! git merge --no-ff "$BRANCH"; then
    echo "!! 合并冲突！请在 $REPO 解决后执行："
    echo "     git add -A && git commit      # 完成合并"
    echo "     scripts/merge-feature.sh --finish $FEATURE   # 继续清理"
    exit 1
  fi
fi

echo ">> [3/5] 用合并后的代码重建 + 重部署 main 容器（8080, 卷 example-wiki-data）"
bash scripts/ensure-office-env.sh "$REPO"
if docker ps --format '{{.Names}}' | grep -qx 'example-wiki-onlyoffice'; then
  echo "   请求 ONLYOFFICE 保存活动编辑会话"
  docker exec example-wiki-onlyoffice documentserver-prepare4shutdown.sh || true
  docker compose -f docker-compose.unc.yml stop onlyoffice
fi
docker compose -f docker-compose.unc.yml build
docker compose -f docker-compose.unc.yml up -d
READY=0
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null http://localhost:8080/ \
    && curl -sf -o /dev/null http://localhost:8080/onlyoffice/healthcheck; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != 1 ]; then
  echo "!! main 容器未在 8080 响应，查 docker logs example-wiki —— 不清理功能资源，便于回退"
  exit 1
fi
echo "   main 与 ONLYOFFICE 已在 8080 就绪"

echo ">> [4/5] 清理该功能的临时容器 + 卷"
if [ -f "$WT/docker-compose.worktree.yml" ]; then
  FEATURE_OFFICE="example-wiki-$FEATURE-onlyoffice"
  if docker ps --format '{{.Names}}' | grep -qx "$FEATURE_OFFICE"; then
    docker exec "$FEATURE_OFFICE" documentserver-prepare4shutdown.sh || true
  fi
  docker compose -f "$WT/docker-compose.worktree.yml" down -v
fi
docker volume rm "$VOL" 2>/dev/null || true

echo ">> [5/5] 移除 worktree + 删分支"
git worktree remove "$WT" 2>/dev/null || { echo "   worktree 有未提交内容，未自动删；确认无误后: git worktree remove --force \"$WT\""; }
git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH" 2>/dev/null || true

echo "DONE ✔  $FEATURE 已并入 main 并重部署，功能资源已清理。"
