#!/usr/bin/env bash
# 把私有仓库导出为「可公开」快照并推送（默认只推 main + 标签）。
#
# 设计要点：
#   * 脚本本身不含任何真实敏感串：Gitea 主机/owner 从 origin 远端推导，
#     其余敏感串（域名、账号、密码、其他私有项目名、内网 IP）由外部规则文件提供
#     —— CI 里来自 Gitea Actions secret，本地来自未入库文件。
#   * 绝不修改源仓库：只在 mktemp 出来的临时裸克隆里重写。
#
# 安全护栏：
#   1) 快照目录必须落在临时目录内；
#   2) filter-repo 的 cwd 必须是快照目录（其默认 --target 就是 cwd，曾因此误改真实仓库）；
#   3) 执行前后比对源仓库全部 refs 指纹，一旦被改动立即中止。
#
# Windows 路径说明：runner 是 Windows 宿主机模式，workflow 里设了 MSYS_NO_PATHCONV=1。
# 因此所有交给 git / python 这类原生程序的路径都用 nat() 转成 Windows 形式，
# 不能直接用 bash 的 /c/... 形式（转换关闭时原生 git 解析不了）。
#
# 环境变量：
#   PUBLIC_SANITIZE_RULES       额外规则内容（多行，CI 用 secret）
#   PUBLIC_SANITIZE_RULES_FILE  额外规则文件路径
#   SNAPSHOT_EMAIL              快照使用的邮箱（必填）
#   SNAPSHOT_NAME               快照使用的作者名（默认 Engram）
#   SNAPSHOT_REPO_URL           目标公开仓库地址（同时用于推导仓库内链接的改写目标）
#   SNAPSHOT_PUBLIC_URL         可选，覆盖链接改写目标（默认取 SNAPSHOT_REPO_URL 去掉 .git）
#   SNAPSHOT_TOKEN              目标仓库写入令牌
#   SNAPSHOT_DRY_RUN            1 = 只重写与校验，不推送
#   SNAPSHOT_KEEP               1 = 保留快照目录供排查
#   SNAPSHOT_BRANCH / SNAPSHOT_PUSH_TAGS / SNAPSHOT_SYNC_RELEASES
#   SNAPSHOT_SRC_REPO / SNAPSHOT_FILTER_REPO
#   SNAPSHOT_HOST_FROM / SNAPSHOT_OWNER_FROM / SNAPSHOT_HOST_TO / SNAPSHOT_OWNER_TO
set -euo pipefail

DRY_RUN="${SNAPSHOT_DRY_RUN:-0}"
SNAPSHOT_NAME="${SNAPSHOT_NAME:-Engram}"
BRANCH="${SNAPSHOT_BRANCH:-main}"
PUSH_TAGS="${SNAPSHOT_PUSH_TAGS:-1}"
SYNC_RELEASES="${SNAPSHOT_SYNC_RELEASES:-1}"
HOST_TO="${SNAPSHOT_HOST_TO:-gitea.example.com}"
OWNER_TO="${SNAPSHOT_OWNER_TO:-example}"

: "${SNAPSHOT_EMAIL:?需要 SNAPSHOT_EMAIL（快照使用的邮箱）}"
if [ "$DRY_RUN" != "1" ]; then
  : "${SNAPSHOT_REPO_URL:?需要 SNAPSHOT_REPO_URL}"
  : "${SNAPSHOT_TOKEN:?需要 SNAPSHOT_TOKEN}"
fi

# 交给原生程序的路径统一转 Windows 形式
nat() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

SRC_REPO="${SNAPSHOT_SRC_REPO:-$(git rev-parse --show-toplevel)}"
SRC_REPO="$(cd "$SRC_REPO" && pwd -P)"
SRC_REPO_NAT="$(nat "$SRC_REPO")"

