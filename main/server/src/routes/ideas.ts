import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { draftIdeaNote, writeIdeaNote, type IdeaNoteDraft } from '../lib/ideaNote.js';

/** 单条灵感正文上限：对话框里随手写；到这个量级该走「新建资料」而不是速记 */
const MAX_IDEA_CHARS = 20_000;

export interface IdeaRouteDeps {
  /** 仅供测试注入：正文 → 标题 + 勘误后正文（默认走 lib/ideaNote.ts 的勘误链路与内置 Agent 模型） */
  draftNote?: (content: string) => Promise<IdeaNoteDraft>;
}

/**
 * 记一条灵感：用户在对话框里写正文，服务端勘误 + 拟标题后落到 `原始资料/灵感碎片/`。
 *
 * 与 `/api/files/create` 的分工：那个是「先有名字再写内容」（新建空文件），
 * 这个是「只有内容、名字由 Engram 拟」——所以标题生成放在同一个请求里，
 * 前端不必先问标题再建文件（也就不会出现「标题 = 用户输入的第一句话」）。
 *
 * 勘误（lib/textFix.ts）只改有明确依据的写法，且改在**落盘前**：已有资料一个字节都不动
 * （动它会牵动 source_versions 与证据投影）。响应带上改了哪几处，前端提示、日志留痕。
 */
export async function ideaRoutes(app: FastifyInstance, deps: IdeaRouteDeps = {}) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/ideas', async (req, reply) => {
    const { content } = (req.body ?? {}) as { content?: unknown };
    const body = String(content ?? '').trim();
    if (!body) return reply.code(400).send({ error: '还没有写内容' });
    if (body.length > MAX_IDEA_CHARS) {
      return reply.code(413).send({ error: `这条灵感有 ${body.length} 字，太长记不下，请改用「新建资料」` });
    }
    const drafted = await (deps.draftNote ?? draftIdeaNote)(body);
    const created = writeIdeaNote({
      title: drafted.title,
      content: drafted.text,
      fixes: drafted.fixes,
      pending: drafted.pending,
    });
    return {
      ok: true,
      ...created,
      title: drafted.title,
      titleSource: drafted.titleSource,
      fixes: drafted.fixes.map((fix) => ({ wrong: fix.wrong, right: fix.right, kind: fix.kind ?? null })),
      pending: drafted.pending,
    };
  });
}
