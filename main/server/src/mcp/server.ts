import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { listTree, readPage, safeJoin } from '../lib/vault.js';
import { saveChat } from '../lib/chat.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { pageEvidenceResponse } from '../pipeline/pageEvidence.js';
import { agentWritePage, WriteGateError } from '../pipeline/agentWrite.js';
import { isDistilledPath } from '../pipeline/sourceLedger.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { AGENT_GUIDE } from '../content/agentGuide.js';

/**
 * 面向外部 Agent 的 MCP 接口（streamable HTTP + Bearer）。
 * 读工具（search/list_pages/read_page/page_evidence/list_raw_files/read_raw_file/kb_guide）
 * + 写工具（write_page 带证据门禁与自动日志 / save_chat 对话沉积）。
 * 作业方法论见 kb_guide 下发的《Agent 作业指南》。
 */

const MCP_INSTRUCTIONS = `这是 Engram 个人知识大脑——不内置 AI，读、写、提炼全部由你（外部 Agent）完成。
能跑 shell 的 Agent 优先用 CLI（engram status/import/files/search/pages/chat/guide，--json 可得机器可读输出）；MCP 用于无法跑 shell、或需把图片作为图像内容直读（read_raw_file raw=true）时。
提炼作业收到指令后自动索引待提炼清单（CLI engram files list --pending，或 list_raw_files 传 pending=true），然后逐份串行处理：读一份、write_page 提交成功，再处理下一份，不要批量读完统一写页。
任何写操作前先读 Wiki/log.md（read_page）了解最近状态；你的写操作由服务端自动记入操作日志，无需手工记录。
新建 概念/实体 页必须带 evidence（≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条引文），已有页面增量不受限。
实体页固定结构：## 当前理解 / ## 相关页面 / ## 时间线；改写不搬运、无依据不编造；[[双链]] 只指已有或本次新建页。
完整作业流程（Map→Normalize→Retrieve→Plan→Critic→Compose→Verify→Commit）与页面模板用 kb_guide 获取。`;

const RAW_DIR = '原始资料';
const PAGE_TYPE_ENUM = ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other', 'note'] as const;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

function relExt(rel: string): string {
  return path.posix.extname(rel).slice(1).toLowerCase();
}

/** 递归列出原始资料（上限 500 条，Agent 按目录分批读取）；pending=true 时只返回未提炼文件 */
function listRawFiles(pending = false): Array<{ path: string; ext: string; size: number; extractionStatus: string | null; distilled: boolean }> {
  const out: Array<{ path: string; ext: string; size: number; extractionStatus: string | null; distilled: boolean }> = [];
  const root = safeJoin(RAW_DIR);
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 500) return;
      if (e.name.startsWith('.')) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
      } else {
        let size = 0;
        try { size = fs.statSync(childAbs).size; } catch { /* ignore */ }
        const ext = relExt(childRel);
        let extractionStatus: string | null = null;
        if (['md', 'markdown'].includes(ext)) {
          extractionStatus = 'md页面';
        } else {
          const row = db.prepare(
            `SELECT fe.status FROM file_extractions fe JOIN files f ON f.id=fe.file_id
             WHERE f.path=? AND f.deleted=0`
          ).get(childRel) as { status: string } | undefined;
          if (row?.status) {
            extractionStatus = row.status;
          } else {
            const file = db.prepare(`SELECT text FROM files WHERE path=? AND deleted=0`).get(childRel) as
              | { text: string }
              | undefined;
            extractionStatus = file?.text?.trim() ? '已索引' : null;
          }
        }
        const distilled = isDistilledPath(childRel);
        if (pending && distilled) continue;
        out.push({ path: childRel, ext, size, extractionStatus, distilled });
      }
    }
  };
  walk(root, RAW_DIR);
  return out;
}

