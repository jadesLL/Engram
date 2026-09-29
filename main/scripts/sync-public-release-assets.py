#!/usr/bin/env python3
"""把发版产物同步到公开仓库（GitHub）的 Release —— 公开下载入口。

私有仓库仍是发布源头（镜像 + Release 正文 + 附件），本脚本只是把**已构建好的产物**
复制一份到公开仓库，让外部用户能直接下载 exe/APK/sha256，不必访问私有 Gitea。

两种模式：
  upload    把本地产物目录里的文件传到 <tag> 对应的公开仓库 Release（发版 dispatch 用）
  backfill  从 Gitea Release 拉取已有附件，补传到公开仓库同名 Release（历史版本回填）

设计要点：
  * 幂等：同名附件已存在且大小一致就跳过；大小不同才删旧重传。
  * 不碰 Release 正文：正文由 public-mirror 用**已脱敏的 CHANGELOG** 填写，
    本脚本只在 Release 不存在时建一个空正文的壳，绝不把私有 CHANGELOG 正文带过去。
  * 流式上传/下载：exe 约 170MB，不整块读进内存。
  * 目标不是 github.com 时直接跳过（返回 0），与 make-public-snapshot.sh 的判定一致。

环境变量：
  PUBLIC_REPO_URL   公开仓库地址（CI: vars.PUBLIC_MIRROR_REPO_URL，形如 https://github.com/<账号>/Engram.git）
  PUBLIC_TOKEN      公开仓库写权限 token（CI: secrets.PUBLIC_MIRROR_TOKEN）
  GITEA_API_URL     Gitea 基地址（backfill 用；CI 里可传 $GITHUB_SERVER_URL）
  GITEA_REPO        owner/repo（backfill 用；CI 里可传 $GITHUB_REPOSITORY）
  GITEA_TOKEN       Gitea token（backfill 下载附件用；CI: secrets.RELEASE_TOKEN）
  SYNC_DRY_RUN=1    只打印计划，不发任何写请求
"""
import argparse
import http.client
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = 'engram-public-release-assets'
CHUNK = 1024 * 1024


class SyncError(Exception):
    pass


def log(msg):
    print(msg, flush=True)


def dry_run():
    return os.environ.get('SYNC_DRY_RUN') == '1'


def http_call(method, url, token='', payload=None, timeout=120, accept='application/vnd.github+json'):
    """发一次 JSON 请求，返回 (status, dict)。404 等错误状态由调用方判断。"""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Accept', accept)
    req.add_header('User-Agent', USER_AGENT)
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        return e.code, {'_error': detail}
    except urllib.error.URLError as e:
        raise SyncError(f'{method} {url} 网络失败：{e.reason}')


def github_target():
    """解析 PUBLIC_REPO_URL；非 github.com 返回 None（调用方跳过）。"""
    url = (os.environ.get('PUBLIC_REPO_URL') or '').strip()
    if not url:
        raise SyncError('缺少 PUBLIC_REPO_URL')
    url = url[:-4] if url.endswith('.git') else url
    parsed = urllib.parse.urlsplit(url)
    if parsed.netloc.lower() != 'github.com':
        return None
    path = parsed.path.strip('/')
    parts = path.split('/')
    if len(parts) < 2 or not all(parts[:2]):
        raise SyncError(f'无法从 PUBLIC_REPO_URL 解析 owner/repo：{url}')
    owner, repo = parts[0], parts[1]
    # SYNC_GH_API_BASE / SYNC_GH_UPLOAD_BASE 仅用于本地 mock 验证（GitHub 侧真实地址是默认值）
    api_base = (os.environ.get('SYNC_GH_API_BASE') or 'https://api.github.com').rstrip('/')
    up_base = (os.environ.get('SYNC_GH_UPLOAD_BASE') or 'https://uploads.github.com').rstrip('/')
    return {
        'full_name': f'{owner}/{repo}',
        'api': f'{api_base}/repos/{owner}/{repo}',
        'uploads': f'{up_base}/repos/{owner}/{repo}',
    }


