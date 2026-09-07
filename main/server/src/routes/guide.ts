import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { AGENT_GUIDE } from '../content/agentGuide.js';

/** 外部 Agent 作业指南（与 MCP kb_guide / CLI engram guide 同源） */
export async function guideRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/guide', async () => ({ guide: AGENT_GUIDE }));
}
