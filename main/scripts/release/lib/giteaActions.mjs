// Gitea Actions API 客户端（只读）：运行列表、job/steps、job 日志与 Release 附件。
// 凭据优先环境变量 GITEA_TOKEN，其次 git credential fill（与 git push 同一套凭据），
// 页面永远拿不到凭据；所有请求在本地服务端完成。
import { execFileSync } from 'node:child_process';

/**
 * 解析仓库远端地址，得到 Gitea 根地址与 owner/repo。
 * @param {string} remoteUrl 形如 https://host:port/owner/repo.git 或 git@host:owner/repo.git
 * @returns {{host: string, giteaUrl: string, owner: string, repo: string}|null}
 */
export function parseRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  try {
    if (/^[a-z+]+:\/\//i.test(raw)) {
      const url = new URL(raw);
      const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const repo = parts[parts.length - 1].replace(/\.git$/i, '');
      const owner = parts[parts.length - 2];
      return {
        host: url.host,
        giteaUrl: `${url.protocol}//${url.host}`,
        owner,
        repo,
      };
    }
    // scp 风格：git@host:owner/repo.git
    const match = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(raw);
    if (match) {
      const parts = match[2].replace(/^\/+/, '').split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const repo = parts[parts.length - 1].replace(/\.git$/i, '');
      const owner = parts[parts.length - 2];
      return { host: match[1], giteaUrl: `https://${match[1]}`, owner, repo };
    }
  } catch {
    return null;
  }
  return null;
}

/** 生成请求头；无凭据时返回空对象。 */
export function authHeaders(auth) {
  if (!auth) return {};
  if (auth.kind === 'token' && auth.token) return { Authorization: `token ${auth.token}` };
  if (auth.kind === 'basic' && auth.username && auth.password) {
    return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
  }
  return {};
}

/**
 * 从 git credential fill 取凭据；取不到返回 null。
 * @param {string} host 含端口的主机名
 * @param {typeof execFileSync} exec
 */
export function credentialFromHelper(host, exec = execFileSync) {
  try {
    const out = exec('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const pairs = Object.fromEntries(
      String(out || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (pairs.username && pairs.password) {
      return { kind: 'basic', username: pairs.username, password: pairs.password };
    }
  } catch {
    /* 没有可用凭据 */
  }
  return null;
}

/**
 * 合并凭据：GITEA_TOKEN > git credential helper > 远端 URL 里内嵌的用户名密码。
 * @param {{host: string, env?: NodeJS.ProcessEnv, exec?: typeof execFileSync, embedded?: {username: string, password: string}|null}} options
 */
export function resolveAuth({ host, env = process.env, exec = execFileSync, embedded = null }) {
  if (env.GITEA_TOKEN) return { kind: 'token', token: env.GITEA_TOKEN };
  const fromHelper = credentialFromHelper(host, exec);
  if (fromHelper) return fromHelper;
  if (embedded?.username && embedded?.password) {
    return { kind: 'basic', username: embedded.username, password: embedded.password };
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 创建只读客户端。
 * @param {{baseUrl: string, owner: string, repo: string, auth: object|null, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createActionsClient({
  baseUrl,
  owner,
  repo,
  auth,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const root = `${String(baseUrl).replace(/\/+$/, '')}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function request(pathname, { asText = false, accept = 'application/json' } = {}) {
    const url = `${root}${pathname}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: accept, ...authHeaders(auth) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (asText) {
      const text = await response.text();
      return { status: response.status, ok: response.ok, text };
    }
    let data = null;
    let parseError = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        parseError = err;
      }
    }
    return { status: response.status, ok: response.ok, data, text, parseError };
  }

  return {
    authKind: auth ? auth.kind : 'anonymous',
    baseUrl: root,

    /** 最近的运行列表（默认 30 条）。 */
    listRuns(limit = 30) {
      return request(`/actions/runs?limit=${encodeURIComponent(String(limit))}`);
    },

    getRun(runId) {
      return request(`/actions/runs/${encodeURIComponent(String(runId))}`);
    },

    /** 一次运行下的 job（含 steps 与时间戳）。 */
    listJobs(runId) {
      return request(`/actions/runs/${encodeURIComponent(String(runId))}/jobs`);
    },

    /** 单个 job 的完整日志（纯文本）。 */
    getJobLogs(jobId) {
      return request(`/actions/jobs/${encodeURIComponent(String(jobId))}/logs`, {
        asText: true,
        accept: 'text/plain',
      });
    },

    /** 标签对应的 Release；404 返回 null。 */
    async getReleaseByTag(tag) {
      const result = await request(`/releases/tags/${encodeURIComponent(String(tag))}`);
      if (result.status === 404) return { ...result, data: null };
      return result;
    },
  };
}

/** 把 Release 响应收拢成看板需要的字段。 */
export function summarizeRelease(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    tag: data.tag_name || null,
    name: data.name || null,
    htmlUrl: data.html_url || null,
    publishedAt: data.published_at || null,
    assets: (Array.isArray(data.assets) ? data.assets : []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      downloadCount: asset.download_count ?? null,
      updatedAt: asset.updated_at || null,
      browserDownloadUrl: asset.browser_download_url || null,
    })),
  };
}
