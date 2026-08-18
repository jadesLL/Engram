import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { buildReportsOverview } from '../dream/reportCards.js';
import { decideReportGroup, DecideError } from '../dream/decide.js';

/** 新版整理报告:聚合概览 + 单个决策执行。旧 /api/dream/reports 接口保持不动。 */
export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/reports/overview', async () => buildReportsOverview());

  app.post('/api/reports/:id/decide', async (req, reply) => {
    const reportId = Number((req.params as { id: string }).id);
    const { option, input, reportIds } = (req.body || {}) as {
      option?: string;
      input?: { newTitle?: string; pageType?: string };
      reportIds?: number[];
    };
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return reply.code(400).send({ error: '报告 ID 无效' });
    }
    if (!option || typeof option !== 'string') {
      return reply.code(400).send({ error: '缺少处理选项' });
    }
    // 聚合卡:组内全部报告一并处理;未传 reportIds 时只处理主报告
    const ids = Array.isArray(reportIds) && reportIds.length ? reportIds : [reportId];
    if (!ids.includes(reportId)) ids.unshift(reportId);
    try {
      const result = await decideReportGroup(ids, option, input || {});
      return { ok: true, ...result };
    } catch (error: any) {
      if (error instanceof DecideError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