# ---------- 从 origin 推导真实主机与 owner ----------
REMOTE_URL="$(git -C "$SRC_REPO_NAT" remote get-url origin 2>/dev/null || true)"
HOST_FROM="${SNAPSHOT_HOST_FROM:-}"
OWNER_FROM="${SNAPSHOT_OWNER_FROM:-}"
if [ -z "$HOST_FROM" ] || [ -z "$OWNER_FROM" ]; then
  parsed="$(printf '%s' "$REMOTE_URL" | sed -n 's#^\(https\?://[^/]\+\)/\([^/]\+\)/.*#\1 \2#p')"
  [ -n "$parsed" ] || { echo "无法从 origin 推导主机/owner（远端：${REMOTE_URL:-<空>}）" >&2; exit 1; }
  HOST_FROM="${HOST_FROM:-${parsed%% *}}"
  OWNER_FROM="${OWNER_FROM:-${parsed##* }}"
fi
HOST_FROM="${HOST_FROM#http://}"; HOST_FROM="${HOST_FROM#https://}"
HOST_NOPORT="${HOST_FROM%%:*}"
echo ">> 真实主机: $HOST_FROM（无端口 $HOST_NOPORT），真实 owner: $OWNER_FROM"
echo ">> 替换为:   $HOST_TO / $OWNER_TO"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
SNAP="$WORK/snapshot.git"

# 快照仓库上的 git 操作统一走这个包装（路径转原生）
g() { git -C "$(nat "$SNAP")" "$@"; }

# ---------- 护栏 1 ----------
case "$SNAP" in "$WORK"/*) ;; *) echo "护栏 1 失败：快照不在临时目录内：$SNAP" >&2; exit 1 ;; esac

# ---------- 护栏 3（前）----------
src_fp() { git -C "$SRC_REPO_NAT" for-each-ref --format='%(refname) %(objectname)' | sort | sha256sum; }
SRC_FP_BEFORE="$(src_fp)"
echo ">> 源仓库 refs 指纹（前）: ${SRC_FP_BEFORE%% *}"

# ---------- 公开仓库基址：把指向本仓库的 Gitea 链接改写成公开仓库对应链接 ----------
# 全部由已有信息推导，不需要额外配置：公开仓库地址 + 从 origin 解析出的主机/owner/仓库名。
PUBLIC_BASE="${SNAPSHOT_PUBLIC_URL:-}"
if [ -z "$PUBLIC_BASE" ] && [ -n "${SNAPSHOT_REPO_URL:-}" ]; then
  PUBLIC_BASE="${SNAPSHOT_REPO_URL%.git}"
fi
PUBLIC_BASE="${PUBLIC_BASE%/}"

# ---------- 规则顺序：改写 → 主机占位 → 外部规则 → 裸 owner ----------
RULES="$WORK/rules.txt"
: > "$RULES"

# ① 指向本仓库的 Gitea 链接改写成公开仓库链接。
#    必须排在主机名占位之前，否则主机名先被换成占位串，这里就再也匹配不到完整 URL。
if [ -n "$PUBLIC_BASE" ]; then
  REPO_FROM="$(printf '%s' "$REMOTE_URL" | sed -n 's#^.*/\([^/]\+\)\.git$#\1#p')"
  [ -n "$REPO_FROM" ] || REPO_FROM="$(basename "${REMOTE_URL%.git}")"
  {
    # 安装器固定链接（Gitea generic 包）→ 公开仓库固定标签 installer-latest 下的 Release 附件
    printf 'literal:https://%s/api/packages/%s/generic/engram-installer/latest/==>%s/releases/download/installer-latest/\n' \
      "$HOST_FROM" "$OWNER_FROM" "$PUBLIC_BASE"
    printf 'literal:https://%s/api/packages/%s/generic/engram-installer/latest/==>%s/releases/download/installer-latest/\n' \
      "$HOST_NOPORT" "$OWNER_FROM" "$PUBLIC_BASE"
    # 仓库地址：仓库首页 / .git / releases / 任意子路径都归到公开仓库同名路径
    printf 'literal:https://%s/%s/%s==>%s\n' "$HOST_FROM" "$OWNER_FROM" "$REPO_FROM" "$PUBLIC_BASE"
    printf 'literal:https://%s/%s/%s==>%s\n' "$HOST_NOPORT" "$OWNER_FROM" "$REPO_FROM" "$PUBLIC_BASE"
  } >> "$RULES"
  echo ">> 仓库内链接改写为: $PUBLIC_BASE（源 $OWNER_FROM/$REPO_FROM）"
