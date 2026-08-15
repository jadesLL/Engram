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

export type StaticAssetCache = {
  assets: Map<string, StaticAsset>;
  files: number;
  totalBytes: number;
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

export async function loadStaticAssetCache(root: string): Promise<StaticAssetCache> {
  const assets = new Map<string, StaticAsset>();
  let files: string[];
  try {
    files = await walkFiles(root);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { assets, files: 0, totalBytes: 0 };
    throw error;
  }
  const loaded = await Promise.all(files.map(async (filePath) => ({
    filePath,
    body: await fs.promises.readFile(filePath),
  })));
  let totalBytes = 0;
  for (const { filePath, body } of loaded) {
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    const urlPath = `/${relativePath}`;
    totalBytes += body.length;
    assets.set(urlPath, {
      body,
      cacheControl: cacheControl(urlPath),
      contentType: contentType(filePath),
      etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"`,
    });
  }
  return { assets, files: files.length, totalBytes };
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
  const indexAsset = cache.assets.get('/index.html');

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: '资源不存在' });
    }
    const urlPath = requestPath(request.url);
    if (!urlPath) return reply.code(400).send({ error: '路径无效' });

    const asset = cache.assets.get(urlPath === '/' ? '/index.html' : urlPath);
    if (asset) return sendAsset(request, reply, asset);
    if (!urlPath.startsWith('/api') && !urlPath.startsWith('/mcp') && indexAsset) {
      return sendAsset(request, reply, indexAsset);
    }
    return reply.code(404).send({ error: '资源不存在' });
  });

  return cache;
}
