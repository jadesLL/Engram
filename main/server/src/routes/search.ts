import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { think } from '../retrieval/synthesize.js';
import { sse } from '../lib/sse.js';

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** search 模式：原始混合检索 */
  app.get('/api/search', async (req) => {
    const raw = (req.query as { q?: string | string[] }).q;
    const q = Array.isArray(raw) ? raw[0] : raw;
    if (!q?.trim()) return { hits: [] };
    const hits = await hybridSearch(q.trim());
    return { hits };
  });

  /** think 模式：SSE 流式综合回答 */
  app.post('/api/search/think', async (req, reply) => {
    const raw = (req.body as { q?: string | string[] })?.q;
    const q = Array.isArray(raw) ? raw[0] : raw;
    const stream = sse(reply);
    if (!q?.trim()) {
      stream.send('error', { message: '问题为空' });
      stream.close();
      return;
    }
    try {
      const result = await think(q.trim(), (delta) => stream.send('delta', { text: delta }));
      stream.send('hits', { hits: result.hits });
      stream.send('done', {});
    } catch (e: any) {
      stream.send('error', { message: e.message || 'AI 回答失败' });
    }
    stream.close();
  });
}
