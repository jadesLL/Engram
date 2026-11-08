import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { saveChat, type SaveChatInput } from '../lib/chat.js';

/** 外置 Agent 对话沉积的 REST 入口（脚本/过渡用；与 CLI `engram chat save` 同内核） */
export async function rawRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/raw/chat', async (req, reply) => {
    const body = (req.body || {}) as Partial<SaveChatInput>;
    if (!body.content || !String(body.content).trim()) {
      return reply.code(400).send({ error: 'content 不能为空' });
    }
    const result = await saveChat({
      content: String(body.content),
      identifier: body.identifier,
      project: body.project,
      append: body.append,
    });
    return { meta: result };
  });
}
