/**
 * Gitea Releases API 客户端：查最新 Release（版本检测 + 桌面端 exe 附件来源）。
 * 公开仓库无需 token；私有仓库需带 package 读 + repository 读权限的令牌。
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

function normalizeVersion(tag: string): string | null {
  const m = tag.match(/v?(\d+(\.\d+)*)/i);
  return m ? m[1] : null;
}

/** 拉最新 Release；404（尚无 Release）返回 null */
export async function fetchLatestRelease(
  giteaUrl: string,
  repo: string,
  token: string,
): Promise<LatestRelease | null> {
  const base = giteaUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v1/repos/${repo}/releases/latest`, {
    headers: token ? { Authorization: `token ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message || '';
    } catch {
      /* body 非 JSON */
    }
    throw new Error(`Gitea API ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = (await res.json()) as {
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
