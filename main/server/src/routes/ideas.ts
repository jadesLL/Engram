import type { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { draftIdeaNote, summarizeFixes, writeIdeaNote, type IdeaNoteDraft } from '../lib/ideaNote.js';

/** 单条灵感正文上限：对话框里随手写；到这个量级该走「新建资料」而不是速记 */
const MAX_IDEA_CHARS = 20_000;
/** 调用方回传摘要的长度上限：它只进操作日志一行，够写清「改了哪几处、精炼了多少字」即可 */
const MAX_NOTE_CHARS = 200;

export interface IdeaRouteDeps {
  /** 仅供测试注入：正文 → 标题 + 勘误与精炼后的正文（默认走 lib/ideaNote.ts 的链路与内置 Agent 模型） */
  draftNote?: (content: string) => Promise<IdeaNoteDraft>;
}

/** 正文校验：空与超长是接口级错误，两个入口共用同一套口径 */
function ideaContent(raw: unknown): { text: string } | { error: string; code: 400 | 413 } {
  const text = String(raw ?? '').trim();
  if (!text) return { error: '还没有写内容', code: 400 };
  if (text.length > MAX_IDEA_CHARS) {
    return { error: `这条灵感有 ${text.length} 字，太长记不下，请改用「新建资料」`, code: 413 };
  }
  return { text };
}

/** 调用方回传的摘要（预览那一步的勘误/精炼明细）：单行化、去自带括号、截断，再套上括号 */
function ideaNoteSuffix(raw: unknown): string {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[（(]+/, '')
    .replace(/[）)]+$/, '')
    .trim()
    .slice(0, MAX_NOTE_CHARS);
  return text ? `（${text}）` : '';
}

/**
 * 记一条灵感：用户在对话框里写正文，Engram 勘误专名、把错别字/语序/啰嗦处整理精炼、拟标题，
 * 最后落到 `原始资料/灵感碎片/`。
 *
 * 与 `/api/files/create` 的分工：那个是「先有名字再写内容」（新建空文件），
 * 这个是「只有内容、名字由 Engram 拟」——所以标题生成放在同一个请求里，
 * 前端不必先问标题再建文件（也就不会出现「标题 = 用户输入的第一句话」）。
 *
 * 勘误（lib/textFix.ts）只改有明确依据的写法；精炼（lib/ideaPolish.ts 验收）是把用户的原文
 * 换成另一段文字。两者都改在**落盘前**：已有资料一个字节都不动（动它会牵动 source_versions
 * 与证据投影）。因为精炼是改写，流程拆成两段——`/api/ideas/preview` 只算不写，用户看过定稿
 * （标题与正文都能改）再调 `/api/ideas` 落盘，避免模型改错一处就固化进原始资料。
 */
export async function ideaRoutes(app: FastifyInstance, deps: IdeaRouteDeps = {}) {
  // 手机端（Android 本地服务）只有同步成员令牌，却要能用「记一条灵感」——它与收集箱同属内容面，
  // 走 requireAssistantAccess（成员 token 或 owner / MCP token），不再是仅 owner 的 requireAuth。
  app.addHook('preHandler', requireAssistantAccess);

  const draft = deps.draftNote ?? draftIdeaNote;

  /** 预览：勘误 + 精炼 + 拟标题，但不落盘（定稿交用户确认） */
  app.post('/api/ideas/preview', async (req, reply) => {
    const checked = ideaContent(((req.body ?? {}) as { content?: unknown }).content);
    if ('error' in checked) return reply.code(checked.code).send({ error: checked.error });

    const drafted = await draft(checked.text);
    return {
      ok: true,
      title: drafted.title,
      titleSource: drafted.titleSource,
      text: drafted.text,
      fixes: drafted.fixes.map((fix) => ({ wrong: fix.wrong, right: fix.right, kind: fix.kind ?? null })),
      pending: drafted.pending,
      refined: drafted.refined,
    };
  });

  /**
   * 落盘。两种调用方式：
   *  - 带 title 字段（**哪怕是空串**）：预览确认路径——content 是用户确认（可能改过）的定稿，
   *    落盘即所见即所得；空标题由 ideaFileTitle 退化成「随手记」；
   *  - 完全没有 title 字段：一次到底路径（脚本、老客户端、手机端窄代理）——服务端跑完整链路后落盘。
   * 按「字段在不在」而不是「值空不空」区分：用户在预览里清空标题，不该被当成没确认、再跑一次模型。
   */
  app.post('/api/ideas', async (req, reply) => {
    const body = (req.body ?? {}) as { content?: unknown; title?: unknown; note?: unknown };
    const checked = ideaContent(body.content);
    if ('error' in checked) return reply.code(checked.code).send({ error: checked.error });

    if (typeof body.title === 'string') {
      const title = body.title.trim();
      const created = writeIdeaNote({ title, content: checked.text, note: ideaNoteSuffix(body.note) });
      // 回报用户确认过的标题（不带日期前缀），toast 直接用它；空标题时用落盘实际用的那个
      const shown = title || created.pageTitle.replace(/^\d{4}\.\d{2}\.\d{2}_/, '');
      return { ok: true, ...created, title: shown };
    }

    const drafted = await draft(checked.text);
    const created = writeIdeaNote({
      title: drafted.title,
      content: drafted.text,
      note: summarizeFixes(drafted.fixes, drafted.pending, drafted.refined),
    });
    return {
      ok: true,
      ...created,
      title: drafted.title,
      titleSource: drafted.titleSource,
      fixes: drafted.fixes.map((fix) => ({ wrong: fix.wrong, right: fix.right, kind: fix.kind ?? null })),
      pending: drafted.pending,
      refined: drafted.refined,
    };
  });
}
