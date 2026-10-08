#!/usr/bin/env python3
"""把快照仓库里（已脱敏）的 CHANGELOG 段落同步成公开仓库（GitHub）的 Release 正文。

为什么单独成脚本（2026-10-08 实测）：
  mirror 任务原先把这段逻辑内联在 make-public-snapshot.sh 结尾，任何一次网络抖动都会让整个
  镜像任务变红 —— 而那一刻「代码/标签推送」其实已经成功，公开仓库的代码是最新的。失败长这样：

      >> 推送 main ...
      >> 推送标签 ...
      >> 同步发布（CHANGELOG 段落 → Release）...
      ssl.SSLEOFError: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol
      urllib.error.URLError: <urlopen error ...>
      ##[error]Process completed with exit code 1.

  根因是两条叠加：
    ① 61 个版本标签 = 61 次 urllib.urlopen = 61 次新建 TLS 握手（不复用连接）；
       国内到 api.github.com 的通路本就时通时断，61 次里断 1 次就整体失败；
    ② 只处理了 HTTPError（4xx/5xx），URLError / 超时没有兜底，直接抛到顶层。
  实测最近 7 次 main 推送里 mirror 挂了 4 次，与提交内容无关。

现在的口径：
  * 一条 keep-alive 连接反复用（61 次握手 → 1~2 次），断线/超时/5xx/429 有限重试 + 指数退避；
  * 单个标签最终失败只计入「待补」清单，不再抛异常；连续失败达到阈值就提前收工，
    不把「61 个标签 × 重试 × 退避」的时间全耗光；
  * 退出码由 RELEASE_SYNC_FATAL 决定：1（默认，本地/手动）= 有失败即非零；
    0（CI 的 mirror 任务）= 只打告警并返回 0 —— 镜像任务成败只由「代码/标签推送」决定；
  * 幂等：正文一致就不动，缺了才建、变了才改；下一次成功运行会把待补的补齐。

环境变量：
  SNAP_REPO            快照仓库路径（git 仓，默认当前目录）
  GH_API_BASE          目标 API 基址，如 https://api.github.com/repos/me/Engram
  GH_TOKEN             写入令牌
  GH_DRY_RUN           1 = 只查询与打印，不建/不改
  RELEASE_SYNC_FATAL   1/0，默认 1
  RELEASE_SYNC_RETRIES 单次请求最大尝试次数，默认 3
  RELEASE_SYNC_TIMEOUT 单次请求超时秒数，默认 30
  RELEASE_SYNC_BACKOFF 退避基数秒，默认 0.5
  RELEASE_SYNC_GIVE_UP_AFTER 连续失败多少个标签就停止本轮，默认 3

用法（main/ 下）：
  python scripts/public-release-sync.py                # 同步（需 SNAP_REPO/GH_API_BASE/GH_TOKEN）
  python scripts/public-release-sync.py --self-test    # 离线桩测试：不需要网络与令牌
"""

import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse

# Windows 的默认控制台编码是 GBK，中文与 ✓/✗ 直接打印会 UnicodeEncodeError；
# CI runner 与本地都统一按 UTF-8 输出（日志能读、自检不因编码挂掉）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

REQUIRED_FAIL_NOTE = '（脚本幂等，下一次成功运行会补齐）'


def config_from_env(env=None):
    env = os.environ if env is None else env
    return {
        'snap': env.get('SNAP_REPO') or '.',
        'api_base': (env.get('GH_API_BASE') or '').rstrip('/'),
        'token': env.get('GH_TOKEN') or '',
        'dry_run': env.get('GH_DRY_RUN') == '1',
        'fatal': env.get('RELEASE_SYNC_FATAL', '1') != '0',
        'retries': int(env.get('RELEASE_SYNC_RETRIES', '3')),
        'timeout': float(env.get('RELEASE_SYNC_TIMEOUT', '30')),
        'backoff': float(env.get('RELEASE_SYNC_BACKOFF', '0.5')),
        'give_up_after': int(env.get('RELEASE_SYNC_GIVE_UP_AFTER', '3')),
    }