else
  echo ">> 提示：未拿到公开仓库地址，仓库内链接只做占位替换（本地干跑可传 SNAPSHOT_PUBLIC_URL）" >&2
fi

# ①b 私有 Registry 的镜像命令：公开仓库没有对应 Registry，换成明确说明。
#     这两串在所有文件里都指私有 Registry，所以全局替换语义正确；
#     必须排在主机名占位之前（左串里含真实主机名）。
{
  printf 'literal:docker login %s -u %s -p <package权限token>==># Docker 镜像未公开发布（原私有 Registry 不对外）\n' "$HOST_FROM" "$OWNER_FROM"
  printf 'literal:docker pull %s/%s/engram/engram:<版本>==># 需要镜像请自行构建：docker compose -f main/docker-compose.yml up -d --build\n' "$HOST_FROM" "$OWNER_FROM"
} >> "$RULES"

# ② 其余 Gitea 主机名占位（带端口的必须在前，否则会残留端口）
{
  printf 'literal:%s==>%s\n' "$HOST_FROM" "$HOST_TO"
  printf 'literal:%s==>%s\n' "$HOST_NOPORT" "$HOST_TO"
} >> "$RULES"

# ③ README 口径修正：这几句描述的是私有仓库，在公开仓库里不成立。
#    经确认这几串只出现在 README.md，所以全局替换是精确的。
#    （Docker 镜像那几行无法靠替换修好——公开仓库没有对应 Registry，只能保留占位串。）
{
  printf 'literal:==>\n'
  printf 'literal:公开仓库无需凭据==>公开仓库无需凭据\n'
  printf 'literal:- **GitHub Release**：==>- **GitHub Release**：\n'
  printf 'literal:发布到 GitHub Release 正文==>发布到 GitHub Release 正文\n'
  printf 'literal:公开仓库未发布 Docker 镜像；自建部署请从源码构建：==>公开仓库未发布 Docker 镜像；自建部署请从源码构建：\n'
  printf 'literal:（未公开发布；需要请自行构建）==>（未公开发布；需要请自行构建）\n'
} >> "$RULES"

EXTRA_FILE=""
LOCAL_RULES="$SRC_REPO/main/.public-mirror/rules.local.txt"
if [ -n "${PUBLIC_SANITIZE_RULES_FILE:-}" ]; then
  [ -f "$PUBLIC_SANITIZE_RULES_FILE" ] || { echo "规则文件不存在：$PUBLIC_SANITIZE_RULES_FILE" >&2; exit 1; }
  EXTRA_FILE="$PUBLIC_SANITIZE_RULES_FILE"
elif [ -n "${PUBLIC_SANITIZE_RULES:-}" ]; then
  EXTRA_FILE="$WORK/extra-rules.txt"
  printf '%s\n' "$PUBLIC_SANITIZE_RULES" > "$EXTRA_FILE"
elif [ -f "$LOCAL_RULES" ]; then
  # 本地运行：用未入库的规则文件（该路径已在根 .gitignore 中忽略）
  EXTRA_FILE="$LOCAL_RULES"
  echo ">> 使用本地规则文件: $LOCAL_RULES"
fi
if [ -n "$EXTRA_FILE" ]; then
  # 去掉空行与注释后追加
  grep -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$EXTRA_FILE" >> "$RULES" || true
  echo ">> 已合并外部规则: $(grep -c -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$EXTRA_FILE" || true) 条"
else
  echo ">> 警告：未提供外部规则（PUBLIC_SANITIZE_RULES / _FILE），仅替换 Gitea 主机与 owner" >&2
fi

