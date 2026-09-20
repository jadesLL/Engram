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
import {
  deletePageAsAgent, renamePageAsAgent, movePageAsAgent, resolvePageRef, AgentPageError,
} from '../pipeline/agentDelete.js';
import { relatedPageData } from '../lib/graphCache.js';
import { isDistilledPath } from '../pipeline/sourceLedger.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { AGENT_GUIDE, GUIDE_VERSION } from '../content/agentGuide.js';
import { SKILLS, findSkill } from '../content/skills/index.js';
import {
  answerEntityNameCheck, auditCompanyPages, describeCheckRequest, describeEntityNameAnswer,
  describeProposal, formatEntityNameAudit, formatEntityNameChecks, listEntityNameChecks,
  pendingEntityNameCount, proposeEntityName, requestEntityNameCheck, EntityNameError,
  type EntityNameStatus,
} from '../lib/entityNameChecks.js';
import { AgentQuestionError, askUserQuestions, formatAskOutcome } from '../assistant/questions.js';

/**
 * 面向外部 Agent 的 MCP 接口（streamable HTTP + Bearer）。
 * 读工具（search/list_pages/read_page/related_pages/page_evidence/list_raw_files/read_raw_file/
 * list_entity_names/entity_name_audit/kb_guide/skill_list/skill_guide）
 * + 写工具（write_page 带证据门禁与自动日志 / rename_page / move_page / delete_page 软删除入回收站 /
 * save_chat 对话沉积 / entity_name_check 登记公司全名核验 / entity_name_answer 回填用户答复 /
 * entity_name_propose 回填全名 / ask_user 内置 Agent 在对话里问用户并等点选）。
 * 全部写操作只允许 Wiki/，原始资料与 AIWorks 对 Agent 是只读区。
 * 作业方法论见 kb_guide；按需作业手法见 skill_list / skill_guide。
 */

const MCP_INSTRUCTIONS = `这是 Engram 个人知识大脑——不内置 AI，读、写、提炼全部由你（外部 Agent）完成。
能跑 shell 的 Agent 优先用 CLI（engram status/import/files/search/pages/names/chat/guide，--json 可得机器可读输出）；MCP 用于无法跑 shell、或需把图片作为图像内容直读（read_raw_file raw=true）时。
提炼作业收到指令后自动索引待提炼清单（CLI engram files list --pending，或 list_raw_files 传 pending=true），然后逐份串行处理：读一份、write_page 提交成功，再处理下一份，不要批量读完统一写页。
任何写操作前先读 AIWorks/log/log.md（read_page）了解最近状态；你的写操作由服务端自动记入操作日志，无需手工记录。
新建 概念/实体 页必须带 evidence（≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条引文），已有页面增量不受限。
原始资料与 AIWorks 对 Agent 是只读区：写工具只能写 Wiki/。软件本身具备上传/新建/删除原始资料的能力，但那是用户的操作——你没有写权限，也不得走 HTTP 旁路自行写入；作业时需要的资料不在库里就按现有材料推进，把缺口写进页面的「待核实」，不要卡住整批作业。
对话沉积（save_chat）只在用户明确指示后执行；不要自行判断"这段对话有价值"就沉淀。已沉淀的对话属于原始资料，可被后续提炼引用。
资料里查不到、又必须有个说法时（同名主体区分、客户身份口径等）：能自查的先自查（search 全库、读原文比对），仍无定论就按证据取最可信的写法落页，并在正文标注「待核实」与依据——不编造、不空等。
公司工商全名是唯一例外：公司类实体页标题要用工商全名，材料与资料库都没有时，entity_name_check 登记（服务端先自查资料库：页面标题/证据账本/原始资料里有全名就直接返回，Wiki 正文里的写法只算未核实候选），**随即在对话里问用户**是否允许联网查企查查/天眼查——内置 Agent 用 ask_user（Engram 对话最下侧弹选项，点选即得答复），外部 Agent 用你自己的提问能力问在自己的对话里（不要用 ask_user，它等的是 Engram 界面）。拿到答复用 entity_name_answer 回填；答复允许后用你自己的联网检索查企查查/天眼查，entity_name_propose 回填全名与出处，再问一次是否改用全名，同意后用 entity_name_answer(id, "allow") 由服务端执行改名。问不到（用户不在/不答复）就按现有材料推进并在名称口径标注「全称待确认」，不要卡住整批作业；收尾用 list_entity_names 传 status=unresolved 列出仍未定全名的条目。
误建的页面用 delete_page 删除：只做软删除入回收站（可恢复），只能删 Wiki/ 下的页面，不提供清空回收站能力。
页面改名/移动用 rename_page / move_page（保持页面 ID 与图谱边，重命名会重定向引用双链）；写页与页面操作都只允许 Wiki/。
实体页固定结构：## 当前理解 / ## 相关页面 / ## 时间线；改写不搬运、无依据不编造；[[双链]] 只指已有或本次新建页。
完整作业流程（Map→Normalize→Retrieve→Plan→Critic→Compose→Verify→Commit）与页面模板用 kb_guide 获取；具体作业手法与纪律先用 skill_list 看清单，再用 skill_guide(name) 取全文。`;

