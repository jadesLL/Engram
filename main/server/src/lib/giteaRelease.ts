/**
 * 远端仓库（Gitea 兼容）Releases API 客户端：查最新 Release（版本检测 + 桌面端 exe 附件来源）。
 * 公开仓库无需凭据；私有仓库支持两种凭据：访问令牌 或 用户名密码（Basic Auth）。
 */

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface LatestRelease {
  tag: string;
  version: string | null;
  assets: ReleaseAsset[];
}

/** 远端仓库访问凭据：token（访问令牌）或 password（用户名密码）二选一 */
export interface RepoAuth {
  type: 'token' | 'password';
  token?: string;
  username?: string;
  password?: string;
}

/** 按凭据方式生成 Authorization 头；无凭据返回空（匿名访问公开仓库） */
export function repoAuthHeaders(auth?: RepoAuth): Record<string, string> {
  if (!auth) return {};
  if (auth.type === 'password' && auth.username && auth.password) {
    return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
  }
  if (auth.token) return { Authorization: `token ${auth.token}` };
  return {};
}

function normalizeVersion(tag: string): string | null {
  const m = tag.match(/v?(\d+(\.\d+)*)/i);
  return m ? m[1] : null;
}

/** 最新 Release 的 API 地址（直连与宿主机网络探针共用） */
export function latestReleaseUrl(giteaUrl: string, repo: string): string {
  return `${giteaUrl.replace(/\/+$/, '')}/api/v1/repos/${repo}/releases/latest`;
}

/** 解析 Releases API 响应；404（尚无 Release 或无权限）返回 null */
export function parseLatestReleaseResponse(status: number, body: string): LatestRelease | null {
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    let detail = '';
    try {
      detail = (JSON.parse(body) as { message?: string }).message || '';
    } catch {
      /* body 非 JSON */
    }
    throw new Error(`仓库 API ${status}${detail ? `: ${detail}` : ''}`);
  }
  const data = JSON.parse(body) as {
    tag_name?: string;
    assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
  };
  const tag = data.tag_name || '';
  return {
    tag,
    version: normalizeVersion(tag),
    assets: (data.assets || [])
      .filter((a) => a.browser_download_url)
      .map((a) => ({ name: a.name || '', url: a.browser_download_url!, size: a.size || 0 })),
  };
}

/** 拉最新 Release（容器内直连）；404（尚无 Release 或无权限）返回 null */
export async function fetchLatestRelease(
  giteaUrl: string,
  repo: string,
  auth?: RepoAuth,
): Promise<LatestRelease | null> {
  const res = await fetch(latestReleaseUrl(giteaUrl, repo), {
    headers: repoAuthHeaders(auth),
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  return parseLatestReleaseResponse(res.status, await res.text());
}