def ensure_release(target, token, tag):
    """取 <tag> 的 Release；不存在就建一个**空正文**的壳（正文归 public-mirror 管）。"""
    status, rel = http_call('GET', f"{target['api']}/releases/tags/{urllib.parse.quote(tag)}", token)
    if status == 200:
        return rel
    if status != 404:
        raise SyncError(f'查询 Release {tag} 失败：HTTP {status} {rel.get("_error", "")}')
    if dry_run():
        log(f'  [dry-run] 将创建 Release {tag}')
        return {'id': None, 'tag_name': tag, 'assets': []}
    status, rel = http_call('POST', f"{target['api']}/releases", token, {
        'tag_name': tag,
        'name': tag,
        'draft': False,
        'prerelease': False,
    })
    if status not in (200, 201):
        raise SyncError(f'创建 Release {tag} 失败：HTTP {status} {rel.get("_error", "")}')
    log(f'  已创建 Release {tag}（正文留空，由 public-mirror 用脱敏 CHANGELOG 填写）')
    return rel


def upload_file(target, token, rel, path, name=None):
    """流式上传单个附件（同名先删）。name 用于回填时还原 Gitea 侧的附件名（本地临时文件名带前缀）。"""
    name = name or os.path.basename(path)
    size = os.path.getsize(path)
    upload_url = rel.get('upload_url') or f"{target['uploads']}/releases/{rel['id']}/assets{{?name,label}}"
    upload_url = upload_url.split('{')[0]
    url = f'{upload_url}?name={urllib.parse.quote(name)}'

    if dry_run():
        log(f'  [dry-run] 将上传 {name}（{size:,} 字节）')
        return

    parsed = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    conn = conn_cls(parsed.netloc, timeout=1800)
    try:
        conn.putrequest('POST', parsed.path + ('?' + parsed.query if parsed.query else ''))
        conn.putheader('Authorization', f'Bearer {token}')
        conn.putheader('Accept', 'application/vnd.github+json')
        conn.putheader('User-Agent', USER_AGENT)
        conn.putheader('Content-Type', 'application/octet-stream')
        conn.putheader('Content-Length', str(size))
        conn.endheaders()
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                conn.send(chunk)
        resp = conn.getresponse()
        body = resp.read().decode('utf-8', 'replace')
        if resp.status not in (200, 201):
            raise SyncError(f'上传 {name} 失败：HTTP {resp.status} {body[:300]}')
        log(f'  已上传 {name}（{size:,} 字节）')
    finally:
        conn.close()


def delete_asset(target, token, asset_id):
    if dry_run():
        log(f'  [dry-run] 将删除同名旧附件 id={asset_id}')
        return
    status, resp = http_call('DELETE', f"{target['api']}/releases/assets/{asset_id}", token)
    if status not in (204, 200):
        raise SyncError(f'删除旧附件 id={asset_id} 失败：HTTP {status} {resp.get("_error", "")}')


def existing_assets(rel):
    return {a['name']: a for a in (rel.get('assets') or [])}


def sync_one(target, token, rel, path, stats):
    """按「同名 + 同大小」判重，传一个文件。"""
    name = os.path.basename(path)
    size = os.path.getsize(path)
    assets = existing_assets(rel)
    old = assets.get(name)
    if old and int(old.get('size', -1)) == size:
        log(f'  跳过 {name}（已存在且大小一致）')
        stats['skipped'] += 1
        return
    if old:
        delete_asset(target, token, old['id'])
    upload_file(target, token, rel, path)
    stats['uploaded'] += 1


def download(url, token, dst):
    req = urllib.request.Request(url)
    if token:
        req.add_header('Authorization', f'token {token}')
    req.add_header('User-Agent', USER_AGENT)
    with urllib.request.urlopen(req, timeout=1800) as r, open(dst, 'wb') as f:
        shutil.copyfileobj(r, f, CHUNK)


def gitea_releases():
    base = (os.environ.get('GITEA_API_URL') or '').rstrip('/')
    repo = (os.environ.get('GITEA_REPO') or '').strip('/')
    token = os.environ.get('GITEA_TOKEN') or ''
    if not base or not repo:
        raise SyncError('backfill 需要 GITEA_API_URL 与 GITEA_REPO')
    out, page = [], 1
    while True:
        url = f'{base}/api/v1/repos/{repo}/releases?limit=50&page={page}'
        status, data = http_call('GET', url, token)
        if status != 200:
            raise SyncError(f'Gitea Release 列表查询失败：HTTP {status} {data.get("_error", "")}')
        if not data:
            break
        out.extend(data)
        if len(data) < 50:
            break
        page += 1
    return [r for r in out if not r.get('draft')]


def parse_versions(raw):
    items = [v.strip() for v in (raw or '').split(',') if v.strip()]
    if not items:
        raise SyncError('--versions 需要版本号列表（如 1.3.1,1.3.2）或 all')
    return items