class ApiUnreachable(Exception):
    """重试耗尽后仍拿不到响应（连接被掐、超时等）。"""


class _Retryable(Exception):
    """可重试的响应（5xx / 429）。"""


class ApiClient:
    """一条 keep-alive 连接反复用；断线/超时/5xx/429 退避重试后再放弃。"""

    def __init__(self, api_base, token='', retries=3, timeout=30.0, backoff=0.5):
        parsed = urllib.parse.urlsplit(api_base)
        if not parsed.hostname:
            raise ValueError(f'GH_API_BASE 不是合法地址：{api_base!r}')
        self.scheme = parsed.scheme or 'https'
        self.host = parsed.hostname
        self.port = parsed.port
        self.prefix = parsed.path.rstrip('/')
        self.token = token
        self.retries = max(1, int(retries))
        self.timeout = timeout
        self.backoff = max(0.0, backoff)
        self._conn = None
        self.requests = 0      # 发出的请求数
        self.connections = 0   # 新建连接数（自检用它证明复用生效）
        self.retry_count = 0   # 发生过多少次重试

    # ---- 连接管理 ----
    def _connect(self):
        if self._conn is not None:
            return
        if self.scheme == 'https':
            self._conn = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout)
        else:
            self._conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        self.connections += 1

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001 - 关闭失败不影响后续重建
                pass
            self._conn = None

    # ---- 单次请求（含重试）----
    def request(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'engram-public-mirror',
        }
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        if body is not None:
            headers['Content-Type'] = 'application/json'

        attempt = 0
        while True:
            attempt += 1
            try:
                self._connect()
                self.requests += 1
                self._conn.request(method, self.prefix + path, body=body, headers=headers)
                resp = self._conn.getresponse()
                data = resp.read()
                status = resp.status
                if status >= 500 or status == 429:
                    raise _Retryable(f'HTTP {status}')
                try:
                    return status, json.loads(data.decode() or '{}')
                except ValueError:
                    return status, {}
            except (
                _Retryable,
                http.client.HTTPException,
                socket.timeout,
                TimeoutError,
                ssl.SSLError,
                OSError,
            ) as e:
                self.close()  # 断线后必须重建连接，不能接着用
                if attempt >= self.retries:
                    raise ApiUnreachable(f'{type(e).__name__}: {e}') from e
                self.retry_count += 1
                if self.backoff:
                    time.sleep(self.backoff * (2 ** (attempt - 1)))


def _git(snap, *args):
    return subprocess.run(['git', '-C', snap, *args], capture_output=True, check=True).stdout


def changelog_section(changelog, tag):
    """取当前 CHANGELOG.md 里 '## <tag>' 到下一个 '## ' 之间的段落。

    刻意读 HEAD 而不是 '<tag>:CHANGELOG.md'：早期标签当时仓库根还没有这份文件
    （根 CHANGELOG 是后来才加的），只有当前这份才覆盖全部版本段落。
    """
    want = re.compile(r'^## ' + re.escape(tag) + r'(?![0-9.])')
    out, found = [], False
    for line in changelog.splitlines():
        if line.startswith('## '):
            if found:
                break
            if want.match(line):
                found = True
        if found:
            out.append(line)
    return '\n'.join(out).strip()


