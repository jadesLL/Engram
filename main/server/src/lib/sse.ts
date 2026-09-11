import { FastifyReply } from 'fastify';

/** 启用 SSE：返回写入函数 */
export function sse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // writeHead 只暂存头部，首个 write 才真正上线。若不 flush，反代在上游读超时
  // （Lucky/nginx 常见 30s）前收不到任何字节 → 判上游无响应返回 502。
  // flushHeaders + 立即写一条注释，保证连接在请求即刻建立。
  reply.raw.flushHeaders();
  reply.raw.write(': connected\n\n');
  return {
    send(event: string, data: unknown) {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      reply.raw.end();
    },
  };
}
