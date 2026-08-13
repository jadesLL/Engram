import { FastifyInstance } from 'fastify';
import {
  clearIngestHistory,
  getIngestHistory,
  listIngestHistory,
} from '../lib/ingestHistory.js';
import { requireAuth } from './auth.js';

export async function ingestHistoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/ingest/history', async (req) => {
    const query = req.query as {
      limit?: string;
      offset?: string;
      q?: string;
      status?: string;
    };
    return listIngestHistory({
      limit: Number(query.limit),
      offset: Number(query.offset),
      q: query.q,
      status: query.status,
    });
  });

  app.get('/api/ingest/history/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getIngestHistory(id);
    if (!result) return reply.code(404).send({ error: '提炼记录不存在或已清空' });
    return result;
  });

  app.delete('/api/ingest/history', async () => ({
    ok: true,
    hidden: clearIngestHistory(),
  }));
}
