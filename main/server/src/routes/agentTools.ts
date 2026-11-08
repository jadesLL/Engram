import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { db } from '../lib/db.js';
import { listTree, readPage, safeJoin } from '../lib/vault.js';
import { isRawPath } from '../lib/rawSections.js';
import { GUIDE_VERSION } from '../content/agentGuide.js';
import { relatedPageData } from '../lib/graphCache.js';
import { resolvePageRef, AgentPageError } from '../pipeline/agentDelete.js';
import { assetMime, isAssetFile, isParentId, parseMediaUrl, safeAssetJoin } from '../lib/pageAssets.js';
import { isInboxPath, isInboxDerivedPath } from '../lib/brainPaths.js';
import { addInboxFile, InboxAddError } from '../pipeline/inboxAdd.js';
import { createRawMaterial, RawMaterialWriteError } from '../pipeline/rawMaterial.js';
import { beginCustomerResearch, submitCustomerResearch, CustomerResearchError } from '../research/customerResearch.js';
import {
  askUserQuestions, formatAskOutcome, AgentQuestionError, type QuestionInput,
} from '../assistant/questions.js';
import { resolveCliRuntime } from '../lib/cliShim.js';
import { requestOrigin } from '../lib/requestOrigin.js';

/**
 * Agent 工具面（CLI / 脚本）的 REST 入口——取代原 MCP /mcp 端点。
 *
 * 设计约束：
 *  - 业务内核一律复用（pipeline/agentWrite、agentDelete、inboxAdd、inboxConvert、
 *    rawMaterial、research/customerResearch、assistant/questions），本文件只做
 *    「参数校验 + 内核调用 + 文本口径」，不复制实现；
 *  - 鉴权统一 requireAuth（owner JWT 与 Agent 令牌都放行）；
 *  - 业务错误按 4xx + {error} 返回（沿用各内核的 Error.status）；
 *    `ask` 的「没有活跃对话」是正常业务结果，走 200 + reason（CLI 据此提示改正文提问）。
 *
 * 对应 CLI 命令见 src/cli/cli.ts；接口清单见 docs/AGENT-CLI-SKILL.md 第 4 节。
 */

