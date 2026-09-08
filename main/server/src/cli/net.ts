import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * CLI 出网层（唯一出网口）：所有请求先经 validateTarget 再发送。
 * 安全约束：
 *  - 仅允许 http/https；拒绝 URL 内嵌凭据
 *  - 私网/环回/链路本地/保留地址默认阻断；域名按 DNS 实际解析逐地址校验（防 rebinding）
 *  - 重定向手动跟随并复检目标
 *  - allowPrivate=true 仅由用户 `engram login` 显式登记后获得
 *    （CLI 是客户端工具，桌面端 127.0.0.1 / Docker 内网是正常目标）
 */

/** IP 是否属于 私网/环回/链路本地/保留 段 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;               // 环回 / 私网A / 保留
    if (a === 172 && b >= 16 && b <= 31) return true;                // 私网B
    if (a === 192 && b === 168) return true;                         // 私网C
    if (a === 169 && b === 254) return true;                         // 链路本地（含云元数据）
    if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT
    if (a >= 224) return true;                                       // 组播/保留
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;                // 环回 / 未指定
  if (lower.startsWith('fe') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // 链路本地 / ULA
  return false;
}

export async function validateTarget(rawUrl: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`服务地址无效: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 服务地址: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error('服务地址不能携带用户名密码');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'metadata.google.internal' || hostname.startsWith('metadata.')) {
    throw new Error(`目标地址被拒绝（云元数据端点）: ${rawUrl}`);
  }
  if (allowPrivate) return url;
  // 未授权私网：字面量 IP 直接查；域名走 DNS 解析后逐地址查
  const addresses: string[] = [];
  if (net.isIP(hostname)) {
    addresses.push(hostname);
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      addresses.push(...records.map((r) => r.address));
    } catch {
      throw new Error(`服务地址无法解析: ${hostname}`);
    }
  }
  for (const ip of addresses) {
    if (isPrivateAddress(ip)) {
      throw new Error(
        `目标 ${hostname}（${ip}）是私网/环回地址。`
        + '连接本机或内网的 Engram 服务请先执行 `engram login --url <地址> --token <令牌>` 显式登记。'
      );
    }
  }
  return url;
}

export interface SendContext {
  url: string;
  token: string;
  allowPrivate: boolean;
}

/** fetch 网络层失败（DNS/拒绝连接/超时）转成可诊断的错误信息 */
async function rawFetch(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const cause = (e as any)?.cause?.code ?? (e as any)?.code;
    throw new Error(
      `无法连接 ${url.origin}${cause ? `（${cause}）` : ''}——服务未启动或地址不对。`
      + '本机 Engram 启动后会自动登记连接配置；远程服务请用 `engram login --url <地址> --token <令牌>` 更新。'
    );
  }
}

/** 唯一发送函数：校验通过后才 fetch；重定向手动跟随并复检 */
export async function httpSend(url: URL, init: RequestInit, ctx: SendContext): Promise<Response> {
  await validateTarget(url.toString(), ctx.allowPrivate);
  const res = await rawFetch(url, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location) {
      const next = await validateTarget(new URL(location, url).toString(), ctx.allowPrivate);
      return rawFetch(next, { ...init, redirect: 'manual' });
    }
  }
  return res;
}

/** 构造带校验的 API 地址 */
export async function buildUrl(ctx: SendContext, pathname: string, query: Record<string, string> = {}): Promise<URL> {
  const base = await validateTarget(ctx.url, true);
  const url = new URL(base.pathname.replace(/\/+$/, '') + pathname, base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** JSON/表单 API 调用（自动带 Bearer） */
export async function api(
  ctx: SendContext,
  method: string,
  pathname: string,
  options: { json?: unknown; form?: FormData; query?: Record<string, string> } = {},
): Promise<any> {
  const url = await buildUrl(ctx, pathname, options.query);
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.token}` };
  const init: RequestInit = { method, headers };
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  } else if (options.form) {
    init.body = options.form;
  }
  const res = await httpSend(url, init, ctx);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep raw text */ }
  if (!res.ok) {
    const message = typeof body === 'object' && body?.error ? body.error : `${res.status} ${text.slice(0, 300)}`;
    throw new Error(message);
  }
  return body;
}