/** 读一份原始资料：优先提取文本；raw=true 时返回原文件（图片走 MCP image 内容） */
function readRawFile(rel: string, raw: boolean)
  : { text: string } | { image: { data: string; mimeType: string } } | { error: string } {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('原始资料/')) return { error: '只能读取 原始资料/ 下的文件' };
  const abs = safeJoin(normalized);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { error: `文件不存在: ${normalized}` };
  const ext = relExt(normalized);
  if (!raw) {
    if (['md', 'markdown'].includes(ext)) {
      const rd = readPage(normalized);
      return { text: rd ? `# ${rd.meta.title}\n\n${rd.content}` : fs.readFileSync(abs, 'utf8') };
    }
    const file = db.prepare(`SELECT text FROM files WHERE path = ? AND deleted = 0`).get(normalized) as
      | { text: string }
      | undefined;
    const text = file?.text?.trim();
    if (text) return { text };
    return {
      text: `该文件尚无提取文本（可能是图片或无文字层的扫描件）。用 read_raw_file 传 raw=true 获取原文件内容，由你自行识别。`,
    };
  }
  const buffer = fs.readFileSync(abs);
  const mime = IMAGE_MIME[ext];
  if (mime && mime !== 'image/svg+xml') {
    return { image: { data: buffer.toString('base64'), mimeType: mime } };
  }
  return {
    text: JSON.stringify({
      path: normalized,
      mimeType: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream',
      encoding: 'base64',
      base64: buffer.toString('base64'),
    }),
  };
}

