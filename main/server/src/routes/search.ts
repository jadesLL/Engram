import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { hybridSearch } from '../retrieval/hybrid.js';

/** search 的 limit 默认值（与 UI 现状一致）；上限与旧 MCP search 的 30 条对齐 */
const SEARCH_LIMIT_DEFAULT = 12;
const SEARCH_LIMIT_MAX = 30;

/** 解析 limit：非数字回退默认值，超界夹紧到 1..30（只影响显式传参的调用方） */
function parseLimit(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(parsed), 1), SEARCH_LIMIT_MAX);
}

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 关键词检索（页面 + 原始文件提取文本）；limit 可选（整数，夹紧 1-30，默认 12），CLI `engram search --limit» 走这里 */
  app.get('/api/search', async (req) => {
    const query = req.query as { q?: string | string[]; limit?: string | string[] };
    const raw = query.q;
    const q = Array.isArray(raw) ? raw[0] : raw;
    if (!q?.trim()) return { hits: [] };
    const hits = await hybridSearch(q.trim(), parseLimit(query.limit));
    return { hits };
  });
}
