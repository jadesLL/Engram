import { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { AgentNotConfiguredError } from '../assistant/runner.js';
import { boardState, refreshBoard } from '../assistant/taskBoard.js';

/**
 * 任务看板的 HTTP 面：读当前看板 + 触发一次重新生成。
 *
 * 提问本身走的是 assistant 的运行通道（同一个 dsh、同一套事件流与排队），
 * 这里只负责「看板会话 + 最近一次答案」这一层，所以鉴权口径与 assistant 面一致：
 * owner 登录态 / MCP token / 已签发的同步成员 token 都能用。
 */
export async function taskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  /** 看板现状：会话、最近一次成功答案、正在跑的那一轮 */
  app.get('/api/tasks/board', async () => boardState());

  /** 重新生成：已经在跑就复用（不重复烧 token），否则起一轮；202 立刻返回，进度接事件流 */
  app.post('/api/tasks/board/refresh', async (_req, reply) => {
    try {
      return reply.code(202).send(refreshBoard());
    } catch (error) {
      if (error instanceof AgentNotConfiguredError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
}
