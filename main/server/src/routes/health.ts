import type { FastifyInstance } from 'fastify';

/**
 * 本地启动页 Origin 白名单（Capacitor WebView 默认 https://localhost；含常见本地回环变体）。
 * 仅命中白名单的跨域请求能读到响应体（ACAO + 凭据），其他任意网站发起的请求
 * 能到达但被浏览器 CORS 拦截读不到——保证 direct 直连地址不向第三方网页泄露。
 */
const LOCAL_PAGE_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * 轻量健康探针：恒 200、不触碰数据层，供容器 healthcheck 与负载探活使用。
 *
 * direct：可选直连地址（env DIRECT_ACCESS_URL，部署侧 main/.env 注入，如 IPv6 DDNS 域名），
 * 是「IPv6 直连优先、隧道兜底」的客户端发现入口。不设置时返回纯文本 'ok'，行为与历史一致。
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && LOCAL_PAGE_ORIGIN.test(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
    }
    reply.header('cache-control', 'no-store');
    const direct = (process.env.DIRECT_ACCESS_URL || '').trim();
    return direct ? { ok: 'ok', direct } : 'ok';
  });
}
