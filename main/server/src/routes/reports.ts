import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { buildReportsOverview } from '../dream/reportCards.js';
import { decideReport, DecideError } from '../dream/decide.js';

/** 新版整理报告:聚合概览 + 单个决策执行。旧 /api/dream/reports 接口保持不动。 */
export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/reports/overview', async () => buildReportsOverview());

  app.post('/api/reports/:id/decide', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { option, input } = (req.body || {}) as {
      option?: string;
      input?: { newTitle?: string; pageType?: string };
    };
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return reply.code(400).send({ error: '报告 ID 无效' });
    }
    if (!option || typeof option !== 'string') {
      return reply.code(400).send({ error: '缺少处理选项' });
    }
    try {
      const result = await decideReport(reportId, option, input || {});
      return { ok: true, ...result };
    } catch (error: any) {
      if (error instanceof DecideError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
