// 仓库地址解析与校验（安装器 GUI 与单测共用）：
//   node installer/scripts/tests/repo-url.test.js
//
// 只接受 http/https：引擎会把凭据拼进 URL（https://user:pass@host/owner/repo.git）再克隆，
// ssh://、git://、file:// 这类地址拼不了凭据；实际场景是自建 Gitea / GitHub 的网页地址。
//
// 这里刻意不做「拒绝私网/环回地址」的限制：自建 Gitea 常跑在局域网或 NAS 上
// （如 http://192.168.1.101:3000/example/Engram.git），地址是本机用户在安装器里手输的、
// 请求也由本机发出，不存在服务端 SSRF 面；限制反而会把正当用法挡掉。
const DEFAULT_REPO_URL = 'https://github.com/jadesLL/Engram.git';

/** 解析并校验仓库地址；ok=false 时 message 可直接展示给用户 */
function normalizeRepoUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, message: '请填写仓库地址' };
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, message: '地址要以 http:// 或 https:// 开头（暂不支持 ssh/git 协议）' };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: '地址格式不对，例：https://github.com/owner/repo.git' };
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length < 2) {
    return { ok: false, message: '地址里要带 owner/repo，例：https://github.com/owner/repo.git' };
  }
  return {
    ok: true,
    url: raw,
    host: parsed.host,
    owner: segments[0],
    repo: segments[1].replace(/\.git$/i, ''),
    withCreds: Boolean(parsed.username || parsed.password),
  };
}

/** 打日志用：抹掉地址里内嵌的账号密码 */
function redactRepoUrl(url) {
  return String(url == null ? '' : url).replace(/\/\/[^/@\s]+@/, '//***@');
}

/** 从既有克隆的 .git/config 里读 origin 地址（重装时用它预填输入框） */
function readOriginFromGitConfig(configText) {
  const text = String(configText == null ? '' : configText);
  const remote = text.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
  if (!remote) return null;
  const url = remote[1].match(/^\s*url\s*=\s*(\S+)\s*$/m);
  return url ? url[1] : null;
}

module.exports = { DEFAULT_REPO_URL, normalizeRepoUrl, redactRepoUrl, readOriginFromGitConfig };
