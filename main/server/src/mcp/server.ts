import { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { thinkText } from '../retrieval/synthesize.js';
import { writePage } from '../lib/vault.js';
import { saveChat } from '../lib/chat.js';
import { enqueuePagePipeline } from '../jobs.js';
import { executeAgentTool, getAgentTool, treeForMcp } from '../assistant/tools.js';

const mcpToolContext = {
  runId: 'mcp',
  sessionId: 'mcp',
  context: {},
};

/** 下发给知识内容操作 Agent 的纪律：先读操作日志、动手后追加，原始不提炼 */
const MCP_INSTRUCTIONS = `这是 LLM Wiki 个人知识大脑。操作日志位于 Wiki/log.md（标题「操作日志」），是知识内容操作的唯一记录与索引：时间倒序（新的在上）、原始不提炼。
通过 MCP 对知识内容执行任何写操作前，先用 read_page 读取 "Wiki/log.md" 了解最近状态；动作完成后，用 write_page 向 "Wiki/log.md" 追加一行，格式 "- YYYY-MM-DD HH:MM:SS 动作：细节"（插在 # 操作日志 标题正下方，保持倒序）。Dream Cycle / 实体升级 / 合并 / 删除 / 批量失败等 AI 副产物一律记进操作日志，不再另建独立文档。原始资料按正常入库管线处理，不做绕过提炼的笔记。详细规范见 docs/AI-CONTENT-OPERATIONS.md。`;

function makeServer(): McpServer {
  const server = new McpServer({ name: 'example-wiki', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });

  server.tool(
    'search',
    '在知识库中做混合检索（向量+关键词），返回相关片段与出处',
    { query: z.string(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const tool = getAgentTool('search_knowledge')!;
      const result = await executeAgentTool(
        tool,
        { query, limit: limit ?? 8 },
        mcpToolContext,
        {}
      );
      const hits = (result.data?.hits || []) as {
        title: string;
        refType: string;
        path: string;
        evidence: string[];
        snippet: string;
      }[];
      const text = hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.title} (${h.refType}:${h.path}) 匹配:${h.evidence.join('+')}\n${h.snippet}`
        )
        .join('\n\n');
      return { content: [{ type: 'text', text: text || '（无结果）' }] };
    }
  );

  server.tool(
    'think',
    '基于知识库综合回答问题：带引用与差距分析（指出知识库缺失/过期/矛盾）',
    { query: z.string() },
    async ({ query }) => {
      const { answer, hits } = await thinkText(query);
      const refs = hits.map((h, i) => `[${i + 1}] ${h.title} (${h.path})`).join('\n');
      return { content: [{ type: 'text', text: `${answer}\n\n---\n引用来源：\n${refs}` }] };
    }
  );

  server.tool(
    'read_page',
    '按标题或页面ID读取知识库页面全文（markdown）',
    { titleOrId: z.string() },
    async ({ titleOrId }) => {
      const tool = getAgentTool('read_page')!;
      let result;
      try {
        result = await executeAgentTool(tool, { reference: titleOrId }, mcpToolContext, {});
      } catch {
        return { content: [{ type: 'text', text: `页面不存在: ${titleOrId}` }] };
      }
      const page = result.data?.page;
      return {
        content: [
          {
            type: 'text',
            text: `# ${page.title}\n路径: ${page.path}\n类型: ${page.type}\n标签: ${(page.tags || []).join(', ')}\n\n${result.data?.content || ''}`,
          },
        ],
      };
    }
  );

  server.tool(
    'write_page',
    '创建或覆盖知识库页面（markdown）。保存后自动建立索引与图谱关联。',
    {
      path: z.string().describe('相对路径，如 notes/xxx.md'),
      title: z.string(),
      content: z.string().describe('markdown 正文'),
      type: z.enum(['note', 'concept', 'person', 'project', 'doc']).optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ path: p, title, content, type, tags }) => {
      const rel = p.endsWith('.md') ? p : `${p}.md`;
      const meta = writePage(rel, content, { title, type, tags });
      enqueuePagePipeline(meta.id);
      return { content: [{ type: 'text', text: `已保存: ${meta.path}（id: ${meta.id}）` }] };
    }
  );

  server.tool('list_pages', '列出知识库目录树', {}, async () => {
    return { content: [{ type: 'text', text: treeForMcp() }] };
  });

  server.tool(
    'save_chat',
    '把一段与外置 Agent 的对话沉积到 原始资料/对话/ 并立即入队提炼（仅可写入对话/；按时间+标识命名；project 归到 对话/<project>/ 子目录；append 合并到当日/当 project 最近一条对话文件）',
    {
      content: z.string().describe('对话正文 markdown'),
      identifier: z.string().optional().describe('简单标识，用于文件名 slug 与标题'),
      project: z.string().optional().describe('项目维度：归到 原始资料/chat/<project>/ 子目录'),
      append: z.boolean().optional().describe('追加合并到当日/当 project 最近一条 chat 文件，否则新建'),
    },
    async ({ content, identifier, project, append }) => {
      const r = await saveChat({ content, identifier, project, append });
      return {
        content: [
          { type: 'text', text: `已沉积对话: ${r.path}（id: ${r.id}）${r.appended ? '（追加合并）' : '（新建）'}，已入队提炼` },
        ],
      };
    }
  );

  return server;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.all('/mcp', async (req, reply) => {
    // token 鉴权
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const valid = token && db.prepare(`SELECT id FROM mcp_tokens WHERE token = ?`).get(token);
    if (!valid) {
      reply.code(401).send({ error: 'invalid MCP token' });
      return;
    }

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
