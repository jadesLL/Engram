import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import { requireAuth } from './auth.js';
import {
  getActiveChat,
  probeImageInput,
  testConnection,
  testModel,
  type ModelEntry,
} from '../lib/llm.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { discoverModels } from '../lib/modelDiscovery.js';
import { wipeAiLogsAndRelations, wipeKnowledgeData } from '../lib/dataCleanup.js';
import { clearLlmUsage, summarizeLlmUsage } from '../lib/llmUsage.js';

const PUBLIC_SETTINGS = [
  'chat_models', 'active_chat_model',
  'embedding_models', 'active_embedding_model',
  'document_models', 'active_document_model',
  'dream_cron', 'dream_enabled',
];

/** 从活跃 embedding 条目同步 embedding_dim（驱动 vec 表维度） */
function syncEmbeddingDim(): { dim: number; changed: boolean } {
  try {
    const list = JSON.parse(getSetting('embedding_models') || '[]');
    const activeId = getSetting('active_embedding_model');
    const active = list.find((m: any) => m.id === activeId) || list[0];
    const dim = active?.dim || 1536;
    const prev = getSetting('embedding_dim') || '1536';
    setSetting('embedding_dim', String(dim));
    return { dim, changed: prev !== String(dim) };
  } catch {
    return { dim: 1536, changed: false };
  }
}

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/settings', async () => {
    const out: Record<string, string> = {};
    for (const k of PUBLIC_SETTINGS) out[k] = getSetting(k) || '';
    return { settings: out };
  });

  app.get('/api/settings/llm-usage', async (req) => {
    const { days } = (req.query || {}) as { days?: string };
    return summarizeLlmUsage(Number(days) || 7);
  });

  app.delete('/api/settings/llm-usage', async (_req, reply) => {
    const active = db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'running')`)
      .get() as { count: number };
    if (active.count > 0) {
      return reply.code(409).send({ error: '仍有 AI 任务待执行或运行中，请等待任务完成后再清除模型用量' });
    }
    return { ok: true, deleted: clearLlmUsage() };
  });

  app.put('/api/settings', async (req) => {
    const body = req.body as Record<string, string>;
    for (const k of PUBLIC_SETTINGS) {
      if (body[k] !== undefined) setSetting(k, String(body[k]));
    }
    const { changed } = syncEmbeddingDim();
    // 维度变化 → 自动后台重建全部索引（vec 表换维度后旧向量已失效）
    if (changed) {
      void rebuildAll((msg) => app.log.info(`[auto-rebuild] ${msg}`))
        .then((r) => app.log.info(`[auto-rebuild] done: ${JSON.stringify(r)}`))
        .catch((e) => app.log.error(`[auto-rebuild] failed: ${e.message}`));
    }
    return { ok: true, dimChanged: changed };
  });

  /** 测试连接。
   *  - 无入参：测试当前激活的 chat + embedding（兼容旧的全局测试按钮）。
   *  - 带 { entry, kind }：测试单个模型配置（不依赖激活状态，用于逐个验证）。 */
  app.post('/api/settings/test-llm', async (req) => {
    const body = req.body as { entry?: ModelEntry; kind?: 'chat' | 'embedding' | 'document' } | null;
    if (body?.entry && body?.kind) {
      return testModel(body.entry, body.kind);
    }
    return testConnection();
  });

  app.post('/api/settings/discover-models', async (req, reply) => {
    const body = (req.body || {}) as {
      baseUrl?: string;
      apiKey?: string;
      kind?: 'chat' | 'embedding' | 'document';
    };
    if (!['chat', 'embedding', 'document'].includes(body.kind || '')) {
      return reply.code(400).send({ error: '模型类型无效' });
    }
    try {
      return await discoverModels({
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        kind: body.kind as 'chat' | 'embedding' | 'document',
      });
    } catch (error: any) {
      return reply.code(502).send({ error: error?.message || '模型列表拉取失败' });
    }
  });

  app.post('/api/settings/probe-image-input', async (req, reply) => {
    const body = (req.body || {}) as { entry?: ModelEntry; force?: boolean };
    const entry = body.entry || getActiveChat();
    if (!entry) return reply.code(400).send({ error: '尚未配置对话模型' });
    return probeImageInput(entry, { force: body.force === true });
  });

  /** 全量重建索引（异步执行，立即返回） */
  app.post('/api/settings/rebuild-index', async () => {
    void rebuildAll((msg) => app.log.info(`[rebuild] ${msg}`))
      .then((r) => app.log.info(`[rebuild] done: ${JSON.stringify(r)}`))
      .catch((e) => app.log.error(`[rebuild] failed: ${e.message}`));
    return { ok: true };
  });

  // ---------- MCP tokens ----------
  app.get('/api/settings/mcp-tokens', async () => {
    const rows = db.prepare(`SELECT id, token, name, created_at FROM mcp_tokens ORDER BY id`).all();
    return { tokens: rows };
  });

  app.post('/api/settings/mcp-tokens', async (req) => {
    const { name } = (req.body || {}) as { name?: string };
    const token = `lwiki_${crypto.randomBytes(24).toString('hex')}`;
    const r = db
      .prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
      .run(token, name || 'default', now());
    return { id: Number(r.lastInsertRowid), token };
  });

  app.delete('/api/settings/mcp-tokens/:id', async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`DELETE FROM mcp_tokens WHERE id = ?`).run(id);
    return { ok: true };
  });

  /** 一键清除：删除知识正文、整理报告、入库记录与派生索引，保留配置/认证/系统日志。 */
  app.post('/api/settings/wipe', async (req, reply) => {
    const { password } = (req.body || {}) as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const running = db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'`)
      .get() as { count: number };
    if (running.count > 0) {
      return reply.code(409).send({ error: '仍有 AI 任务正在运行，请等待任务完成后再清除' });
    }
    return { ok: true, ...(await wipeKnowledgeData()) };
  });

  /** 清空 AI 整理日志、操作日志与关系库，保留知识正文。需密码校验。 */
  app.post('/api/settings/wipe-ai-logs', async (req, reply) => {
    const { password } = (req.body || {}) as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const active = db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'running')`)
      .get() as { count: number };
    if (active.count > 0) {
      return reply.code(409).send({ error: '仍有 AI 任务待执行或运行中，请等待任务完成后再清空日志与关系库' });
    }
    return { ok: true, ...(await wipeAiLogsAndRelations()) };
  });
}
