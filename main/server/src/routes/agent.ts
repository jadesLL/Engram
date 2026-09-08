import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { agentWritePage, WriteGateError } from '../pipeline/agentWrite.js';
import {
  deletePageAsAgent, renamePageAsAgent, movePageAsAgent, AgentPageError,
} from '../pipeline/agentDelete.js';
import { enqueuePagePipeline } from '../jobQueue.js';

/**
 * 外部 Agent 的 REST 写入口（CLI `engram pages write|delete|rename|move` 使用）。
 * 与 MCP write_page / delete_page / rename_page / move_page 工具同一内核：
 * 证据逐字校验 + 新建概念/实体页两来源门禁 + 自动操作日志；只允许操作 Wiki/ 下的页面，
 * 删除只做软删除入回收站。
 */
export async function agentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/agent/page', async (req, reply) => {
    const body = (req.body || {}) as {
      path?: string;
      title?: string;
      content?: string;
      type?: string;
      tags?: string[];
      evidence?: Array<{ path: string; quote: string }>;
    };
    if (!body.path || !body.title || !body.content) {
      return reply.code(400).send({ error: 'path / title / content 不能为空' });
    }
    try {
      const result = agentWritePage({
        path: body.path,
        title: body.title,
        content: body.content,
        type: body.type,
        tags: body.tags,
        evidence: body.evidence,
      });
      enqueuePagePipeline(result.meta.id);
      return {
        ok: true,
        meta: result.meta,
        created: result.created,
        evidenceRecorded: result.evidenceRecorded,
        guideVersion: result.guideVersion,
      };
    } catch (error) {
      if (error instanceof WriteGateError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  /** 单页删除（CLI `engram pages delete` 使用）：与 MCP delete_page 同一内核——只入回收站，只删 Wiki/ 页面 */
  app.post('/api/agent/page/delete', async (req, reply) => {
    const body = (req.body || {}) as { titleOrId?: string; id?: string; reason?: string };
    try {
      const result = deletePageAsAgent(String(body.titleOrId || body.id || ''), { reason: body.reason });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof AgentPageError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  /** 单页重命名（CLI `engram pages rename` 使用）：与 MCP rename_page 同一内核——改标题+移动文件+重定向双链 */
  app.post('/api/agent/page/rename', async (req, reply) => {
    const body = (req.body || {}) as { titleOrId?: string; id?: string; newTitle?: string };
    try {
      const result = renamePageAsAgent(String(body.titleOrId || body.id || ''), String(body.newTitle || ''));
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof AgentPageError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  /** 单页移动（CLI `engram pages move` 使用）：与 MCP move_page 同一内核——只在 Wiki 树内移动，可顺带改标题 */
  app.post('/api/agent/page/move', async (req, reply) => {
    const body = (req.body || {}) as { titleOrId?: string; id?: string; dir?: string; newTitle?: string };
    try {
      const result = movePageAsAgent(String(body.titleOrId || body.id || ''), {
        dir: body.dir,
        newTitle: body.newTitle,
      });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof AgentPageError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
}
