import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { writeAssist, WriterAction } from '../ai/writer.js';
import { organizePage } from '../ai/organize.js';
import { sse } from '../lib/sse.js';
import { enqueue } from '../jobs.js';
import { ingestAllRaw } from '../pipeline/ingest.js';
import { buildIngestCoverage, pathsNeedingIngest } from '../pipeline/ingestCoverage.js';
import { safeJoin } from '../lib/vault.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractionDetails,
  extractionIsCurrent,
  scheduleFileExtraction,
  supportsFileExtraction,
} from '../pipeline/fileExtraction.js';

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
    const { path: p, force = false } = req.body as { path?: string; force?: boolean };
    if (!p || !p.startsWith('原始资料/')) {
      return reply.code(400).send({ error: '只能整理原始资料目录下的文件' });
    }
    const ext = path.posix.extname(p).slice(1).toLowerCase();
    let abs: string;
    try { abs = safeJoin(p); } catch { return reply.code(400).send({ error: '文件路径无效' }); }
    const directlySupported = ['md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx'].includes(ext);
    if ((!directlySupported && !supportsFileExtraction(p)) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(400).send({ error: '该文件格式暂不支持 AI 整理' });
    }
    if (supportsFileExtraction(p)) {
      const extraction = extractionDetails(p);
      if (extraction?.status === 'completed' && extractionIsCurrent(p)) {
        const jobId = enqueue('ingest', {
          path: p,
          revision: extraction.updatedAt,
          ...(force ? { force: true } : {}),
        });
        return { ok: true, jobId: jobId || null };
      }
      const scheduled = scheduleFileExtraction(p, {
        mode: extraction ? 'continue' : 'auto',
        ingestAfter: true,
        forceIngest: force,
      });
      return reply.code(202).send({ ok: true, jobId: scheduled.jobId || null, extractionQueued: true });
    }
    const jobId = enqueue('ingest', { path: p, ...(force ? { force: true } : {}) });
    return { ok: true, jobId: jobId || null };
  });

  /** 整理全部原始资料 */
  app.post('/api/ai/ingest-all', async (req) => {
    const { force = false } = (req.body || {}) as { force?: boolean };
    const paths = await ingestAllRaw();
    const jobIds = paths.map((p) =>
      supportsFileExtraction(p)
        ? scheduleFileExtraction(p, { mode: 'auto', ingestAfter: true, forceIngest: force }).jobId
        : enqueue('ingest', { path: p, ...(force ? { force: true } : {}) })
    ).filter((id): id is number => Boolean(id));
    return { ok: true, queued: jobIds.length, jobIds };
  });

  /** 提炼覆盖率:全部原始资料按状态分组,回答「哪些文件真的被提炼了」 */
  app.get('/api/ingest/coverage', async () => buildIngestCoverage());

  /** 一键补齐:只入队需要处理的(失败/未整理/提取未完成/已过期),已整理且未变更的跳过 */
  app.post('/api/ingest/coverage/retry', async () => {
    const paths = pathsNeedingIngest();
    const jobIds = paths.map((p) =>
      supportsFileExtraction(p)
        ? scheduleFileExtraction(p, { mode: 'auto', ingestAfter: true }).jobId
        : enqueue('ingest', { path: p })
    ).filter((id): id is number => Boolean(id));
    return { ok: true, queued: jobIds.length, total: paths.length, jobIds };
  });
}
