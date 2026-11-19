import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { agentWritePage, WriteGateError } from '../pipeline/agentWrite.js';
import {
  deletePageAsAgent, renamePageAsAgent, movePageAsAgent, AgentPageError,
} from '../pipeline/agentDelete.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { insertAtPosition, PositionRefError } from '../assistant/positions.js';

/**
 * Agent 的 REST 写入口（CLI `engram pages write|insert|delete|rename|move` 使用）。
 * 与 CLI `engram pages write|delete|rename|move` 同一内核：
 * 证据逐字校验 + 新建概念/实体页两来源门禁 + 自动操作日志；整页写入只允许 Wiki/ 页面，
 * 删除只做软删除入回收站。`pages insert` 只接受内置 Agent 的位置令牌（pos_xxx），
 * 原始资料 Markdown 也只能在这一条令牌流程里被局部追加，整页写入仍拒绝。
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

  /**
   * 按位置令牌插入正文（CLI `engram pages insert <token>` 使用）。
   * 令牌来自用户在编辑器里引用的光标位置；这里按锚点原文重新定位块，页面被改动就拒绝。
   */
  app.post('/api/agent/page/insert', async (req, reply) => {
    const body = (req.body || {}) as { token?: string; content?: string };
    try {
      const result = insertAtPosition(String(body.token || ''), String(body.content || ''));
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof PositionRefError || error instanceof WriteGateError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  /** 单页删除（CLI `engram pages delete` 使用）：与 CLI `engram pages delete` 同一内核——只入回收站，只删 Wiki/ 页面 */
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

  /** 单页重命名（CLI `engram pages rename` 使用）：与 CLI `engram pages rename` 同一内核——改标题+移动文件+重定向双链 */
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

  /** 单页移动（CLI `engram pages move` 使用）：与 CLI `engram pages move` 同一内核——只在 Wiki 树内移动，可顺带改标题 */
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
