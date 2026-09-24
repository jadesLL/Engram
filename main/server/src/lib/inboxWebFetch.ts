import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateAddress } from '../cli/net.js';

/** 只抓网页 HTML 原件；不执行脚本，也不额外请求图片、样式等子资源。 */
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 45_000;
const TITLE_SCAN_BYTES = 256 * 1024;
const MAX_URL_LENGTH = 4096;

type ResolvedAddress = { address: string; family: number };
type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export class InboxWebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxWebFetchError';
  }
}

export interface InboxWebFetchResult {
  title: string;
  sourceUrl: string;
  bytes: number;
}

export interface InboxWebFetchOptions {
  /** 测试注入：线上使用系统 DNS，逐地址校验后将结果固定到本次连接。 */
  resolveHost?: HostResolver;
  fetchImpl?: typeof undiciFetch;
}

const resolveHost: HostResolver = (hostname) => dns.lookup(hostname, { all: true });

function parsePageUrl(raw: string): URL {
  if (!raw || raw.length > MAX_URL_LENGTH || raw.includes('\\')) {
    throw new InboxWebFetchError('请输入有效的网页地址（最长 4096 字符）');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InboxWebFetchError('网页地址无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InboxWebFetchError('只支持 http/https 网页地址');
  }
  if (url.username || url.password) {
    throw new InboxWebFetchError('网页地址不能携带用户名或密码');
  }
  if (url.port) {
    throw new InboxWebFetchError('网页地址只支持标准的 HTTP/HTTPS 端口');
  }
  url.hash = '';
  return url;
}

async function publicAddresses(url: URL, resolver: HostResolver): Promise<{ host: string; addresses: ResolvedAddress[] }> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host === 'metadata.google.internal' || host.startsWith('metadata.')) {
    throw new InboxWebFetchError('目标不是公网网页地址');
  }
  let addresses: ResolvedAddress[];
  const family = net.isIP(host);
  if (family) {
    addresses = [{ address: host, family }];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new InboxWebFetchError('网页域名无法解析');
    }
  }
  if (!addresses.length || addresses.some((entry) => !net.isIP(entry.address) || isPrivateAddress(entry.address))) {
    throw new InboxWebFetchError('目标指向私网、环回或保留地址，已阻止抓取');
  }
  return { host, addresses };
}

/** Undici 连接时只使用刚校验过的地址，避免校验和连接之间再次解析域名。 */
function pinnedAgent(host: string, addresses: ResolvedAddress[]): Agent {
  return new Agent({
    connections: 1,
    maxOrigins: 1,
    connect: {
      lookup(lookupHost, options, callback) {
        if (lookupHost.toLowerCase() !== host) {
          callback(new Error('网页域名与已校验目标不一致'), '', 0);
          return;
        }
        const candidates = addresses.filter((entry) => !options.family || entry.family === options.family);
        if (!candidates.length) {
          callback(new Error('没有可用的公网地址'), '', 0);
          return;
        }
        if (options.all) {
          (callback as any)(null, candidates);
          return;
        }
        callback(null, candidates[0].address, candidates[0].family);
      },
    },
  });
}

function decodeTitle(raw: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return raw.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return String.fromCodePoint(number); } catch { return match; }
    }
    return named[entity.toLowerCase()] ?? match;
  }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function titleFromHtml(probe: Buffer, contentType: string, url: URL): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] || 'utf-8';
  let source: string;
  try {
    source = new TextDecoder(charset).decode(probe);
  } catch {
    source = probe.toString('utf8');
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1];
  if (title) {
    const decoded = decodeTitle(title);
    if (decoded) return decoded;
  }
  const last = path.posix.basename(url.pathname);
  try {
    return decodeURIComponent(last).replace(/\.(html?|php|aspx?)$/i, '').trim().slice(0, 120) || url.hostname;
  } catch {
    return url.hostname;
  }
}

/**
 * 把公网页面的 HTML 流式写入隐藏暂存文件。调用方负责把暂存文件改名进收集箱，
 * 失败时本函数会清理暂存文件。没有人为设置单文件大小上限。
 */
export async function fetchInboxWebPage(
  rawUrl: string,
  tempPath: string,
  options: InboxWebFetchOptions = {}
): Promise<InboxWebFetchResult> {
  let current = parsePageUrl(rawUrl);
  const resolver = options.resolveHost ?? resolveHost;
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { host, addresses } = await publicAddresses(current, resolver);
      const agent = pinnedAgent(host, addresses);
      try {
        let response: Awaited<ReturnType<typeof undiciFetch>>;
        try {
          response = await fetchImpl(current.toString(), {
            method: 'GET',
            redirect: 'manual',
            dispatcher: agent,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
              Accept: 'text/html,application/xhtml+xml;q=0.9',
              'User-Agent': 'Mozilla/5.0 (compatible; EngramWebInbox/1.0)',
            },
          });
        } catch {
          throw new InboxWebFetchError('抓取网页失败：网络连接或请求超时');
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || hop === MAX_REDIRECTS) {
            throw new InboxWebFetchError('网页重定向次数过多或目标无效');
          }
          if (location.includes('\\')) throw new InboxWebFetchError('网页重定向地址无效');
          try {
            current = parsePageUrl(new URL(location, current).toString());
          } catch (error) {
            if (error instanceof InboxWebFetchError) throw error;
            throw new InboxWebFetchError('网页重定向地址无效');
          }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new InboxWebFetchError('网页抓取失败（HTTP ' + response.status + '）');
        }
        const contentType = response.headers.get('content-type') || '';
        const mime = contentType.split(';')[0].trim().toLowerCase();
        if (mime !== 'text/html' && mime !== 'application/xhtml+xml') {
          await response.body?.cancel();
          throw new InboxWebFetchError('目标没有返回 HTML 网页（' + (mime || '未知格式') + '）');
        }
        if (!response.body) throw new InboxWebFetchError('网页内容为空');

        const probe: Buffer[] = [];
        let remaining = TITLE_SCAN_BYTES;
        let bytes = 0;
        const scanTitle = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (remaining > 0) {
              const slice = chunk.subarray(0, remaining);
              probe.push(slice);
              remaining -= slice.length;
            }
            callback(null, chunk);
          },
        });
        fs.writeFileSync(tempPath, Buffer.alloc(0), { flag: 'wx' });
        await pipeline(Readable.fromWeb(response.body as any), scanTitle, fs.createWriteStream(tempPath));
        if (!bytes) throw new InboxWebFetchError('网页内容为空');
        // 注释放在文末，保留原网页开头的 BOM / DOCTYPE 与原始编码。
        const sourceUrl = current.toString();
        const safeSource = sourceUrl.replace(/--/g, '- -').replace(/>/g, '%3E');
        fs.appendFileSync(tempPath, '\n<!-- Engram source URL: ' + safeSource + ' -->\n');
        return {
          title: titleFromHtml(Buffer.concat(probe), contentType, current),
          sourceUrl,
          bytes,
        };
      } finally {
        try { await agent.destroy(); } catch { /* 已取消或连接断开 */ }
      }
    }
    throw new InboxWebFetchError('网页重定向次数过多');
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}
