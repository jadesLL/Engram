#!/usr/bin/env bash
#
# 三端一致性巡检（PLATFORM-PARALLEL-DEV.md §6.2）
#
# 用途：
#   1) 跑 web/src/lib/platformParity.test.ts 的静态契约检查（版本号 / 能力位 / 原生桥 / 构建链 / 设置域 / 滞后清单）；
#   2) 用 --since 审计某区间内涉及三端源码的提交是否都写了「平台影响:」声明（每周巡检、发版前置）。
#
# 用法：
#   bash main/scripts/platform-parity-check.sh
#   bash main/scripts/platform-parity-check.sh --since v1.5.6
#   bash main/scripts/platform-parity-check.sh --since v1.5.6 --strict   # 发版/巡检严格模式：缺声明即失败
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MAIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd "$MAIN_ROOT/.." && pwd -P)"

usage() {
  cat <<'EOF'
用法:
  platform-parity-check.sh [--since <git-ref>] [--strict]

  （无参数）        只跑三端契约检查（与 verify 内 platformParity.test.ts 相同）
  --since <ref>     额外审计 ref..HEAD 之间涉及三端源码的提交是否写了「平台影响:」声明
  --strict          --since 审计中只要有提交缺声明就以非零退出（发版前置）

示例:
  bash main/scripts/platform-parity-check.sh
  bash main/scripts/platform-parity-check.sh --since v1.5.6
  bash main/scripts/platform-parity-check.sh --since v1.5.6 --strict

说明:
  契约定义与同步节奏见 docs/PLATFORM-PARALLEL-DEV.md；手机滞后清单见 docs/MOBILE-SYNC-LEDGER.md。
EOF
}

SINCE=""
STRICT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --since)
      [ "$#" -ge 2 ] || { echo "错误：--since 需要一个 git ref" >&2; exit 2; }
      SINCE="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "错误：未知参数 $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -n "$SINCE" ]; then
  if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$SINCE" >/dev/null; then
    echo "错误：找不到 git ref：$SINCE" >&2
    exit 2
  fi
fi

echo ">> 三端契约检查（web/src/lib/platformParity.test.ts）"
(
  cd "$MAIN_ROOT"
  node --test web/src/lib/platformParity.test.ts
)

if [ -n "$SINCE" ]; then
  echo
  echo ">> 平台影响声明审计：$SINCE..HEAD（涉及 main/web main/server main/mobile main/desktop 的提交）"
  total=0
  missing=0
  while IFS=$'\t' read -r sha subject; do
    [ -n "$sha" ] || continue
    total=$((total + 1))
    body="$(git -C "$REPO_ROOT" show -s --format=%B "$sha")"
    if ! printf '%s\n' "$body" | grep -qE '平台影响[：:][[:space:]]*[A-Fa-f]|平台影响[：:][[:space:]]*none'; then
      echo "  缺少声明: $sha $subject"
      missing=$((missing + 1))
    fi
  done < <(git -C "$REPO_ROOT" log --no-merges --format='%H%x09%s' "$SINCE..HEAD" -- main/web main/server main/mobile main/desktop)
  echo "  提交总数 $total，缺少「平台影响:」声明 $missing 条"
  if [ "$STRICT" -eq 1 ] && [ "$missing" -gt 0 ]; then
    echo "FAIL：区间内有 $missing 条提交缺少平台影响声明。" >&2
    echo "      声明格式见 docs/PLATFORM-PARALLEL-DEV.md §4.3（提交信息末行：平台影响: A|B|C|D|E|F|none）。" >&2
    exit 1
  fi
fi

echo
echo "OK：三端契约检查通过"
