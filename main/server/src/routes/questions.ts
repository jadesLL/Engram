import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import {
  askQuestion, listQuestions, openQuestionCount, answerQuestion, QuestionError,
} from '../lib/agentQuestions.js';

/**
 * 待确认问题（Agent ↔ 用户）：
 * - GET  /api/questions?status=open|answered|all  用户界面「待确认」清单（同时给 open 计数）
 * - POST /api/questions/:id/answer                用户答复
 * - POST /api/agent/question                      Agent/CLI 登记问题（与 MCP ask_user 同一内核）
 *
 * 鉴权同 requireAuth：用户 JWT（界面）与 MCP Bearer Token（CLI/Agent）都放行。
 */
export async function questionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/questions', async (req) => {
    const raw = String((req.query as { status?: string })?.status || 'all');
    const status = raw === 'open' || raw === 'answered' ? raw : 'all';
    return { questions: listQuestions(status), open: openQuestionCount(), status };
  });

  app.post('/api/questions/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { answer?: string };
    try {
      const question = answerQuestion(id, String(body.answer || ''));
      return { ok: true, question, open: openQuestionCount() };
    } catch (error) {
      if (error instanceof QuestionError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/agent/question', async (req, reply) => {
    const body = (req.body || {}) as { question?: string; context?: string; options?: string[] };
    try {
      const question = askQuestion({
        question: String(body.question || ''),
        context: body.context,
        options: Array.isArray(body.options) ? body.options : undefined,
      });
      return { ok: true, question };
    } catch (error) {
      if (error instanceof QuestionError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
}