/** 原始资料/收集箱里可以直接当图像下发的扩展名（SVG 可携带脚本，不在此列） */
const BINARY_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/** 转成正斜杠、去掉首尾空白的 vault 相对路径 */
function cleanRel(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/** 收集箱/原始资料里的图片 MIME；非图片返回 null（SVG 按二进制处理，不内联渲染） */
function binaryImageMime(rel: string): string | null {
  const ext = path.posix.extname(rel).slice(1).toLowerCase();
  return BINARY_IMAGE_MIME[ext] || null;
}

/** 二进制响应的 Content-Type：图片给准确 MIME，其余统一 octet-stream（由调用方按扩展名落盘） */
function binaryMime(rel: string): string {
  return binaryImageMime(rel) || 'application/octet-stream';
}

function sendBinary(reply: import('fastify').FastifyReply, rel: string, buffer: Buffer) {
  const name = path.posix.basename(rel);
  reply.header('Content-Type', binaryMime(rel));
  reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.send(buffer);
}

export async function agentToolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * 内置 Agent 在 Engram 对话里问用户并阻塞等待点选（CLI `engram ask`）。
   * 没有正在运行的对话时立刻返回 no_active_run（200），让 Agent 改用正文提问，不空等。
   */
  app.post('/api/agent/ask', async (req, reply) => {
    const body = (req.body || {}) as { questions?: unknown; timeoutMs?: unknown };
    const timeoutMs = body.timeoutMs === undefined ? undefined : Number(body.timeoutMs);
    try {
      const outcome = await askUserQuestions({
        questions: body.questions as QuestionInput[],
        timeoutMs: Number.isFinite(timeoutMs as number) ? (timeoutMs as number) : undefined,
      });
      return {
        ok: outcome.ok,
        reason: outcome.reason,
        questions: outcome.questions,
        timeoutMs: outcome.timeoutMs,
        text: formatAskOutcome(outcome),
      };
    } catch (error) {
      if (error instanceof AgentQuestionError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

  /**
   * 知识库目录树（与旧 MCP list_pages 完全同口径：规则版本标注 + 裁剪）。
   * 过滤项可叠加：outdated=只列规则落后的概念/实体页；path=路径前缀；tag=精确匹配一个标签。
   */
  app.get('/api/agent/pages/tree', async (req) => {
    const query = req.query as { outdated?: string; path?: string; tag?: string };
    const outdated = query.outdated === 'true' || query.outdated === '1';
    const prefixNorm = query.path
      ? String(query.path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
      : null;
    let tagPaths: Set<string> | null = null;
    if (query.tag) {
      const rows = db.prepare(`SELECT path, tags FROM pages WHERE deleted = 0`).all() as any[];
      tagPaths = new Set(
        rows
          .filter((row) => {
            try { return (JSON.parse(row.tags || '[]') as string[]).includes(String(query.tag)); } catch { return false; }
          })
          .map((row) => row.path),
      );
    }
    const keepPage = (pagePath: string, guideVersion: number) =>
      (!outdated
        || ((pagePath.startsWith('Wiki/概念/') || pagePath.startsWith('Wiki/实体/'))
          && guideVersion < GUIDE_VERSION))
      && (!prefixNorm || pagePath.startsWith(prefixNorm))
      && (!tagPaths || tagPaths.has(pagePath));
    const prune = (nodes: any[]): any[] =>
      nodes
        .map((node) => (node.children ? { ...node, children: prune(node.children) } : node))
        .filter((node) =>
          node.kind === 'page'
            ? keepPage(node.path, Number(node.guide_version ?? 0))
            : node.kind === 'dir' ? node.children.length > 0 : false);
    const tree = prune(listTree() as any[]);
    const lines: string[] = [];
    const walk = (nodes: any[], depth: number) => {
      for (const node of nodes) {
        const versionTag = node.kind === 'page'
          ? ` · 规则v${node.guide_version ?? 0}${Number(node.guide_version ?? 0) < GUIDE_VERSION ? `（落后，当前 v${GUIDE_VERSION}）` : ''}`
          : '';
        lines.push(`${'  '.repeat(depth)}- ${node.name || node.title || node.path}${node.children ? '/' : ''}${versionTag}`);
        if (node.children) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return { text: lines.join('\n') || '（无匹配页面）' };
  });

  /** 页面图谱关联（相邻页面 + 实体关系）：写「相关页面」章节、验证 [[双链]]、发现反向引用时用 */
  app.get('/api/agent/pages/related', async (req, reply) => {
    const titleOrId = String((req.query as { titleOrId?: string }).titleOrId || '').trim();
    if (!titleOrId) return reply.code(400).send({ error: '缺少 titleOrId（页面标题 / ID / 路径）' });
    let page;
    try {
      page = resolvePageRef(titleOrId);
    } catch (error) {
      if (error instanceof AgentPageError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
    return relatedPageData(page.id);
  });

  /**
   * 页面 / 原始资料正文里的图片原图（`/media/<父项id>/<文件名>`）。
   * 图片是 md 父项的私有资产、没有全局清单：CLI 把它落成临时文件后由 Agent 自己的图片工具读。
   */
  app.get('/api/agent/asset', async (req, reply) => {
    const rawRef = String((req.query as { path?: string }).path || '').trim();
    const parsed = parseMediaUrl(rawRef)
      || (() => {
        const match = rawRef.match(/^assets\/([^/]+)\/([^/]+)$/);
        if (!match || !isParentId(match[1]) || !isAssetFile(match[2])) return null;
        return { parentId: match[1], name: match[2] };
      })();
    if (!parsed) {
      return reply.code(400).send({
        error: `不是本库的图片引用：${rawRef}（应形如 /media/<父项id>/<文件名>）`,
      });
    }
    let abs: string;
    try {
      abs = safeAssetJoin(`${parsed.parentId}/${parsed.name}`);
    } catch {
      return reply.code(400).send({ error: `图片引用路径无效：${rawRef}` });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: `图片不存在：${rawRef}` });
    }
    const mime = assetMime(parsed.name) || 'application/octet-stream';
    if (mime === 'image/svg+xml') {
      return reply.code(400).send({
        error: `该图片是 SVG（可携带脚本，不作为图像内容下发）；原始文件位于 assets/${parsed.parentId}/${parsed.name}`,
      });
    }
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(fs.readFileSync(abs));
  });

  /**
   * 收集箱清单（与 /api/inbox/items、旧 MCP list_inbox 同一份 listInboxItems 口径）。
   * status 默认 all；limit 默认 200、上限 500（与旧 list_inbox 一致）。
   */
  app.get('/api/agent/inbox/items', async (req) => {
    const query = req.query as { status?: string; limit?: string };
    const { listInboxItems } = await import('../lib/inboxItems.js');
    const listing = listInboxItems();
    const wanted = query.status === 'pending' || query.status === 'converted'
      || query.status === 'adopted' ? query.status : 'all';
    const limit = Math.min(Math.max(Math.floor(Number(query.limit) || 200), 1), 500);
    const items = (wanted === 'all' ? listing.items : listing.items.filter((item) => item.status === wanted))
      .slice(0, limit);
    return { counts: listing.counts, status: wanted, limit, items };
  });

  /**
   * 读收集箱里的一份原件：mode=text 给提取文本（图片等 Agent-only 格式回二进制，由 CLI 落文件）；
   * mode=raw 给原字节（图片带准确 MIME）。
   */
  app.get('/api/agent/inbox/item', async (req, reply) => {
    const query = req.query as { path?: string; mode?: string };
    const rel = cleanRel(query.path);
    if (!rel) return reply.code(400).send({ error: '缺少 path（收集箱内的相对路径）' });
    if (!isInboxPath(rel)) return reply.code(400).send({ error: `只能读取 收集箱/ 下的文件：${rel}` });
    let abs: string;
    try {
      abs = safeJoin(rel);
    } catch {
      return reply.code(400).send({ error: `路径无效：${rel}` });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: `文件不存在：${rel}` });
    }
    const raw = String(query.mode || 'text') === 'raw';
    const imageMime = binaryImageMime(rel);
    if (raw || imageMime) return sendBinary(reply, rel, fs.readFileSync(abs));
    try {
      const { extractInboxText } = await import('../pipeline/inboxConvert.js');
      const text = await extractInboxText(rel);
      return { kind: 'text', path: rel, text: `# 原件：${rel}\n\n${text}` };
    } catch (error: any) {
      const { capabilityHint } = await import('../pipeline/inboxConvert.js');
      const hint = capabilityHint(rel);
      if (hint) return reply.code(422).send({ error: `${rel}：${hint}` });
      return reply.code(422).send({
        error: `${rel}：读不到文字层（${error?.message || String(error)}）。可传 mode=raw 取原文件自行处理。`,
      });
    }
  });

  /** 往收集箱新建一份文本原件（用户说「先放进收集箱」时用；不覆盖、不进知识库） */
  app.post('/api/agent/inbox/add', async (req, reply) => {
    const body = (req.body || {}) as { path?: unknown; content?: unknown };
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'path / content 必须是字符串' });
    }
    try {
      const result = addInboxFile({ path: body.path, content: body.content });
      return {
        ok: true,
        ...result,
        text: `已加入收集箱：${result.path}（${result.chars} 字）。它还不属于知识库：不建页面、不进检索、不能作为证据；`
          + '用户在收集箱界面确认「入库」后才会复制进 原始资料/文档/ 并成为可引用来源。'
          + '要写这份原件的转换产物，请用 engram inbox write。',
      };
    } catch (error) {
      if (error instanceof InboxAddError) return reply.code(400).send({ error: `加入收集箱被拒绝：${error.message}` });
      throw error;
    }
  });

  /** 写收集箱原件的转换产物（Agent 语义改写通道；产物仍在收集箱、不入库） */
  app.post('/api/agent/inbox/write', async (req, reply) => {
    const body = (req.body || {}) as {
      path?: unknown; markdown?: unknown; title?: unknown; note?: unknown;
    };
    if (typeof body.path !== 'string' || typeof body.markdown !== 'string') {
      return reply.code(400).send({ error: 'path / markdown 必须是字符串' });
    }
    const rel = cleanRel(body.path);
    if (!isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: `只能写入 收集箱/ 下原件的转换产物：${rel}` });
    }
    if (!fs.existsSync(safeJoin(rel))) return reply.code(404).send({ error: `原件不存在：${rel}` });
    if (!body.markdown.trim()) return reply.code(400).send({ error: 'markdown 不能为空' });
    const { writeInboxMarkdown } = await import('../pipeline/inboxConvert.js');
    const result = writeInboxMarkdown(rel, body.markdown, typeof body.note === 'string' ? body.note : undefined, {
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    return {
      ok: true,
      ...result,
      text: `已写入 ${result.derivedPath}（${result.chars} 字）。产物留在收集箱，未入库；`
        + '请在汇报里说明这份产物还没进知识库，需要用户在界面上确认入库。',
    };
  });

  /**
   * 服务端一键转换收集箱原件（稳定分块，可能数分钟；音视频走视频理解模型）。
   * 产物写在 收集箱/转换结果/：仍不属于知识库，入库由用户确认。
   */
  app.post('/api/agent/inbox/convert', async (req, reply) => {
    const body = (req.body || {}) as { path?: unknown };
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return reply.code(400).send({ error: '缺少 path（收集箱内的原件路径）' });
    }
    const rel = cleanRel(body.path);
    if (!isInboxPath(rel) || isInboxDerivedPath(rel)) {
      return reply.code(400).send({ error: `只能转换 收集箱/ 下的原件（不能是转换产物，也不能是知识库里的文件）：${rel}` });
    }
    let abs: string;
    try {
      abs = safeJoin(rel);
    } catch {
      return reply.code(400).send({ error: `路径无效：${rel}` });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: `原件不存在：${rel}` });
    }
    const {
      capabilityHint, convertCapability, convertInboxItem,
    } = await import('../pipeline/inboxConvert.js');
    const capability = convertCapability(rel);
    // 音视频 / 视频链接：走视频理解模型（模型复用内置 Agent 控制台的 dsh 配置）
    if (capability === 'video') {
      const { videoConfigHint, videoConfigReady } = await import('../lib/videoConfig.js');
      if (!videoConfigReady()) return reply.code(400).send({ error: `${rel}：${videoConfigHint()}` });
      try {
        const { convertVideoInboxItem } = await import('../pipeline/inboxVideo.js');
        const result = await convertVideoInboxItem(rel);
        return {
          ok: true,
          mode: 'video',
          ...result,
          text: `已提炼 ${result.derivedPath}（${result.chars} 字，视频模型 ${result.model}）。产物留在收集箱，未入库；`
            + '请在汇报里说明这份产物还没进知识库，需要用户在界面上确认入库。',
        };
      } catch (error: any) {
        return reply.code(422).send({ error: `${rel}：视频提炼失败：${error?.message || error}` });
      }
    }
    const hint = capabilityHint(rel, capability);
    if (hint) return reply.code(422).send({ error: `${rel}：${hint}` });
    try {
      const result = await convertInboxItem(rel);
      const scope = [
        result.chunks > 1 ? `分 ${result.chunks} 段转换` : '',
        result.truncated ? '原件过长：本次只覆盖前面部分（产物「待确认」里会注明）' : '',
      ].filter(Boolean).join('；');
      return {
        ok: true,
        mode: 'convert',
        ...result,
        text: `已转换 ${rel} → ${result.derivedPath}\n`
          + `- 产物：${result.derivedPath}（${result.chars} 字${scope ? `；${scope}` : ''}）\n`
          + `- 模型：${result.model}\n`
          + '产物仍在收集箱（收集箱/转换结果/），仍不属于知识库：不建页面、不进检索、不能当证据；'
          + '需要用户在收集箱界面确认「入库」后才会复制进 原始资料/文档/ 并成为可引用来源。'
          + '要总结时可直接 engram inbox read 读产物路径；不要自行入库或拿它写页面。',
      };
    } catch (error: any) {
      return reply.code(422).send({ error: `转换失败：${error?.message || String(error)}` });
    }
  });

  /**
   * 新建原始资料 Markdown（调研成果 / 用户零散笔记）：只创建、不覆盖，不接受 对话/ 与旧目录。
   */
  app.post('/api/agent/raw-material', async (req, reply) => {
    const body = (req.body || {}) as { path?: unknown; content?: unknown };
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'path / content 必须是字符串' });
    }
    try {
      const result = createRawMaterial({ path: body.path, content: body.content });
      return {
        ok: true,
        ...result,
        text: `已新建原始资料：${result.path}（${result.title}，id: ${result.id}）。`
          + '该文件可用 engram files list / engram files read 查看；已有文件不会被覆盖。',
      };
    } catch (error) {
      if (error instanceof RawMaterialWriteError) {
        return reply.code(400).send({ error: `新建原始资料失败：${error.message}` });
      }
      throw error;
    }
  });

  /**
   * 读一份原始资料（与旧 MCP read_raw_file 同口径）：
   * mode=text（默认）→ md 给 readPage 正文（带 # 标题），其余给 files 表提取文本，没有文字层给可读提示；
   * mode=raw → 原字节（图片带准确 MIME，其余 octet-stream）。只允许 原始资料/ 下的路径。
   */
  app.get('/api/agent/file', async (req, reply) => {
    const query = req.query as { path?: string; mode?: string };
    const rel = cleanRel(query.path);
    if (!rel) return reply.code(400).send({ error: '缺少 path' });
    if (!isRawPath(rel)) return reply.code(400).send({ error: `只能读取 原始资料/ 下的文件：${rel}` });
    let abs: string;
    try {
      abs = safeJoin(rel);
    } catch {
      return reply.code(400).send({ error: `路径无效：${rel}` });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: `文件不存在：${rel}` });
    }
    const ext = path.posix.extname(rel).slice(1).toLowerCase();
    if (String(query.mode || 'text') === 'raw') return sendBinary(reply, rel, fs.readFileSync(abs));
    if (['md', 'markdown'].includes(ext)) {
      const page = readPage(rel);
      const text = page ? `# ${page.meta.title}\n\n${page.content}` : fs.readFileSync(abs, 'utf8');
      return { kind: 'text', path: rel, text };
    }
    const file = db.prepare(`SELECT text FROM files WHERE path = ? AND deleted = 0`).get(rel) as
      | { text?: string }
      | undefined;
    const text = file?.text?.trim();
    if (text) return { kind: 'text', path: rel, text };
    return {
      kind: 'text',
      path: rel,
      text: '该文件尚无提取文本（可能是图片或无文字层的扫描件）。'
        + '用 engram files raw <path> --out <file> 取原文件内容，由你自行识别。',
    };
  });

  /** 客户调研：建立任务并取得最新流程 / 主体核验契约 / 报告模板（CLI `research begin`） */
  app.post('/api/agent/research/begin', async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    try {
      return beginCustomerResearch({
        customer: body.customer as string,
        scope: body.scope as string | undefined,
        save: body.save as boolean | undefined,
        saveMode: body.saveMode as string | undefined,
        overwritePath: body.overwritePath as string | undefined,
        client: body.client as string | undefined,
        timeZone: body.timeZone as string | undefined,
      });
    } catch (error) {
      if (error instanceof CustomerResearchError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

  /** 客户调研：提交报告（identity / sections / sources / save...；CLI `research submit`） */
  app.post('/api/agent/research/submit', async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.taskId !== 'string' || !body.taskId.trim()) {
      return reply.code(400).send({ error: '缺少 taskId（research begin 返回的 taskId）' });
    }
    try {
      return submitCustomerResearch({
        taskId: body.taskId,
        identity: body.identity,
        sections: body.sections,
        sources: body.sources,
        save: body.save as boolean | undefined,
        saveMode: body.saveMode as string | undefined,
        overwritePath: body.overwritePath as string | undefined,
      });
    } catch (error) {
      if (error instanceof CustomerResearchError || error instanceof RawMaterialWriteError) {
        const status = error instanceof CustomerResearchError ? error.status : 400;
        return reply.code(status).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * CLI 源码（远程客户端下载后 `node engram.js login ...` 即可用）。
   * dist/cli/cli.js 是自包含单文件（CLI 内不留相对导入，见 src/cli/cli.ts 头部说明），
   * 直接按原文下发；dist 不存在时给出构建提示。
   */
  app.get('/api/agent/cli', async (_req, reply) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      // 生产：dist/routes/agentTools.js → dist/cli/cli.js
      path.join(here, '../cli/cli.js'),
      // 开发/测试（tsx 直接跑 src）：src/routes/agentTools.ts → server/dist/cli/cli.js
      path.join(here, '../../dist/cli/cli.js'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      return reply.code(500).send({
        error: 'CLI 源文件不存在：请先构建 server（pnpm --filter @engram/server build）后重试',
        candidates,
      });
    }
    reply.header('Content-Type', 'text/javascript; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return reply.send(fs.readFileSync(found, 'utf8'));
  });

  /** 本机 Agent 接入信息（界面「远程接入」与排查用）：连接地址 + CLI 运行时 + 配置路径 + 令牌名 */
  app.get('/api/agent/info', async (req) => {
    const origin = requestOrigin(req) || `http://${req.headers.host || '127.0.0.1'}`;
    let cli: Record<string, unknown>;
    try {
      const runtime = resolveCliRuntime();
      cli = {
        command: runtime.command,
        shimPath: runtime.shimPath,
        nodePath: runtime.nodePath,
        scriptPath: runtime.scriptPath,
        available: runtime.available,
        ...(runtime.error ? { error: runtime.error } : {}),
      };
    } catch (error) {
      cli = { available: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      url: origin,
      cli,
      configPath: path.join(os.homedir(), '.engram', 'config.json'),
      tokenName: 'cli',
    };
  });
}
