import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { isPrivateAddress } from '../cli/net.js';

/**
 * 外链图片抓取（服务端唯一的出网图片口）：把正文里的 http(s) 图片落成本地附件。
 *
 * 安全约束（与 CLI 出网层同一套判定，见 cli/net.ts）：
 *  - 仅 http/https，拒绝 URL 内嵌凭据与云元数据端点；
 *  - 域名按 DNS 实际解析逐地址校验，私网/环回/链路本地一律阻断（防 SSRF 与 DNS rebinding）；
 *  - 重定向手动跟随并逐跳复检，最多 3 跳；
 *  - 只接受 image/* 响应，边读边限流，超限即断（防超大文件打爆内存与磁盘）。
 */

const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

export interface FetchedImage {
  buffer: Buffer;
  mime: string;
  /** 落盘用的文件名（带扩展名，不含路径） */
  name: string;
  /** 最终 URL（跟随重定向之后） */
  url: string;
}

export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageFetchError';
  }
}

async function assertPublicTarget(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageFetchError(`仅支持 http/https 图片地址：${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ImageFetchError('图片地址不能携带用户名密码');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'metadata.google.internal' || hostname.startsWith('metadata.')) {
    throw new ImageFetchError('目标地址被拒绝（云元数据端点）');
  }
  const addresses: string[] = [];
  if (net.isIP(hostname)) {
    addresses.push(hostname);
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      addresses.push(...records.map((record) => record.address));
    } catch {
      throw new ImageFetchError(`图片地址无法解析：${hostname}`);
    }
  }
  for (const ip of addresses) {
    if (isPrivateAddress(ip)) {
      throw new ImageFetchError(`图片地址指向私网/环回地址（${hostname} → ${ip}），已阻断`);
    }
  }
}

/** 落盘文件名：扩展名一律以响应 MIME 为准。
 *  图床常见「.png 的 URL 返回 JPEG」，若沿用 URL 里的扩展名，/media 会按 nosniff
 *  发错 Content-Type 导致图片渲染不出来。 */
function nameFromUrl(url: URL, mime: string): string {
  let base = 'image';
  try {
    base = path.basename(decodeURIComponent(url.pathname)) || 'image';
  } catch {
    base = 'image';
  }
  const stem = path.basename(base, path.extname(base)) || 'image';
  const ext = MIME_EXTENSION[mime] || path.extname(base).slice(1).toLowerCase() || 'png';
  return `${stem}.${ext}`;
}

async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        throw new ImageFetchError(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限，未本地化`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已读完时取消会抛，忽略 */ }
  }
  return Buffer.concat(chunks);
}

/** 抓一张远程图片；任何一步不合规都抛 ImageFetchError（调用方降级为保留外链） */
export async function fetchRemoteImage(rawUrl: string): Promise<FetchedImage> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new ImageFetchError(`图片地址无效：${rawUrl}`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicTarget(current);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'image/*' },
      });
    } catch (error: any) {
      if (error instanceof ImageFetchError) throw error;
      const cause = error?.cause?.code || error?.code || error?.name;
      throw new ImageFetchError(`下载图片失败（${cause || '网络错误'}）：${current.host}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ImageFetchError('图片地址重定向缺少目标');
      try { await response.body?.cancel(); } catch { /* 忽略 */ }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* 忽略 */ }
      throw new ImageFetchError(`下载图片失败（HTTP ${response.status}）`);
    }

    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // SVG 可携带脚本，服务端只存不解析，但为避免把可执行内容混进图片资产，统一不收
    if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
      try { await response.body?.cancel(); } catch { /* 忽略 */ }
      throw new ImageFetchError(`目标不是可本地化的图片类型（${mime || '未知'}）`);
    }

    const buffer = await readCapped(response.body);
    if (!buffer.length) throw new ImageFetchError('图片内容为空');
    return { buffer, mime, name: nameFromUrl(current, mime), url: current.toString() };
  }
  throw new ImageFetchError('图片地址重定向次数过多');
}
