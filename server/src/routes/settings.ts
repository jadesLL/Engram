import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import { requireAuth } from './auth.js';
import { testConnection, testModel, type ModelEntry } from '../lib/llm.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { safeJoin, writePage } from '../lib/vault.js';
import { ensureDirs } from '../config.js';
import { appendWikiLog, regenerateIndex, regenerateRelationships } from '../pipeline/indexFile.js';

const PUBLIC_SETTINGS = [
  'chat_models', 'active_chat_model',
  'embedding_models', 'active_embedding_model',
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
    const body = req.body as { entry?: ModelEntry; kind?: 'chat' | 'embedding' } | null;
    if (body?.entry && body?.kind) {
      return testModel(body.entry, body.kind);
    }
    return testConnection();
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

  /** 一键清除：删除全部概念/实体/原始资料（含归档/查询），保留目录结构与系统页/日志。
   *  需密码校验。前端二次确认。 */
  app.post('/api/settings/wipe', async (req, reply) => {
    const { password } = (req.body || {}) as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }

    // 清除的目录（删除目录下所有文件，保留空目录）
    const wipeDirs = ['原始资料', 'Wiki/概念', 'Wiki/实体', 'Wiki/归档', 'Wiki/查询'];
    let fileCount = 0;
    for (const rel of wipeDirs) {
      const abs = safeJoin(rel);
      if (!fs.existsSync(abs)) continue;
      for (const entry of fs.readdirSync(abs)) {
        const p = path.join(abs, entry);
        try {
          if (fs.statSync(p).isFile()) {
            fs.unlinkSync(p);
            fileCount++;
          }
        } catch {
          /* 单文件失败不阻塞 */
        }
      }
    }

    // 确保目录结构完整（重建被清空的空目录）
    ensureDirs();

    // 清除相关 DB 索引（pages/files/chunks/edges/entities/ingest_log），
    // 保留系统页（Wiki/index.md / log.md / 关系/relationships.md）与 AIWorks 日志
    db.prepare(`DELETE FROM chunks`).run();
    db.prepare(`DELETE FROM vec_chunks`).run();
    db.prepare(`DELETE FROM edges`).run();
    db.prepare(`DELETE FROM entities`).run();
    db.prepare(`DELETE FROM ingest_log`).run();
    db.prepare(`DELETE FROM files`).run();
    db.prepare(`DELETE FROM pages_fts`).run();
    db.prepare(`DELETE FROM files_fts`).run();
    // pages：删除已清空目录的页面，保留系统页
    db.prepare(
      `DELETE FROM pages WHERE path LIKE '原始资料/%' OR path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%' OR path LIKE 'Wiki/归档/%' OR path LIKE 'Wiki/查询/%'`
    ).run();
    // 重新扫描重建系统页（index.md/log.md/relationships.md）索引
    try {
      await rebuildAll();
    } catch {
      /* 重建失败不影响清除结果 */
    }
    // 重生成自维护系统页：清除后库已空，index.md 与 relationships.md 重置为空状态
    try {
      regenerateIndex();
      regenerateRelationships();
    } catch {
      /* 系统页重生成失败不影响清除结果 */
    }

    appendWikiLog('清除', `一键清除 ${fileCount} 个文件（概念/实体/原始资料/归档/查询），已重置索引`);

    return { ok: true, fileCount };
  });

  /** 清空 AI 整理日志：删除 AIWorks/log/ 下所有文件，保留目录。需密码校验。 */
  app.post('/api/settings/wipe-ai-logs', async (req, reply) => {
    const { password } = (req.body || {}) as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const abs = safeJoin('AIWorks/log');
    let fileCount = 0;
    if (fs.existsSync(abs)) {
      for (const entry of fs.readdirSync(abs)) {
        const p = path.join(abs, entry);
        try {
          if (fs.statSync(p).isFile()) {
            fs.unlinkSync(p);
            fileCount++;
          }
        } catch {
          /* 单文件失败不阻塞 */
        }
      }
    }
    // 删除这些日志页的 DB 索引（pages/chunks/edges/FTS）
    const logIds = db.prepare(`SELECT id FROM pages WHERE path LIKE 'AIWorks/log/%'`).all() as { id: string }[];
    if (logIds.length) {
      const ids = logIds.map((r) => r.id);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM pages WHERE id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM pages_fts WHERE page_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM chunks WHERE ref_type = 'page' AND ref_id IN (${ph})`).run(...ids);
      const ph2 = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM edges WHERE src_page IN (${ph}) OR dst_page IN (${ph2})`).run(...ids, ...ids);
    }
    // 操作日志也一并清空：重置 log.md 为初始状态（仅保留本次清空记录，避免审计完全断裂）
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const resetLog = `# 操作日志\n\n- ${stamp} 清除：重置操作日志${fileCount ? `（并清空 ${fileCount} 个残留 AI 日志文件）` : ''}\n`;
    writePage('Wiki/log.md', resetLog, { title: '操作日志', type: 'doc' });
    // 重生成索引（AIWorks/log 页面已消失，index.md 需同步）
    try {
      regenerateIndex();
    } catch {
      /* 索引重生成失败不阻塞 */
    }
    return { ok: true, fileCount };
  });
}
