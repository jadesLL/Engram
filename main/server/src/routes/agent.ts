import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { agentWritePage, WriteGateError } from '../pipeline/agentWrite.js';
import { enqueuePagePipeline } from '../jobQueue.js';

/**
 * 外部 Agent 的 REST 写入口（CLI `engram pages write` 使用）。
 * 与 MCP write_page 工具同一门禁内核：证据逐字校验 + 新建概念/实体页两来源门禁 + 自动操作日志。
 */
export async function agentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/agent/page', async (req, reply) => {
    const body = (req.body || {}) as {
      path?: string;
      title?: string;
      content?: string;
      type?: string;
      tags?: string[];
      evidence?: Array<{ path: string; quote: string }>;
    };
    if (!body.path || !body.title || !body.content) {
      return reply.code(400).send({ error: 'path / title / content 不能为空' });
    }
    try {
      const result = agentWritePage({
        path: body.path,
        title: body.title,
        content: body.content,
        type: body.type,
        tags: body.tags,
        evidence: body.evidence,
      });
      enqueuePagePipeline(result.meta.id);
      return {
        ok: true,
        meta: result.meta,
        created: result.created,
        evidenceRecorded: result.evidenceRecorded,
        guideVersion: result.guideVersion,
      };
    } catch (error) {
      if (error instanceof WriteGateError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
}