def tag_of(version):
    return version if version.startswith('v') else f'v{version}'


def mode_upload(target, token, args):
    if not os.path.isdir(args.dir):
        raise SyncError(f'产物目录不存在：{args.dir}')
    files = sorted(
        (os.path.join(args.dir, f) for f in os.listdir(args.dir)),
        key=lambda p: os.path.getsize(p),
    )
    files = [p for p in files if os.path.isfile(p)]
    if not files:
        raise SyncError(f'产物目录为空：{args.dir}')
    log(f'>> 上传 {len(files)} 个文件到 {target["full_name"]} 的 Release {args.tag}')
    for p in files:
        log(f'  - {os.path.basename(p)}（{os.path.getsize(p):,} 字节）')
    rel = ensure_release(target, token, args.tag)
    stats = {'uploaded': 0, 'skipped': 0}
    for p in files:
        sync_one(target, token, rel, p, stats)
    log(f'>> 完成：上传 {stats["uploaded"]}，跳过 {stats["skipped"]}')
    return stats


def mode_backfill(target, token, args):
    wanted = parse_versions(args.versions)
    releases = gitea_releases()
    picked = []
    for rel in releases:
        tag = rel.get('tag_name') or ''
        if not tag.startswith('v'):
            continue
        if 'all' not in wanted and tag not in {tag_of(v) for v in wanted}:
            continue
        assets = [a for a in (rel.get('assets') or []) if a.get('name')]
        if not assets:
            continue
        picked.append((tag, assets))
    if not picked:
        log('>> 没有可回填的版本（Gitea 侧这些版本没有附件）')
        return {'uploaded': 0, 'skipped': 0, 'versions': 0}
    log(f'>> 回填 {len(picked)} 个版本到 {target["full_name"]}：{", ".join(t for t, _ in picked)}')
    stats = {'uploaded': 0, 'skipped': 0, 'versions': 0}
    for tag, assets in picked:
        log(f'-- {tag}（{len(assets)} 个附件）')
        rel = ensure_release(target, token, tag)
        for asset in assets:
            name, size = asset['name'], int(asset.get('size') or 0)
            have = existing_assets(rel).get(name)
            if have and int(have.get('size', -1)) == size:
                log(f'  跳过 {name}（已存在且大小一致）')
                stats['skipped'] += 1
                continue
            if have:
                delete_asset(target, token, have['id'])
            if dry_run():
                log(f'  [dry-run] 将从 Gitea 下载并上传 {name}（{size:,} 字节）')
                stats['uploaded'] += 1
                continue
            tmp = os.path.join(tempfile.gettempdir(), f'engram-sync-{int(time.time())}-{name}')
            try:
                log(f'  下载 {name}（{size:,} 字节）…')
                download(asset.get('browser_download_url') or asset['url'], os.environ.get('GITEA_TOKEN') or '', tmp)
                upload_file(target, token, rel, tmp, name=name)
                stats['uploaded'] += 1
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        stats['versions'] += 1
    log(f'>> 完成：版本 {stats["versions"]}，上传 {stats["uploaded"]}，跳过 {stats["skipped"]}')
    return stats


def main():
    ap = argparse.ArgumentParser(description='同步发版产物到公开仓库 Release')
    sub = ap.add_subparsers(dest='mode', required=True)
    up = sub.add_parser('upload', help='上传本地产物到公开仓库 Release')
    up.add_argument('--tag', required=True, help='发版标签，如 v1.3.4')
    up.add_argument('--dir', required=True, help='产物目录，如 release-out')
    bf = sub.add_parser('backfill', help='从 Gitea Release 回填历史附件')
    bf.add_argument('--versions', required=True, help='版本号列表（1.3.1,1.3.2）或 all')
    args = ap.parse_args()

    target = github_target()
    if target is None:
        log('>> 跳过：PUBLIC_REPO_URL 指向的不是 github.com')
        return 0
    token = os.environ.get('PUBLIC_TOKEN') or ''
    if not token and not dry_run():
        raise SyncError('缺少 PUBLIC_TOKEN（公开仓库写权限 token）')

    log(f'>> 目标仓库 {target["full_name"]}；模式 {args.mode}；dry-run={dry_run()}')
    if args.mode == 'upload':
        mode_upload(target, token, args)
    else:
        mode_backfill(target, token, args)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SyncError as e:
        log(f'!! {e}')
        sys.exit(1)
