/**
 * 标准 Registry HTTP API v2 客户端（digest 查询）：
 * 实现任何私有/公有 registry 通用的 Docker Registry v2 协议获取 manifest digest，
 * 用于「检查更新」时对比本地 :latest 与远端 :latest 是否一致。
 */

/** 匿名/凭据获取远端 manifest digest；仓库不存在返回 null */
export async function fetchRemoteDigest(
  registry: string,
  repository: string,
  auth: { username: string; token: string },
  tag = 'latest',
): Promise<string | null> {
  // 镜像 ref 拆出的 registry 是裸主机名（如 host:11111），fetch 需要显式协议；
  // 缺省按 Docker 惯例走 https（localhost/内网 IP 裸名按 http）
  let base = registry.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    const isLocal = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(base);
    base = isLocal ? `http://${base}` : `https://${base}`;
  }
  // Accept 列表按 registry 惯例从具体到通用；返回头 Docker-Content-Digest 即远端 digest
  const accept = [
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.v1+prettyjws',
  ].join(', ');

  const url = `${base}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = { Accept: accept };
  if (auth.username && auth.token) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString('base64')}`;
  }

  let res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });

  // Bearer 质询：按 RFC6750 走 token endpoint 换取短期 registry token
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate') || '';
    const realmMatch = challenge.match(/realm="([^"]+)"/);
    const serviceMatch = challenge.match(/service="([^"]+)"/);
    if (realmMatch) {
      const params = new URLSearchParams({ scope: `repository:${repository}:pull` });
      if (serviceMatch) params.set('service', serviceMatch[1]);
      const tokenUrl = `${realmMatch[1]}?${params}`;
      const tokenHeaders: Record<string, string> = {};
      if (auth.username && auth.token) {
        tokenHeaders.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString('base64')}`;
      }
      const tokenRes = await fetch(tokenUrl, { headers: tokenHeaders, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (tokenRes.ok) {
        const body = (await tokenRes.json()) as { token?: string; access_token?: string };
        const bearer = body.token || body.access_token;
        if (bearer) {
          res = await fetch(url, {
            headers: { ...headers, Authorization: `Bearer ${bearer}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(20_000),
          });
        }
      }
    }
  }

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Registry API ${res.status}`);

  const digest = res.headers.get('docker-content-digest');
  return digest || null;
}
