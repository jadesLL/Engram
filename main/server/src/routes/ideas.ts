import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { generateIdeaTitle, writeIdeaNote, type IdeaTitle } from '../lib/ideaNote.js';

/** 单条灵感正文上限：对话框里随手写；到这个量级该走「新建资料」而不是速记 */
const MAX_IDEA_CHARS = 20_000;

export interface IdeaRouteDeps {
  /** 仅供测试注入：正文 → 标题（默认走内置 Agent 模型，失败回落规则标题，见 lib/ideaNote.ts） */
  generateTitle?: (content: string) => Promise<IdeaTitle>;
}

/**
 * 记一条灵感：用户在对话框里写正文，服务端拟标题后落到 `原始资料/灵感碎片/`。
 *
 * 与 `/api/files/create` 的分工：那个是「先有名字再写内容」（新建空文件），
 * 这个是「只有内容、名字由 Engram 拟」——所以标题生成放在同一个请求里，
 * 前端不必先问标题再建文件（也就不会出现「标题 = 用户输入的第一句话」）。
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
    const { title, source } = await (deps.generateTitle ?? generateIdeaTitle)(body);
    const created = writeIdeaNote({ title, content: body });
    return { ok: true, ...created, title, titleSource: source };
  });
}
