import { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { AGENT_GUIDE } from '../content/agentGuide.js';

/**
 * 外部 Agent 作业指南（与 MCP kb_guide / CLI engram guide 同源）。
 *
 * v1.5.1：手机绑定中枢后，设置 → Agent 与自动化 → 工具与手册 要经同步成员令牌窄代理
 * 到中枢读这份只读指南，所以鉴权从 owner-only（requireAuth）放宽到
 * requireAssistantAccess（owner / MCP token / 同步成员令牌）。内容本身是静态文档，无敏感配置。
 */
export async function guideRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  app.get('/api/guide', async () => ({ guide: AGENT_GUIDE }));
}