function makeServer(): McpServer {
  const server = new McpServer({ name: 'engram', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS });

  server.tool(
    'search',
    '在知识库中做关键词检索（Wiki 页面 + 原始文件提取文本），返回片段与出处',
    { query: z.string(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const hits = await hybridSearch(query, Math.min(Math.max(limit ?? 8, 1), 30));
      const text = hits
        .map((h, i) => `[${i + 1}] ${h.title} (${h.refType}:${h.path})\n${h.snippet}`)
        .join('\n\n');
      return { content: [{ type: 'text', text: text || '（无结果）' }] };
    }
  );

  server.tool('list_pages', '列出知识库目录树', {}, async () => {
    const tree = listTree();
    const lines: string[] = [];
    const walk = (nodes: any[], depth: number) => {
      for (const n of nodes) {
        lines.push(`${'  '.repeat(depth)}- ${n.name || n.title || n.path}${n.children ? '/' : ''}`);
        if (n.children) walk(n.children, depth + 1);
      }
    };
    walk(tree as any[], 0);
    return { content: [{ type: 'text', text: lines.join('\n') || '（空）' }] };
  });

  server.tool(
    'read_page',
    '按标题或页面ID读取知识库页面全文（markdown）',
    { titleOrId: z.string() },
    async ({ titleOrId }) => {
      let row = db
        .prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`)
        .get(titleOrId) as { path: string } | undefined;
      if (!row) {
        row = db
          .prepare(`SELECT path FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`)
          .get(titleOrId) as { path: string } | undefined;
      }
      if (!row) return { content: [{ type: 'text', text: `页面不存在: ${titleOrId}` }] };
      const rd = readPage(row.path);
      if (!rd) return { content: [{ type: 'text', text: `页面文件缺失: ${row.path}` }] };
      return {
        content: [{
          type: 'text',
          text: `# ${rd.meta.title}\n路径: ${rd.meta.path}\n类型: ${rd.meta.type}\n标签: ${(rd.meta.tags || []).join(', ')}\n\n${rd.content}`,
        }],
      };
    }
  );

  server.tool(
    'page_evidence',
    '读取概念/实体页的证据账本：来源路径、版本、事实与逐字引文（写页前先看这里了解已有证据）',
    { titleOrId: z.string() },
    async ({ titleOrId }) => {
      let pageId: string | undefined = titleOrId;
      if (!db.prepare(`SELECT 1 FROM pages WHERE id = ? AND deleted = 0`).get(titleOrId)) {
        const row = db
          .prepare(`SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`)
          .get(titleOrId) as { id: string } | undefined;
        pageId = row?.id;
      }
      if (!pageId) return { content: [{ type: 'text', text: `页面不存在: ${titleOrId}` }] };
      const evidence = pageEvidenceResponse(pageId);
      if (!evidence) {
        return { content: [{ type: 'text', text: `该页面不是概念/实体页，无证据账本` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(evidence, null, 2) }] };
    }
  );

  server.tool(
    'list_raw_files',
    '列出 原始资料/ 全部文件（含提取状态与已提炼标记；图片/无文字层文件需用 read_raw_file 读取原文件自行识别）',
    { pending: z.boolean().optional().describe('true 时只返回尚未提炼的文件（提炼作业索引用）') },
    async ({ pending }) => {
      const files = listRawFiles(!!pending);
      const lines = files.map((f) =>
        `${f.path} · ${f.ext} · ${Math.round(f.size / 1024)}KB · 提取:${f.extractionStatus ?? 'md页面'}${f.distilled ? ' · 已提炼' : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') || (pending ? '（没有待提炼的文件）' : '（原始资料为空）') }] };
    }
  );

  server.tool(
    'read_raw_file',
    '读取一份原始资料：默认返回提取文本（md 返回正文）；raw=true 返回原文件（图片以 image 内容返回，其余 base64）',
    { path: z.string(), raw: z.boolean().optional() },
    async ({ path: p, raw }) => {
      const result = readRawFile(p, raw === true);
      if ('error' in result) return { content: [{ type: 'text', text: result.error }], isError: true };
      if ('image' in result) {
        return {
          content: [
            { type: 'text', text: `原文件图片（${p}），请识别其中的文字与信息：` },
            { type: 'image', data: result.image.data, mimeType: result.image.mimeType },
          ],
        };
      }
      return { content: [{ type: 'text', text: result.text }] };
    }
  );

  server.tool(
    'write_page',
    '创建或覆盖知识库页面。新建 概念/实体 页必须带 evidence（两来源门禁：≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条）；引文服务端逐字校验。保存后自动建索引/图谱边并记操作日志。',
    {
      path: z.string().describe('相对路径，如 Wiki/概念/xxx.md 或 Wiki/实体/xxx.md'),
      title: z.string(),
      content: z.string().describe('markdown 正文'),
      type: z.enum(PAGE_TYPE_ENUM).optional(),
      tags: z.array(z.string()).optional(),
      evidence: z.array(z.object({
        path: z.string().describe('原始资料路径，如 原始资料/xxx.pdf'),
        quote: z.string().describe('来源原文中的逐字引文'),
      })).optional().describe('证据列表（新建概念/实体页必填）'),
    },
    async ({ path: p, title, content, type, tags, evidence }) => {
      try {
        const result = agentWritePage({ path: p, title, content, type, tags, evidence });
        enqueuePagePipeline(result.meta.id);
        return {
          content: [{
            type: 'text',
            text: `已保存: ${result.meta.path}（id: ${result.meta.id}，${result.created ? '新建' : '更新'}${result.evidenceRecorded ? `，证据 ${result.evidenceRecorded} 条入账` : ''}）`,
          }],
        };
      } catch (error) {
        if (error instanceof WriteGateError) {
          return { content: [{ type: 'text', text: `写入被门禁拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'save_chat',
    '把一段与外部 Agent 的对话沉积到 原始资料/对话/（按时间+标识命名；project 归到子目录；append 合并到当日最近一条）',
    {
      content: z.string().describe('对话正文 markdown'),
      identifier: z.string().optional().describe('简单标识，用于文件名 slug 与标题'),
      project: z.string().optional().describe('项目维度：归到 对话/<project>/ 子目录'),
      append: z.boolean().optional().describe('追加合并到当日/当 project 最近一条对话文件，否则新建'),
    },
    async ({ content, identifier, project, append }) => {
      const r = await saveChat({ content, identifier, project, append });
      return {
        content: [
          { type: 'text', text: `已沉积对话: ${r.path}（id: ${r.id}）${r.appended ? '（追加合并）' : '（新建）'}` },
        ],
      };
    }
  );

  server.tool(
    'kb_guide',
    '输出《Engram 知识库 Agent 作业指南》全文：知识库结构、提炼作业流程（八阶段）、页面契约与证据门禁规则',
    {},
    async () => ({ content: [{ type: 'text', text: AGENT_GUIDE }] })
  );

  return server;
}

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