# 裸 owner 兜底放最后（词边界，避免误伤更长串）
printf 'regex:\\b%s\\b==>%s\n' "$OWNER_FROM" "$OWNER_TO" >> "$RULES"

# ---------- 路径名也要脱敏（Android 包目录 com/<owner>/<project>/ 这类）----------
# filter-repo 的 --replace-text 只改文件内容，路径名要另用 --filename-callback。
export PUBLIC_MIRROR_RULES="$(nat "$RULES")"
cat > "$WORK/filename_cb.py" <<'PY'
import os, re
_rules = []
for _line in open(os.environ['PUBLIC_MIRROR_RULES'], 'rb').read().split(b'\n'):
    _line = _line.strip()
    if not _line or _line.startswith(b'#'):
        continue
    _left, _sep, _right = _line.partition(b'==>')
    if not _sep or _left.startswith(b'glob:'):
        continue
    if _left.startswith(b'regex:'):
        _rules.append((re.compile(_left[6:]), _right))
    else:
        if _left.startswith(b'literal:'):
            _left = _left[8:]
        if _left:
            _rules.append((re.compile(re.escape(_left)), _right))
for _pat, _repl in _rules:
    filename = _pat.sub(_repl, filename)
return filename
PY

# ---------- 定位 git-filter-repo ----------
FILTER_REPO_CMD="${SNAPSHOT_FILTER_REPO:-}"
if [ -z "$FILTER_REPO_CMD" ]; then
  if command -v git-filter-repo >/dev/null 2>&1; then
    FILTER_REPO_CMD="git-filter-repo"
  elif python -c "import git_filter_repo" >/dev/null 2>&1; then
    FILTER_REPO_CMD="python $(python -c 'import git_filter_repo;print(git_filter_repo.__file__)')"
  else
    echo "缺少 git-filter-repo：pip install git-filter-repo" >&2; exit 1
  fi
fi

# ---------- 克隆 + 重写 ----------
echo ">> 克隆临时裸副本..."
git clone --bare --no-local --quiet "$SRC_REPO_NAT" "$(nat "$SNAP")"
g remote remove origin >/dev/null 2>&1 || true
SNAP_MAIN_BEFORE="$(g rev-parse "refs/heads/$BRANCH")"

