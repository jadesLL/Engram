import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { hybridSearch } from '../retrieval/hybrid.js';

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 关键词检索（页面 + 原始文件提取文本） */
  app.get('/api/search', async (req) => {
    const raw = (req.query as { q?: string | string[] }).q;
    const q = Array.isArray(raw) ? raw[0] : raw;
    if (!q?.trim()) return { hits: [] };
    const hits = await hybridSearch(q.trim());
    return { hits };
  });
}
