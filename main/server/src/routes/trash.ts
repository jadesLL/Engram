import { FastifyInstance } from 'fastify';
import { enqueue, enqueuePagePipeline } from '../jobs.js';
import {
  emptyTrash,
  listTrashItems,
  permanentlyDeleteTrashItem,
  publicTrashItem,
  restoreTrashItem,
} from '../lib/trash.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { scheduleFileExtraction, supportsFileExtraction } from '../pipeline/fileExtraction.js';
import { requireAuth } from './auth.js';

function requestedIds(body: unknown): string[] {
  const ids: unknown[] = Array.isArray((body as any)?.ids) ? (body as any).ids : [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 500);
}

function detail(items: { name: string; path?: string; originalPath?: string }[]): string {
  return items
    .map((item) => item.path ? `「${item.name}」→ ${item.path}` : `「${item.name}」（${item.originalPath || ''}）`)
    .join('；');
}

export async function trashRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/trash', async () => {
    const items = listTrashItems();
    return {
      items: items.map(publicTrashItem),
      count: items.length,
      totalSize: items.reduce((sum, item) => sum + item.size, 0),
    };
  });

  app.post('/api/trash/restore', async (req, reply) => {
    const ids = requestedIds(req.body);
    if (!ids.length) return reply.code(400).send({ error: '请选择要恢复的项目' });
    const restored: ReturnType<typeof restoreTrashItem>[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        const item = restoreTrashItem(id);
        restored.push(item);
        if (item.pageId) enqueuePagePipeline(item.pageId);
        if (item.fileId) {
          if (supportsFileExtraction(item.path)) {
            scheduleFileExtraction(item.path, { mode: 'auto', ingestAfter: true });
          } else {
            enqueue('index_file', { fileId: item.fileId });
          }
        }
      } catch (error: any) {
        errors.push({ id, error: error?.message || String(error) });
      }
    }
    if (restored.length) appendWikiLog('恢复', detail(restored));
    return { restored, errors };
  });

  app.delete('/api/trash', async (req, reply) => {
    const ids = requestedIds(req.body);
    if (!ids.length) return reply.code(400).send({ error: '请选择要永久删除的项目' });
    const deleted: ReturnType<typeof publicTrashItem>[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        deleted.push(publicTrashItem(permanentlyDeleteTrashItem(id)));
      } catch (error: any) {
        errors.push({ id, error: error?.message || String(error) });
      }
    }
    if (deleted.length) appendWikiLog('永久删除', detail(deleted));
    return { deleted, errors };
  });

  app.delete('/api/trash/all', async () => {
    const result = emptyTrash();
    if (result.deleted.length) {
      appendWikiLog('清空回收站', `永久删除 ${result.deleted.length} 个项目`);
    }
    return {
      deleted: result.deleted.map(publicTrashItem),
      errors: result.errors,
    };
  });
}
