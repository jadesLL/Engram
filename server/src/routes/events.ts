import { FastifyInstance } from 'fastify';
import { sse } from '../lib/sse.js';
import { subscribe } from '../lib/events.js';
import { requireAuth } from './auth.js';

/**
 * 实时事件流：GET /api/events（SSE）。
 * 前端用 EventSource 订阅，同源自动带 token cookie，复用 requireAuth 鉴权。
 * 服务端在 writePage/moveToTrash/movePage 处 emit page-changed/deleted/moved，
 * 此连接长开，由客户端断开时 req close 触发反注册。
 */
export async function eventRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/events', async (req, reply) => {
    const stream = sse(reply);
    const unsubscribe = subscribe({ send: stream.send, raw: reply.raw });
    req.raw.on('close', () => {
      unsubscribe();
      try { stream.close(); } catch { /* 已关闭 */ }
    });
    // 保持连接：不在此处 close
  });
}
