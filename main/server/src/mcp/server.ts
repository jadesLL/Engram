import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';

/**
 * /mcp 端点（streamable HTTP + Bearer）。
 *
 * MCP SDK 与全部工具注册都在 ./tools.ts；它们（连同工具链里的 pdfjs/xlsx/mammoth 等重模块）
 * 只在**首次 /mcp 请求**时动态加载，之后由 ESM 模块缓存复用——服务端启动 imports 阶段
 * 不再为「可能没人用的 MCP 端点」付这几个重包的加载成本。
 *
 * 鉴权仍在这里先做：token 无效直接 401，不触发任何重模块加载。
 */
export async function mcpRoutes(app: FastifyInstance) {
  app.all('/mcp', async (req, reply) => {
    // token 鉴权（与 REST API Bearer 同一张 mcp_tokens 表）
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const valid = token && db.prepare(`SELECT id FROM mcp_tokens WHERE token = ?`).get(token);
    if (!valid) {
      reply.code(401).send({ error: 'invalid MCP token' });
      return;
    }

    // 按需加载 MCP 运行时。失败必须显式回 500 而不是静默断连：此时还没有 hijack，
    // 交给 Fastify 正常回包，客户端能拿到「MCP 运行时加载失败」及底层原因。
    let tools: typeof import('./tools.js');
    let transportModule: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    try {
      [tools, transportModule] = await Promise.all([
        import('./tools.js'),
        import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
      ]);
    } catch (error: any) {
      app.log.error({ err: error }, 'MCP 运行时加载失败');
      return reply.code(500).send({ error: `MCP 运行时加载失败：${error?.message || String(error)}` });
    }
    const { makeServer } = tools;
    const { StreamableHTTPServerTransport } = transportModule;

    reply.hijack();
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, (req as any).body);
  });
}
