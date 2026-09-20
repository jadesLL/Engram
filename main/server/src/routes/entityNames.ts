import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import {
  answerEntityNameCheck, auditCompanyPages, describeCheckRequest, describeProposal,
  formatEntityNameAudit, formatEntityNameChecks, listEntityNameChecks, pendingEntityNameCount,
  proposeEntityName, requestEntityNameCheck, EntityNameError, type EntityNameStatus,
} from '../lib/entityNameChecks.js';

/**
 * 公司全名核验通道（Agent ↔ 用户）的 HTTP 面：
 * - GET  /api/entity-names?status=pending|open|unresolved|all  核验清单（CLI `names list` 用；界面已无核验页面）
 * - POST /api/entity-names/:id/answer                          答复落地（CLI `names answer` 用，与 MCP entity_name_answer 同一内核）
 * - POST /api/agent/entity-name                                Agent/CLI 登记待核名称（与 MCP entity_name_check 同一内核）
 * - POST /api/agent/entity-name/propose                        Agent/CLI 回填联网查到的工商全名
 * - GET  /api/agent/entity-name/audit                          全库公司页名称形态盘点
 *
 * 用户侧的问答不在这里：问用户发生在对话里（内置 Agent 经 MCP ask_user 弹底部选项、外部 Agent 用自己的
 * 提问能力），答复由 Agent 经 entity_name_answer 回填；这几个路由留给 CLI 与脚本。
 *
 * 鉴权同 requireAuth：用户 JWT（界面）与 MCP Bearer Token（CLI/Agent）都放行。
 */
export async function entityNameRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/entity-names', async (req) => {
    const raw = String((req.query as { status?: string })?.status || 'all');
    const status: EntityNameStatus =
      raw === 'pending' || raw === 'open' || raw === 'unresolved' ? raw : 'all';
    const checks = listEntityNameChecks(status);
    return {
      checks,
      pending: pendingEntityNameCount(),
      status,
      text: formatEntityNameChecks(checks, status),
    };
  });

  app.post('/api/entity-names/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { decision?: string; note?: string };
    const decision = body.decision === 'deny' ? 'deny' : body.decision === 'allow' ? 'allow' : null;
    if (!decision) return reply.code(400).send({ error: 'decision 必须是 allow 或 deny' });
    try {
      const check = answerEntityNameCheck(id, decision, String(body.note || ''));
      return { ok: true, check, pending: pendingEntityNameCount() };
    } catch (error) {
      if (error instanceof EntityNameError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/agent/entity-name', async (req, reply) => {
    const body = (req.body || {}) as { entity?: string; titleOrId?: string; note?: string };
    try {
      const result = requestEntityNameCheck({
        entity: String(body.entity || ''),
        titleOrId: body.titleOrId,
        note: body.note,
      });
      return { ok: true, ...result, text: describeCheckRequest(result) };
    } catch (error) {
      if (error instanceof EntityNameError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/agent/entity-name/propose', async (req, reply) => {
    const body = (req.body || {}) as { id?: string; fullName?: string; source?: string; note?: string };
    try {
      const check = proposeEntityName({
        id: String(body.id || ''),
        fullName: body.fullName,
        source: body.source,
        note: body.note,
      });
      return { ok: true, check, text: describeProposal(check) };
    } catch (error) {
      if (error instanceof EntityNameError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/api/agent/entity-name/audit', async () => {
    const result = auditCompanyPages();
    return { ...result, text: formatEntityNameAudit(result) };
  });
}
