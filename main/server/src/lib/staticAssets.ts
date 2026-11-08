import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type StaticAsset = {
  body: Buffer;
  cacheControl: string;
  contentType: string;
  etag: string;
};

/** 已发现但还没读进内存的前端文件：只记绝对路径与响应头所需信息 */
type PendingAsset = {
  absPath: string;
  cacheControl: string;
  contentType: string;
};

export type StaticAssetCache = {
  /** 已读取并缓存的资源：启动时只有 /index.html（SPA fallback 与首屏依赖），其余首次请求再读 */
  assets: Map<string, StaticAsset>;
  /** 发现的前端文件总数 */
  files: number;
  /** 当前已缓存在内存里的字节数（随按需加载增长） */
  totalBytes: number;
  /** 未加载资源的清单（urlPath → 文件信息） */
  pending: Map<string, PendingAsset>;
};

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function cacheControl(urlPath: string): string {
  return urlPath.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  }));
  return files.flat();
}

function readAsset(entry: PendingAsset): Promise<StaticAsset> {
  return fs.promises.readFile(entry.absPath).then((body) => ({
    body,
    cacheControl: entry.cacheControl,
    contentType: entry.contentType,
    etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"`,
  }));
}

/**
 * 扫描前端构建产物：启动时只**遍历**文件清单（只为 content-type/cache-control），
 * 仅把 /index.html 读进内存（/ 与 SPA fallback 依赖它），其余资源等首次请求再读盘并缓存。
 *
 * 背景：web/dist 有 639 个文件 / 27MB，旧实现启动时全部 readFile + sha256，
 * 温盘实测约 60ms、冷盘（首次打开）更久，且这部分完全挡在 listen 之前。
 * 首屏只需要 index.html 与少量 assets，按需加载把启动时延换成首次访问的一次读盘，
 * 响应头（Cache-Control / ETag / 304 / HEAD）与 SPA fallback 语义保持不变。
 */
export async function loadStaticAssetCache(root: string): Promise<StaticAssetCache> {
  const assets = new Map<string, StaticAsset>();
  const pending = new Map<string, PendingAsset>();
  let files: string[];
  try {
    files = await walkFiles(root);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { assets, files: 0, totalBytes: 0, pending };
    throw error;
  }
  for (const filePath of files) {
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    const urlPath = `/${relativePath}`;
    pending.set(urlPath, {
      absPath: filePath,
      cacheControl: cacheControl(urlPath),
      contentType: contentType(filePath),
    });
  }
  // 首个页面的壳必须常驻：/ 与所有未知前端路径的 SPA fallback 都靠它
  const indexEntry = pending.get('/index.html');
  if (indexEntry) {
    pending.delete('/index.html');
    assets.set('/index.html', await readAsset(indexEntry));
  }
  let totalBytes = 0;
  for (const asset of assets.values()) totalBytes += asset.body.length;
  return { assets, files: files.length, totalBytes, pending };
}

function requestPath(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return undefined;
  }
}

function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  return Boolean(value?.split(',').some((candidate) => candidate.trim() === etag));
}

function sendAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  asset: StaticAsset,
) {
  reply
    .header('Cache-Control', asset.cacheControl)
    .header('Content-Type', asset.contentType)
    .header('ETag', asset.etag);
  if (matchesEtag(request.headers['if-none-match'], asset.etag)) {
    return reply.code(304).send();
  }
  reply.header('Content-Length', asset.body.length);
  if (request.method === 'HEAD') return reply.send();
  return reply.send(asset.body);
}

export async function registerStaticAssetCache(
  app: FastifyInstance,
  root: string,
): Promise<StaticAssetCache> {
  const cache = await loadStaticAssetCache(root);
  // 同一资源的并发首次请求只读一次盘
  const inflight = new Map<string, Promise<StaticAsset | undefined>>();

  const loadAsset = (urlPath: string): Promise<StaticAsset | undefined> => {
    const cached = cache.assets.get(urlPath);
    if (cached) return Promise.resolve(cached);
    const entry = cache.pending.get(urlPath);
    if (!entry) return Promise.resolve(undefined);
    const existing = inflight.get(urlPath);
    if (existing) return existing;
    const task = readAsset(entry)
      .then((asset) => {
        cache.assets.set(urlPath, asset);
        cache.pending.delete(urlPath);
        cache.totalBytes += asset.body.length;
        return asset;
      })
      .catch((error: any) => {
        // 构建产物在运行期被替换/删除：当作未命中，交给 SPA fallback 或 404；
        // 不能让单个资源读盘失败冒成 500（旧实现是启动整包读入，不存在这条路径）
        if (error?.code !== 'ENOENT') {
          app.log.warn({ err: error, path: entry.absPath }, '前端静态资源读取失败');
        }
        cache.pending.delete(urlPath);
        return undefined;
      })
      .finally(() => { inflight.delete(urlPath); });
    inflight.set(urlPath, task);
    return task;
  };

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: '资源不存在' });
    }
    const urlPath = requestPath(request.url);
    if (!urlPath) return reply.code(400).send({ error: '路径无效' });

    const asset = await loadAsset(urlPath === '/' ? '/index.html' : urlPath);
    if (asset) return sendAsset(request, reply, asset);
    const indexAsset = cache.assets.get('/index.html');
    if (!urlPath.startsWith('/api') && indexAsset) {
      return sendAsset(request, reply, indexAsset);
    }
    return reply.code(404).send({ error: '资源不存在' });
  });

  return cache;
}