# ---------- 护栏 2 ----------
cd "$SNAP"
echo ">> filter-repo cwd: $(pwd -P)"
case "$(pwd -P)" in "$WORK"/*) ;; *) echo "护栏 2 失败：cwd 不在临时目录内" >&2; exit 1 ;; esac

echo ">> 重写历史（内容 + 提交/标签信息 + 路径名 + 作者身份）..."
START=$(date +%s)
# shellcheck disable=SC2086
$FILTER_REPO_CMD \
  --force \
  --replace-text "../rules.txt" \
  --replace-message "../rules.txt" \
  --filename-callback "../filename_cb.py" \
  --name-callback "return b'$SNAPSHOT_NAME' if name == b'$OWNER_FROM' else name" \
  --email-callback "
if email.endswith(b'@users.noreply.github.com'):
    return email
if b'agent@' in email:
    return email
return b'$SNAPSHOT_EMAIL'
" >/dev/null
echo ">> 重写耗时: $(( $(date +%s) - START )) 秒"

# ---------- 护栏 3（后）----------
SRC_FP_AFTER="$(src_fp)"
if [ "$SRC_FP_BEFORE" != "$SRC_FP_AFTER" ]; then
  echo "!! 护栏 3 失败：源仓库 refs 被改动了！" >&2
  echo "   before=${SRC_FP_BEFORE%% *}  after=${SRC_FP_AFTER%% *}" >&2
  exit 1
fi
echo ">> 护栏 3 通过：源仓库 refs 指纹未变"

SNAP_MAIN_AFTER="$(g rev-parse "refs/heads/$BRANCH")"
[ "$SNAP_MAIN_BEFORE" != "$SNAP_MAIN_AFTER" ] || { echo "!! 快照 main 未变化，filter-repo 未生效" >&2; exit 1; }
echo ">> 快照 $BRANCH: ${SNAP_MAIN_BEFORE:0:7} -> ${SNAP_MAIN_AFTER:0:7}"

# ---------- 校验：逐条规则反查全历史（blob + 提交信息 + 标签信息 + 路径）----------
echo ">> 校验残留（逐条规则反查）..."
g rev-list --objects --all | awk '{print $1}' | sort -u > "$WORK/blobs.txt"
g cat-file --batch < "$WORK/blobs.txt" > "$WORK/corpus.bin" 2>/dev/null || true
g log --all --format='%H %an %ae %cn %ce %s%n%b' >> "$WORK/corpus.bin"
g for-each-ref refs/tags --format='%(contents)' >> "$WORK/corpus.bin"

FAIL=0
python - "$(nat "$RULES")" "$(nat "$WORK/corpus.bin")" <<'PY' || FAIL=1
import re, sys
rules_path, corpus_path = sys.argv[1], sys.argv[2]
corpus = open(corpus_path, 'rb').read()
bad = []
for raw in open(rules_path, 'rb').read().split(b'\n'):
    line = raw.strip()
    if not line or line.startswith(b'#'):
        continue
    left = line.split(b'==>', 1)[0]
    if left.startswith(b'regex:'):
        pat = left[6:]
        try:
            if re.search(pat, corpus):
                bad.append(('regex', pat.decode('utf-8', 'replace')))
        except re.error as e:
            bad.append(('bad-regex', f'{pat!r} {e}'))
    elif left.startswith(b'glob:'):
        continue
    else:
        if left.startswith(b'literal:'):
            left = left[8:]
        if left and left in corpus:
            bad.append(('literal', left.decode('utf-8', 'replace')))
if bad:
    print(f'   !! residual: {len(bad)} rule(s) still matched')
    for kind, item in bad:
        print(f'      [{kind}] {item}')
    sys.exit(1)
print('   ok no residual for any rule')
PY

# 作者身份
BADMAIL=$(g log --all --format='%ae%n%ce' | sort -u | grep -v -e '@users.noreply.github.com' -e 'agent@' || true)
if [ -n "$BADMAIL" ]; then echo "   !! 提交头仍有非预期邮箱:"; printf '%s\n' "$BADMAIL"; FAIL=1; else echo "   ok 提交头邮箱已归一"; fi
BADNAME=$(g log --all --format='%an%n%cn' | sort -u | grep -x -- "$OWNER_FROM" || true)
if [ -n "$BADNAME" ]; then echo "   !! 作者名仍有 $OWNER_FROM"; FAIL=1; else echo "   ok 作者名已归一"; fi

echo ">> 快照提交数: $(g rev-list --all --count)（源 $(git -C "$SRC_REPO_NAT" rev-list --all --count)）"
echo ">> 快照标签数: $(g tag | wc -l)"

if [ "$FAIL" != "0" ]; then
  if [ "${SNAPSHOT_KEEP:-0}" = "1" ]; then trap - EXIT; echo ">> 快照保留在 $SNAP"; fi
  echo ">> 校验失败，拒绝推送" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo ">> DRY RUN：重写与校验通过，未推送。"
  g log --oneline -3
  if [ "${SNAPSHOT_KEEP:-0}" = "1" ]; then trap - EXIT; echo ">> 快照保留在 $SNAP"; fi
  exit 0
fi

# ---------- 推送（只推指定分支 + 标签）----------
PUSH_URL="$(printf '%s' "$SNAPSHOT_REPO_URL" | sed "s#^https://#https://${SNAPSHOT_TOKEN}@#")"
echo ">> 推送 $BRANCH ..."
g push --force --quiet "$PUSH_URL" "refs/heads/$BRANCH:refs/heads/$BRANCH"
if [ "$PUSH_TAGS" = "1" ]; then
  echo ">> 推送标签 ..."
  g push --force --quiet "$PUSH_URL" 'refs/tags/*:refs/tags/*'
fi
# ---------- 发布同步：按 CHANGELOG 段落建公开仓库 Release ----------
# 正文来源是快照内（已脱敏）的 CHANGELOG.md，与 Gitea 侧 release.yml 同一约定，
# 因此不需要调 Gitea API、也不需要额外凭据（复用推送用的那把 PAT）。
# 幂等：正文一致就不动，缺了才建、变了才改。
if [ "$SYNC_RELEASES" = "1" ] && { [ "$DRY_RUN" != "1" ] || [ -n "${SNAPSHOT_TOKEN:-}" ]; }; then
  GH_API_BASE=""
  case "$PUBLIC_BASE" in
    https://github.com/*) GH_API_BASE="https://api.github.com/repos/${PUBLIC_BASE#https://github.com/}" ;;
  esac
  if [ -z "$GH_API_BASE" ]; then
    echo ">> 跳过发布同步：目标不是 github.com（当前 ${PUBLIC_BASE:-<未设置>}）" >&2
  else
    echo ">> 同步发布（CHANGELOG 段落 → Release）..."
    GH_API_BASE="$GH_API_BASE" GH_TOKEN="${SNAPSHOT_TOKEN:-}" SNAP_REPO="$(nat "$SNAP")" \
      GH_DRY_RUN="$DRY_RUN" python - <<'PY'
import json, os, re, subprocess, time, urllib.error, urllib.request

api = os.environ['GH_API_BASE'].rstrip('/')
token = os.environ.get('GH_TOKEN', '')
snap = os.environ['SNAP_REPO']
dry = os.environ.get('GH_DRY_RUN') == '1'


def git(*args):
    return subprocess.run(['git', '-C', snap, *args], capture_output=True, check=True).stdout


CHANGELOG = git('show', 'HEAD:CHANGELOG.md').decode('utf-8', 'replace')


def changelog_section(tag):
    """取当前 CHANGELOG.md 里 '## <tag>' 到下一个 '## ' 之间的段落。

    刻意读 HEAD 而不是 '<tag>:CHANGELOG.md'：早期标签当时仓库根还没有这份文件
    （根 CHANGELOG 是后来才加的），只有当前这份才覆盖全部 77 个版本段落。
    """
    want = re.compile(r'^## ' + re.escape(tag) + r'(?![0-9.])')
    out, found = [], False
    for line in CHANGELOG.splitlines():
        if line.startswith('## '):
            if found:
                break
            if want.match(line):
                found = True
        if found:
            out.append(line)
    return '\n'.join(out).strip()


def call(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'engram-public-mirror')
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, {}


tags = [t.decode() for t in git('tag', '--list', 'v*').splitlines() if t.strip()]
created = updated = unchanged = skipped = failed = 0
for tag in tags:
    body = changelog_section(tag)
    if not body:
        print(f'   skip {tag}（CHANGELOG 无对应段落）')
        skipped += 1
        continue
    status, rel = call('GET', f'{api}/releases/tags/{tag}')
    if status == 200:
        if rel.get('body', '').strip() == body:
            unchanged += 1
            continue
        if dry:
            print(f'   would update {tag}')
            updated += 1
            continue
        st, _ = call('PATCH', f"{api}/releases/{rel['id']}", {'body': body})
        if st == 200:
            updated += 1
        else:
            print(f'   !! update {tag} HTTP {st}')
            failed += 1
    elif status == 404:
        if dry:
            print(f'   would create {tag}')
            created += 1
            continue
        st, _ = call('POST', f'{api}/releases', {
            'tag_name': tag, 'name': tag, 'body': body,
            'draft': False, 'prerelease': False,
        })
        if st in (200, 201):
            created += 1
        else:
            print(f'   !! create {tag} HTTP {st}')
            failed += 1
    else:
        print(f'   !! {tag} 查询失败 HTTP {status}')
        failed += 1
    time.sleep(0.2)

print(f'>> 发布同步：新建 {created}，更新 {updated}，未变 {unchanged}，跳过 {skipped}，失败 {failed}')
if failed:
    raise SystemExit(1)
PY
  fi
fi
echo ">> 完成。"
