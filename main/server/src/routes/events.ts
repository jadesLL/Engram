import { FastifyInstance } from 'fastify';
import { sse } from '../lib/sse.js';
import { stateRevision, subscribe } from '../lib/events.js';
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

  /**
   * 内容版本号（轻量兜底探针，不建 SSE）。
   *
   * 侧栏/收集箱角标的主刷新通道仍是 SSE；但推送在反向代理缓冲、休眠唤醒、网络切换
   * 等情况下可能晚到或丢失，而 EventSource 只会在真的断开时重连——「连接还在、事件没来」
   * 时界面就会一直停在旧状态（用户报障：保存完成要等一会侧栏才出现）。
   * 前端每几秒拿一次这个版本号，变了才重读列表：正常情况几乎零成本，推送失联时
   * 也能在一两个轮询周期内自愈。
   */
  app.get('/api/events/state', async (_req, reply) => {
    // 高频探针：任何一层缓存（浏览器/反代）拿到旧版本号都会让兜底失效
    reply.header('Cache-Control', 'no-store');
    return { revision: stateRevision() };
  });
}