const RAW_DIR = '原始资料';
const PAGE_TYPE_ENUM = ['concept', 'person', 'customer', 'org', 'project', 'other', 'note'] as const;

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

/** 构建 MCP Server 实例（导出供单测用内存传输直连，生产经 /mcp 端点接入） */
export function makeServer(): McpServer {
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

  server.tool(
    'list_pages',
    '列出知识库目录树（页面带提炼规则版本）。可叠加过滤：outdated=true 只列落后于当前指南的页面（供按新规则重提炼）；path 按路径前缀过滤（如 Wiki/实体）；tag 按标签过滤',
    {
      outdated: z.boolean().optional().describe('true 时只列提炼规则版本落后于当前指南的页面（旧页面版本为 0）'),
      path: z.string().optional().describe('路径前缀过滤，如 Wiki/实体 或 Wiki/概念'),
      tag: z.string().optional().describe('按页面标签过滤（精确匹配一个标签）'),
    },
    async ({ outdated, path: prefix, tag }) => {
      const prefixNorm = prefix
        ? String(prefix).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
        : null;
      let tagPaths: Set<string> | null = null;
      if (tag) {
        const rows = db.prepare(`SELECT path, tags FROM pages WHERE deleted = 0`).all() as any[];
        tagPaths = new Set(
          rows.filter((r) => {
            try { return (JSON.parse(r.tags || '[]') as string[]).includes(String(tag)); } catch { return false; }
          }).map((r) => r.path)
        );
      }
      const keepPage = (p: string, guideVersion: number) =>
        (!outdated
          || ((p.startsWith('Wiki/概念/') || p.startsWith('Wiki/实体/')) && guideVersion < GUIDE_VERSION))
        && (!prefixNorm || p.startsWith(prefixNorm))
        && (!tagPaths || tagPaths.has(p));
      const prune = (nodes: any[]): any[] =>
        nodes
          .map((n) => (n.children ? { ...n, children: prune(n.children) } : n))
          .filter((n) =>
            n.kind === 'page'
              ? keepPage(n.path, Number(n.guide_version ?? 0))
              : n.kind === 'dir' ? n.children.length > 0 : false
          );
      const tree = prune(listTree() as any[]);
      const lines: string[] = [];
      const walk = (nodes: any[], depth: number) => {
        for (const n of nodes) {
          const versionTag = n.kind === 'page'
            ? ` · 规则v${n.guide_version ?? 0}${Number(n.guide_version ?? 0) < GUIDE_VERSION ? `（落后，当前 v${GUIDE_VERSION}）` : ''}`
            : '';
          lines.push(`${'  '.repeat(depth)}- ${n.name || n.title || n.path}${n.children ? '/' : ''}${versionTag}`);
          if (n.children) walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
      return { content: [{ type: 'text', text: lines.join('\n') || '（无匹配页面）' }] };
    }
  );

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
    'related_pages',
    '读取页面的图谱关联：相邻页面（入链/出链）与实体关联（写「相关页面」章节、验证 [[双链]] 目标、发现反向引用时用）',
    { titleOrId: z.string() },
    async ({ titleOrId }) => {
      let page;
      try {
        page = resolvePageRef(titleOrId);
      } catch (error) {
        if (error instanceof AgentPageError) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        throw error;
      }
      const data = relatedPageData(page.id);
      if (!data.neighbors.length && !data.entities.length) {
        return { content: [{ type: 'text', text: `「${page.title}」暂无图谱关联（无相邻页面与实体关系）` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
    '创建或覆盖知识库页面（只能写 Wiki/ 下，原始资料与 AIWorks 只读）。新建 概念/实体 页必须带 evidence（两来源门禁：≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条）；引文服务端逐字校验。保存后自动建索引/图谱边并记操作日志。',
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
            text: `已保存: ${result.meta.path}（id: ${result.meta.id}，${result.created ? '新建' : '更新'}，规则版本 v${result.guideVersion}${result.evidenceRecorded ? `，证据 ${result.evidenceRecorded} 条入账` : ''}）`,
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
    'delete_page',
    '把单个页面移入回收站（软删除、可恢复）。只能删 Wiki/ 下的页面：原始资料/ 与 AIWorks/ 是只读区，拒绝删除；不提供永久删除或清空回收站能力。删除由服务端记入操作日志。',
    {
      titleOrId: z.string().describe('页面标题、页面 ID 或页面路径（如 Wiki/概念/xxx.md；标题不唯一时请用 ID 或路径）'),
      reason: z.string().optional().describe('删除原因，写入操作日志便于复核'),
    },
    async ({ titleOrId, reason }) => {
      try {
        const result = deletePageAsAgent(titleOrId, { reason });
        return {
          content: [{
            type: 'text',
            text: `已移入回收站: ${result.title}（${result.path}，回收站条目 id: ${result.trashId}）`
              + `——可在 Engram「设置 → 存储空间 → 回收站」恢复；本次删除已记入操作日志。`,
          }],
        };
      } catch (error) {
        if (error instanceof AgentPageError) {
          return { content: [{ type: 'text', text: `删除被拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'rename_page',
    '重命名页面：文件随标题移动、正文 H1 同步，并把其他页面引用的 [[旧标题]] 双链重定向到新标题（保持页面 ID 与图谱边不断）。只能操作 Wiki/ 下的页面。',
    {
      titleOrId: z.string().describe('页面标题、页面 ID 或页面路径（标题不唯一时请用 ID 或路径）'),
      newTitle: z.string().describe('新标题'),
    },
    async ({ titleOrId, newTitle }) => {
      try {
        const result = renamePageAsAgent(titleOrId, newTitle);
        return {
          content: [{
            type: 'text',
            text: `已重命名: 「${titleOrId}」→「${result.title}」，现在位于 ${result.path}；引用双链已重定向，操作已记入日志。`,
          }],
        };
      } catch (error) {
        if (error instanceof AgentPageError) {
          return { content: [{ type: 'text', text: `重命名被拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'move_page',
    '移动页面到 Wiki 树内的目标目录（保持页面 ID 与图谱边；可顺带改标题，改标题不重定向引用双链）。只能操作 Wiki/ 下的页面。',
    {
      titleOrId: z.string().describe('页面标题、页面 ID 或页面路径（标题不唯一时请用 ID 或路径）'),
      dir: z.string().optional().describe('目标目录，如 Wiki/实体；不传则保持在原目录（仅改名时用 newTitle）'),
      newTitle: z.string().optional().describe('顺带改标题（文件名随标题变化）'),
    },
    async ({ titleOrId, dir, newTitle }) => {
      try {
        const result = movePageAsAgent(titleOrId, { dir, newTitle });
        if (!result.moved) {
          return { content: [{ type: 'text', text: `位置未变化: ${result.path}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: `已移动: 「${result.title}」→ ${result.path}（页面 ID 与图谱边保持不变）；操作已记入日志。`,
          }],
        };
      } catch (error) {
        if (error instanceof AgentPageError) {
          return { content: [{ type: 'text', text: `移动被拒绝：${error.message}` }], isError: true };
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
    'entity_name_check',
    '公司全名核验（登记待核名称）：公司类实体的名称不是工商全名、资料库里也找不到时登记一条核验——这是全库唯一允许问用户的事，但**问在对话里**，没有专门的核验页面。服务端会先自查资料库（页面标题 / 证据账本 / 原始资料提取文本 / 正文里写明全名的提法）：有全名就直接返回，用 rename_page 改用全名即可，不问用户；正文里带「待核实/候选」标记的写法只算「疑似候选（未核实）」，仍照常登记。返回文本会告诉你下一步：立刻在对话里问用户是否允许联网查企查查/天眼查（内置 Agent 用 ask_user 弹底部选项；外部 Agent 用你自己的提问能力问在自己的对话里），再用 entity_name_answer 回填答复。',
    {
      entity: z.string().describe('材料里的公司名称写法（通常是简称），如「津亚电子」'),
      titleOrId: z.string().optional().describe('关联页面（标题/ID/路径）；用户同意改用全名时服务端据此自动改名'),
      note: z.string().optional().describe('说明：卡在哪、已查到哪些候选（帮助用户判断）'),
    },
    async ({ entity, titleOrId, note }) => {
      try {
        const result = requestEntityNameCheck({ entity, titleOrId, note });
        return { content: [{ type: 'text', text: describeCheckRequest(result) }] };
      } catch (error) {
        if (error instanceof EntityNameError) {
          return { content: [{ type: 'text', text: `名称核验登记被拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'entity_name_answer',
    '回填用户对名称核验的答复（对话里问到的用户口径）——两轮共用：query_consent 阶段 allow=允许你联网查企查查/天眼查（接着去查、再 entity_name_propose 回填）；rename_consent 阶段 allow=同意把页面标题改用全名（服务端立刻改名：保持页面 ID、引用双链重定向、自动记日志），deny=不同意（标题保持材料写法）。前置：用户不在或没答复时不要替用户决定，按现有材料推进并标注「全称待确认」。',
    {
      id: z.string().describe('核验 id（entity_name_check 登记时返回）'),
      decision: z.enum(['allow', 'deny']).describe('用户的答复：allow=同意 / deny=不同意'),
      note: z.string().optional().describe('用户的原话或补充（写进核验记录，便于以后追溯）'),
    },
    async ({ id, decision, note }) => {
      try {
        const check = answerEntityNameCheck(id, decision, note || '');
        return { content: [{ type: 'text', text: describeEntityNameAnswer(check) }] };
      } catch (error) {
        if (error instanceof EntityNameError) {
          return { content: [{ type: 'text', text: `答复被拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'entity_name_propose',
    '回填联网查到的工商全名，然后请你在对话里问用户是否把页面标题改为该全名（同意后由服务端改名：保持页面 ID、引用双链重定向、自动记日志）。前置：该核验已被用户允许联网查询。查不到全名时不要传 fullName——本次核验按「未找到全名」办结，收尾列入「最终不是全名」清单。全名的界定是企查查等能否查到该名称，查到的是简称就继续查全称，不得编造或推测。',
    {
      id: z.string().describe('核验 id（entity_name_check 登记时返回）'),
      fullName: z.string().optional().describe('企查查/天眼查 查到的工商登记全名；查不到就不传'),
      source: z.string().optional().describe('出处：企查查/天眼查 链接或查询说明（用户据此判断可信度）'),
      note: z.string().optional().describe('补充：同名主体候选、为什么取这个全名'),
    },
    async ({ id, fullName, source, note }) => {
      try {
        const check = proposeEntityName({ id, fullName, source, note });
        return { content: [{ type: 'text', text: describeProposal(check) }] };
      } catch (error) {
        if (error instanceof EntityNameError) {
          return { content: [{ type: 'text', text: `回填被拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'list_entity_names',
    '读名称核验清单（默认全部，最新在前）：pending 已登记还没回填用户答复 / open 未办结 / unresolved 最终不是全名。换一轮作业时先看这里；作业收尾用 status=unresolved 把仍未定全名的条目列给用户（名称、页面、卡在哪、为什么）。',
    {
      status: z.enum(['pending', 'open', 'unresolved', 'all']).optional()
        .describe('默认 all；pending 只列已登记还没回填答复的，unresolved 只列「最终不是全名」的'),
    },
    async ({ status }) => {
      const key: EntityNameStatus = status || 'all';
      const checks = listEntityNameChecks(key);
      return {
        content: [{
          type: 'text',
          text: `${formatEntityNameChecks(checks, key)}\n\n`
            + `（已登记还没回填答复 ${pendingEntityNameCount()} 条。用户答复属用户提供的口径，写进正文时标注「用户确认」，不要为它编造引文。）`,
        }],
      };
    }
  );

  server.tool(
    'entity_name_audit',
    '全库公司页名称盘点：列出公司类实体页（客户/组织）里标题不是工商全名形态的页面及各自核验状态（未核验/待答复/已允许待回填/已办结）。批量核验与收尾汇报「仍未定全名的条目」时用。',
    {},
    async () => ({ content: [{ type: 'text', text: formatEntityNameAudit(auditCompanyPages()) }] })
  );

  server.tool(
    'ask_user',
    '在 Engram 对话里向用户提问并等他点选（内置 Agent 用）：问题会出现在对话最下侧的选项弹窗，用户点选后本工具立刻返回他的选择，你在同一轮继续干活。'
      + '只问「只有用户能定」的事——既定场景是公司工商全名核验（是否允许联网查企查查/天眼查、是否改用全名）；'
      + '其他拿不准的信息按证据自己定并标注「待核实」，不要拿这个工具问。'
      + '外部 Agent（Claude Code / Codex / ZCode 等）不要用：它等的是 Engram 界面，请用你自己的提问能力问在对话里。'
      + '没有正在跑的 Engram 对话时会立刻失败并说明，那时把问题写进回复正文。',
    {
      questions: z.array(z.object({
        id: z.string().optional().describe('问题标识（答复里回带），不填按 q1、q2 编号'),
        question: z.string().describe('要问用户的问题（一句话说清，别把背景长篇塞进问题里）'),
        header: z.string().optional().describe('可选短标题，如「名称核验」'),
        options: z.array(z.object({
          label: z.string().describe('选项文字（用户在弹窗里点这个按钮）'),
          description: z.string().optional().describe('一句话说明这个选项的后果'),
        })).optional().describe('可点选的选项；推荐项放第一个并在 label 末尾加「（推荐）」'),
        multiSelect: z.boolean().optional().describe('是否允许多选，默认单选'),
      })).describe('要问的问题（1-5 个，一次问完）'),
      timeoutMs: z.number().optional().describe('等用户答复的上限毫秒，默认 10 分钟，最长 25 分钟'),
    },
    async ({ questions, timeoutMs }) => {
      try {
        const outcome = await askUserQuestions({ questions, timeoutMs });
        const text = formatAskOutcome(outcome);
        return outcome.ok
          ? { content: [{ type: 'text', text }] }
          : { content: [{ type: 'text', text }], isError: true };
      } catch (error) {
        if (error instanceof AgentQuestionError) {
          return { content: [{ type: 'text', text: `提问被拒绝：${error.message}` }], isError: true };
        }
        throw error;
      }
    }
  );

  server.tool(
    'kb_guide',
    '输出《Engram 知识库 Agent 作业指南》全文：知识库结构、提炼作业流程（八阶段）、页面契约与证据门禁规则',
    {},
    async () => ({ content: [{ type: 'text', text: AGENT_GUIDE }] })
  );

  server.tool(
    'skill_list',
    '列出服务端内置的作业 skill 元数据（名称/用途/何时用/版本）。skill 与《Agent 作业指南》同级但按需获取：先列清单，需要时再用 skill_guide 取全文',
    {},
    async () => {
      const text = SKILLS
        .map((skill) => [
          `- ${skill.name}（v${skill.version}）｜${skill.title}`,
          `  用途：${skill.description}`,
          `  何时用：${skill.whenToUse}`,
        ].join('\n'))
        .join('\n\n');
      return {
        content: [{
          type: 'text',
          text: `${text}\n\n用 skill_guide(name) 取某份 skill 的全文。skill 版本独立于指南版本，改 skill 不会把已有页面标为规则落后。`,
        }],
      };
    }
  );

  server.tool(
    'skill_guide',
    '按名读取一份内置 skill 的全文（作业手法与纪律）。名称见 skill_list；读到的正文是工具返回值，无需访问软件安装目录',
    { name: z.string().describe('skill 名称，如 docx-meeting-to-md；用 skill_list 查看可用清单') },
    async ({ name }) => {
      const skill = findSkill(name);
      if (!skill) {
        return {
          content: [{
            type: 'text',
            text: `未找到 skill: ${name}。可用：${SKILLS.map((s) => s.name).join('、')}`,
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: `# ${skill.title}（${skill.name} · v${skill.version}）\n\n${skill.body}`,
        }],
      };
    }
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
