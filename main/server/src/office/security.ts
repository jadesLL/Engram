import crypto from 'node:crypto';

export type SignedPayload = Record<string, unknown> & { exp?: number };

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds = 3600): string {
  if (!secret) throw new Error('ONLYOFFICE_JWT_SECRET 未配置');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string, secret: string): SignedPayload {
  if (!secret) throw new Error('ONLYOFFICE_JWT_SECRET 未配置');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('token 格式无效');
  const [header, body, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('token 签名无效');
  }
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
  if (parsed.exp && parsed.exp < Math.floor(Date.now() / 1000)) throw new Error('token 已过期');
  return parsed;
}

export function isSafeOfficeProxyPath(rawUrl: string): boolean {
  const rawPath = rawUrl.split('?', 1)[0];
  const lower = rawPath.toLowerCase();
  if (/%(?:00|2e|2f|5c)/i.test(lower) || rawPath.includes('\\')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (decoded !== '/onlyoffice' && !decoded.startsWith('/onlyoffice/')) return false;
  return !decoded.split('/').some((part) => part === '..' || part === '.');
}

export function rewriteOfficeDownloadUrl(rawUrl: string, internalBase: string): string {
  if (/%(?:00|2e|5c)/i.test(rawUrl) || rawUrl.includes('\\')) {
    throw new Error('ONLYOFFICE 下载地址无效');
  }
  const parsed = new URL(rawUrl);
  let pathname = parsed.pathname;
  if (pathname === '/onlyoffice') pathname = '/';
  else if (pathname.startsWith('/onlyoffice/')) pathname = pathname.slice('/onlyoffice'.length);
  if (!pathname.startsWith('/') || pathname.includes('\\') || /%2e|%5c|%00/i.test(pathname)) {
    throw new Error('ONLYOFFICE 下载地址无效');
  }
  const decoded = decodeURIComponent(pathname);
  if (decoded.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('ONLYOFFICE 下载地址越界');
  }
  const base = internalBase.endsWith('/') ? internalBase : `${internalBase}/`;
  return new URL(`${pathname.slice(1)}${parsed.search}`, base).toString();
}
