import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { writeAssist, WriterAction } from '../ai/writer.js';
import { organizePage } from '../ai/organize.js';
import { sse } from '../lib/sse.js';
import { enqueue } from '../jobs.js';
import { ingestAllRaw } from '../pipeline/ingest.js';
import { safeJoin } from '../lib/vault.js';
import fs from 'node:fs';
import path from 'node:path';

const ACTIONS: WriterAction[] = ['continue', 'polish', 'summarize', 'translate', 'expand'];

export async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** AI 写作助手（SSE 流式） */
  app.post('/api/ai/write', async (req, reply) => {
    const { action, text } = req.body as { action?: WriterAction; text?: string };
    const stream = sse(reply);
    if (!action || !ACTIONS.includes(action) || !text?.trim()) {
      stream.send('error', { message: '参数错误' });
      stream.close();
      return;
    }
    try {
      await writeAssist(action, text, (delta) => stream.send('delta', { text: delta }));
      stream.send('done', {});
    } catch (e: any) {
      stream.send('error', { message: e.message || 'AI 处理失败' });
    }
    stream.close();
  });

  /** 手动触发单页自动整理 */
  app.post('/api/ai/organize/:pageId', async (req) => {
    const { pageId } = req.params as { pageId: string };
    enqueue('summarize', { pageId });
    enqueue('extract', { pageId });
    return { ok: true };
  });

  /** 立即整理（同步，用于测试/小页面） */
  app.post('/api/ai/organize-now/:pageId', async (req) => {
    const { pageId } = req.params as { pageId: string };
    await organizePage(pageId);
    return { ok: true };
  });

  /** 整理单个原始资料文件（提炼概念/实体页到 Wiki） */
  app.post('/api/ai/ingest', async (req, reply) => {
    const { path: p } = req.body as { path?: string };
    if (!p || !p.startsWith('原始资料/')) {
      return reply.code(400).send({ error: '只能整理原始资料目录下的文件' });
    }
    const ext = path.posix.extname(p).slice(1).toLowerCase();
    let abs: string;
    try { abs = safeJoin(p); } catch { return reply.code(400).send({ error: '文件路径无效' }); }
    if (!['md', 'markdown', 'docx', 'xlsx', 'pptx'].includes(ext) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(400).send({ error: '仅支持整理存在的 md / docx / xlsx / pptx 文件' });
    }
    enqueue('ingest', { path: p });
    return { ok: true };
  });

  /** 整理全部原始资料 */
  app.post('/api/ai/ingest-all', async () => {
    const paths = await ingestAllRaw();
    for (const p of paths) enqueue('ingest', { path: p });
    return { ok: true, queued: paths.length };
  });
}