def sync(cfg, client=None):
    """按 CHANGELOG 段落同步 Release 正文；返回汇总字典（退出码由调用方决定）。"""
    summary = {
        'created': 0, 'updated': 0, 'unchanged': 0, 'skipped': 0,
        'pending': [], 'requests': 0, 'connections': 0, 'retries': 0,
        'no_target': False,
    }
    if not cfg.get('api_base'):
        print('>> 跳过发布同步：未设置 GH_API_BASE', file=sys.stderr)
        summary['no_target'] = True
        return summary

    snap = cfg['snap']
    changelog = _git(snap, 'show', 'HEAD:CHANGELOG.md').decode('utf-8', 'replace')
    tags = [t.decode() for t in _git(snap, 'tag', '--list', 'v*').splitlines() if t.strip()]
    client = client or ApiClient(
        cfg['api_base'], token=cfg.get('token', ''),
        retries=cfg.get('retries', 3), timeout=cfg.get('timeout', 30.0),
        backoff=cfg.get('backoff', 0.5),
    )
    dry = bool(cfg.get('dry_run'))
    give_up_after = max(1, int(cfg.get('give_up_after', 3)))

    targets = [(tag, changelog_section(changelog, tag)) for tag in tags]
    for tag, body in targets:
        if not body:
            print(f'   skip {tag}（CHANGELOG 无对应段落）')
            summary['skipped'] += 1

    consecutive_failures = 0
    sectioned = [(tag, body) for tag, body in targets if body]
    for index, (tag, body) in enumerate(sectioned):
        try:
            status, rel = client.request('GET', f'/releases/tags/{tag}')
        except ApiUnreachable as e:
            consecutive_failures += 1
            summary['pending'].append((tag, str(e)))
            print(f'   !! {tag} 查询失败（网络）：{e}')
            if consecutive_failures >= give_up_after:
                rest = [t for t, _ in sectioned[index + 1:]]
                summary['pending'].extend((t, '本轮网络不可达，未尝试') for t in rest)
                print(f'   !! 连续 {consecutive_failures} 个标签网络失败，本轮提前收工，'
                      f'剩余 {len(rest)} 个标签留待下次')
                break
            continue
        consecutive_failures = 0

        if status == 200:
            if (rel.get('body') or '').strip() == body:
                summary['unchanged'] += 1
                continue
            if dry:
                print(f'   would update {tag}')
                summary['updated'] += 1
                continue
            try:
                st, _ = client.request('PATCH', f"/releases/{rel['id']}", {'body': body})
            except ApiUnreachable as e:
                summary['pending'].append((tag, f'更新失败（网络）：{e}'))
                print(f'   !! update {tag} {e}')
                continue
            if st == 200:
                summary['updated'] += 1
            else:
                summary['pending'].append((tag, f'HTTP {st}'))
                print(f'   !! update {tag} HTTP {st}')
        elif status == 404:
            if dry:
                print(f'   would create {tag}')
                summary['created'] += 1
                continue
            try:
                st, _ = client.request('POST', '/releases', {
                    'tag_name': tag, 'name': tag, 'body': body,
                    'draft': False, 'prerelease': False,
                })
            except ApiUnreachable as e:
                summary['pending'].append((tag, f'创建失败（网络）：{e}'))
                print(f'   !! create {tag} {e}')
                continue
            if st in (200, 201):
                summary['created'] += 1
            else:
                summary['pending'].append((tag, f'HTTP {st}'))
                print(f'   !! create {tag} HTTP {st}')
        else:
            summary['pending'].append((tag, f'HTTP {status}'))
            print(f'   !! {tag} 查询失败 HTTP {status}')

    summary['requests'] = client.requests
    summary['connections'] = client.connections
    summary['retries'] = client.retry_count
    client.close()

    pending = summary['pending']
    print(f'>> 发布同步：新建 {summary["created"]}，更新 {summary["updated"]}，'
          f'未变 {summary["unchanged"]}，跳过 {summary["skipped"]}，待补 {len(pending)}')
    print(f'>> 连接复用：{summary["connections"]} 条连接 / {summary["requests"]} 次请求'
          f'（重试 {summary["retries"]} 次）')
    if pending:
        names = ', '.join(t for t, _ in pending[:10])
        more = '…' if len(pending) > 10 else ''
        print(f'!! 待补 {len(pending)} 个标签的 Release 正文：{names}{more}{REQUIRED_FAIL_NOTE}')
        print(f'::warning::发布正文待补 {len(pending)} 个标签（{names}{more}）')
    return summary


def main(argv):
    if '--self-test' in argv:
        return run_self_test()
    cfg = config_from_env()
    summary = sync(cfg)
    if summary['no_target']:
        return 0
    if summary['pending'] and cfg['fatal']:
        return 1
    return 0


