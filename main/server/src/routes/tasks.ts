import { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { writeBoardAutoDays } from '../assistant/boardCore.js';
import { AgentNotConfiguredError } from '../assistant/runner.js';
import { boardConfig, boardState, refreshBoard } from '../assistant/taskBoard.js';

/**
 * 任务看板的 HTTP 面：读当前看板 + 触发一次重新生成 + 自动重新提炼的间隔设置。
 *
 * 提问本身走的是 assistant 的运行通道（同一个 dsh、同一套事件流与排队），
 * 这里只负责「看板会话 + 最近一次答案」这一层，所以鉴权口径与 assistant 面一致：
 * owner 登录态 / MCP token / 已签发的同步成员 token 都能用。
 *
 * 间隔设置也走同一道门（不加 requireAuth）：它既不含密钥也不含路径，只是「打开看板页时要不要
 * 自动重提炼」的节奏，权限面比「让成员触发一次完整提炼」还小；而且手机端整条看板面都由本机
 * 服务窄代理到中枢（见 EngramLocalServer.kt），拦在 owner 后面会让手机上的这个开关直接点不动。
 */
export async function taskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  /** 看板现状：会话、最近一次成功答案、正在跑的那一轮、自动提炼档位 */
  app.get('/api/tasks/board', async () => boardState());

  /** 重新生成：已经在跑就复用（不重复烧 token），否则**新开一个会话**起一轮；202 立刻返回，进度接事件流 */
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

  /**
   * 自动重新提炼的配置：当前档位、可选档位、上次更新时间与到期时刻。
   * 看板页与设置页读同一份，界面不自己推一遍「哪天到期」。
   */
  app.get('/api/tasks/board/config', async () => boardConfig());

  /** 改档位：0 = 关闭自动，其余为天数（服务端归一化到登记档位）；返回改完的完整配置态 */
  app.put('/api/tasks/board/config', async (req, reply) => {
    const body = (req.body || {}) as { autoDays?: unknown };
    if (body.autoDays === undefined) return reply.code(400).send({ error: '缺少 autoDays' });
    writeBoardAutoDays(body.autoDays);
    return boardConfig();
  });
}