# --------------------------------------------------------------------------------------
# 离线自检：本地桩服务模拟「连接被掐」与正常响应，验证重试、连接复用、非致命语义。
# 不需要网络与令牌：python public-release-sync.py --self-test
# --------------------------------------------------------------------------------------
def run_self_test():  # pragma: no cover - 自检本身即测试代码
    import http.server
    import tempfile
    import threading

    checks = []

    def check(name, ok, detail=''):
        checks.append((name, bool(ok), detail))
        print(f'  {"✓" if ok else "✗"} {name}{"" if ok else f"  ({detail})"}')

    class StubHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        state = {}

        def log_message(self, *args):  # 静默
            pass

        def _cut(self):
            """模拟「响应/握手被掐」：不写任何数据就把连接关掉。"""
            self.state['cuts'] = self.state.get('cuts', 0) + 1
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        def _pre(self):
            """返回 True 表示本次请求已按「断连」处理完。"""
            self.state['requests'] = self.state.get('requests', 0) + 1
            if self.state.get('cut_next', 0) > 0:
                self.state['cut_next'] -= 1
                self._cut()
                return True
            if self.state.get('always_fail'):
                self._cut()
                return True
            return False

        def _json(self, status, payload=None):
            data = json.dumps(payload or {}).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            length = int(self.headers.get('Content-Length') or 0)
            return json.loads(self.rfile.read(length) or b'{}')

        def do_GET(self):
            if self._pre():
                return
            m = re.match(r'^/repos/x/y/releases/tags/(.+)$', self.path)
            if m and m.group(1) in self.state.get('existing', {}):
                return self._json(200, {'id': 7, 'body': self.state['existing'][m.group(1)]})
            return self._json(404, {'message': 'Not Found'})

        def do_POST(self):
            if self._pre():
                return
            payload = self._body()
            self.state.setdefault('existing', {})[payload.get('tag_name', '')] = payload.get('body', '')
            self.state['posts'] = self.state.get('posts', 0) + 1
            return self._json(201, {'id': 8})

        def do_PATCH(self):
            if self._pre():
                return
            payload = self._body()
            self.state['patches'] = self.state.get('patches', 0) + 1
            return self._json(200, {'id': 7, 'body': payload.get('body', '')})

    class StubServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

        def get_request(self):
            conn, addr = super().get_request()
            self.state['connections'] = self.state.get('connections', 0) + 1
            return conn, addr

    def serve():
        server = StubServer(('127.0.0.1', 0), StubHandler)
        server.state = {}
        StubHandler.state = server.state
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    SECTIONED = ['v9.8.%d' % i for i in range(1, 9)]   # 8 个有正文的标签
    NO_SECTION = 'v9.9.8'                              # 有标签但 CHANGELOG 没段落

    def make_snapshot():
        tmp = tempfile.mkdtemp(prefix='release-sync-selftest-')
        lines = ['# 变更记录', '']
        for tag in SECTIONED:
            lines += [f'## {tag}（2026-10-08）', '', f'正文 {tag}', '']
        lines += ['## v9.7.0（未发）', '', '没有对应标签的段落', '']
        with open(os.path.join(tmp, 'CHANGELOG.md'), 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines))
        env = {**os.environ, 'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@example.com',
               'GIT_COMMITTER_NAME': 'T', 'GIT_COMMITTER_EMAIL': 't@example.com'}
        subprocess.run(['git', 'init', '--quiet', tmp], check=True, env=env)
        subprocess.run(['git', '-C', tmp, 'add', 'CHANGELOG.md'], check=True, env=env)
        subprocess.run(['git', '-C', tmp, 'commit', '--quiet', '-m', 'init'], check=True, env=env)
        for tag in SECTIONED + [NO_SECTION]:
            subprocess.run(['git', '-C', tmp, 'tag', tag], check=True, env=env)
        return tmp

    def cfg_for(server, snap, **over):
        cfg = {
            'snap': snap,
            'api_base': f'http://127.0.0.1:{server.server_address[1]}/repos/x/y',
            'token': 'selftest',
            'dry_run': False,
            'fatal': False,
            'retries': 3,
            'timeout': 5.0,
            'backoff': 0.0,
            'give_up_after': 3,
        }
        cfg.update(over)
        return cfg

    snap = make_snapshot()

    # ① 抖动两次后恢复 → 重试生效，全部建成，无待补
    server = serve()
    server.state['cut_next'] = 2
    s = sync(cfg_for(server, snap))
    check('抖动两次后重试成功：8 个正文全部新建', s['created'] == 8, f"created={s['created']} pending={s['pending']}")
    check('无待补', s['pending'] == [], str(s['pending']))
    check('重试被记账', s['retries'] >= 2, f"retries={s['retries']}")
    check('没段落的标签只跳过、不建 Release',
          s['skipped'] == 1 and NO_SECTION not in server.state.get('existing', {}),
          f"skipped={s['skipped']} existing={sorted(server.state.get('existing', {}))}")
    server.shutdown()

    # ② 健康网络下连接复用：8 次请求只该用 1 条连接；dry run 不发写请求
    server = serve()
    s = sync(cfg_for(server, snap, dry_run=True))
    check('dry run 不发写请求', server.state.get('posts', 0) == 0 and server.state.get('patches', 0) == 0,
          str(server.state))
    check('连接复用：8 次请求 1 条连接', s['connections'] == 1 and s['requests'] == 8,
          f"connections={s['connections']} requests={s['requests']}")
    server.shutdown()

    # ③ 幂等：正文一致时不动
    server = serve()
    changelog = open(os.path.join(snap, 'CHANGELOG.md'), encoding='utf-8').read()
    server.state['existing'] = {t: changelog_section(changelog, t) for t in SECTIONED}
    s = sync(cfg_for(server, snap))
    check('正文一致时不改（未变 8）', s['unchanged'] == 8 and s['updated'] == 0 and s['created'] == 0,
          f"unchanged={s['unchanged']} updated={s['updated']} created={s['created']}")
    server.shutdown()

    # ④ 网络整体不可达：提前收工、全部记待补、不抛异常
    server = serve()
    server.state['always_fail'] = True
    s = sync(cfg_for(server, snap))
    check('整体不可达时全部记待补（8 个）', len(s['pending']) == 8, str(s['pending']))
    check('连续失败提前收工：只试了 3 个标签 × 3 次重试',
          s['requests'] == 9, f"requests={s['requests']}")
    check('提前收工后剩余标签标成「未尝试」',
          sum(1 for _, why in s['pending'] if '未尝试' in why) == 5, str(s['pending']))
    server.shutdown()

    # ⑤ 真 CLI：RELEASE_SYNC_FATAL=0 → 0；=1 → 1
    server = serve()
    server.state['always_fail'] = True
    env = {
        **os.environ,
        'SNAP_REPO': snap,
        'GH_API_BASE': f'http://127.0.0.1:{server.server_address[1]}/repos/x/y',
        'GH_TOKEN': 'selftest',
        'RELEASE_SYNC_BACKOFF': '0',
        'RELEASE_SYNC_FATAL': '0',
    }
    rc_soft = subprocess.run([sys.executable, os.path.abspath(__file__)], env=env,
                             capture_output=True).returncode
    env['RELEASE_SYNC_FATAL'] = '1'
    rc_hard = subprocess.run([sys.executable, os.path.abspath(__file__)], env=env,
                             capture_output=True).returncode
    check('CLI RELEASE_SYNC_FATAL=0 → 退出码 0（只告警）', rc_soft == 0, f'rc={rc_soft}')
    check('CLI RELEASE_SYNC_FATAL=1 → 退出码 1（本地/手动语义不变）', rc_hard == 1, f'rc={rc_hard}')
    server.shutdown()

    # ⑥ 未设置目标（非 github.com 之类）→ 跳过并返回 0，不当作失败
    s = sync(cfg_for(server, snap, api_base=''))
    check('没有目标时跳过（no_target，不报错）', s['no_target'] is True and s['pending'] == [], str(s))

    failed = [name for name, ok, _ in checks if not ok]
    print(f'\n自检：{len(checks) - len(failed)}/{len(checks)} 通过')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
