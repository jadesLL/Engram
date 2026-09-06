import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import {
  getZcodeConfig,
  zcodeInstalled,
  zcodeCliConfigPath,
  zcodeMcpUrl,
} from '../assistant/zcodeRuntime.js';
import { requireAuth } from './auth.js';
import {
  getActiveChat,
  probeImageInput,
  testConnection,
  testModel,
  type ModelEntry,
} from '../lib/llm.js';
import {
  activeModelId,
  listModelEntries,
  maskEntryKey,
  resolveEntrySecretKey,
  revealModelKey,
  saveModelConfig,
  setActiveModelId,
  type ModelKind,
} from '../lib/modelConfig.js';
import { MODEL_CATALOG } from '../lib/modelCatalog.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { discoverModels } from '../lib/modelDiscovery.js';
import { wipeAiLogsAndRelations, wipeKnowledgeData } from '../lib/dataCleanup.js';
import { clearLlmUsage, summarizeLlmUsage } from '../lib/llmUsage.js';
import { withJobsStopped } from '../jobs.js';
import { fetchTenantAccessToken, clearTokenCache } from '../im/feishu/token.js';
import { getFeishuConfig, isFeishuConfigured } from '../im/feishu/config.js';
import { getFeishuLongConnStatus, restartFeishuLongConn } from '../im/feishu/longconn.js';
import { getDdnsConfig, getDdnsStatus, kickDdns, syncDdnsRecord } from '../lib/ddns.js';

const PUBLIC_SETTINGS = [
  'dream_cron', 'dream_enabled',
  'acs_mode',
  'feishu_config',
  'ddns_config',
  'zcode_config',
];

/** 从活跃 embedding 条目同步 embedding_dim（驱动 vec 表维度） */
function syncEmbeddingDim(): { dim: number; changed: boolean } {
  const active = listModelEntries('embedding')
    .find((entry) => entry.id === activeModelId('embedding'))
    || listModelEntries('embedding')[0];
  const dim = active?.dim || 1536;
  const prev = getSetting('embedding_dim') || '1536';
  setSetting('embedding_dim', String(dim));
  return { dim, changed: prev !== String(dim) };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/settings', async () => {
    const out: Record<string, string> = {};
    for (const k of PUBLIC_SETTINGS) out[k] = getSetting(k) || '';
    return { settings: out };
  });

  // ---------- 模型配置（model_entries 表；key 脱敏下发，保存时空 key 沿用库中原值） ----------

  app.get('/api/settings/models', async () => {
    return {
      chat: listModelEntries('chat').map(maskEntryKey),
      embedding: listModelEntries('embedding').map(maskEntryKey),
      document: listModelEntries('document').map(maskEntryKey),
      rerank: listModelEntries('rerank').map(maskEntryKey),
      activeChat: activeModelId('chat'),
      activeEmbedding: activeModelId('embedding'),
      activeDocument: activeModelId('document'),
      activeRerank: activeModelId('rerank'),
    };
  });

  app.put('/api/settings/models', async (req) => {
    const body = (req.body || {}) as {
      chat?: ModelEntry[];
      embedding?: ModelEntry[];
      document?: ModelEntry[];
      rerank?: ModelEntry[];
      activeChat?: string;
      activeEmbedding?: string;
      activeDocument?: string;
      activeRerank?: string;
    };
    saveModelConfig(body);
    const { changed } = syncEmbeddingDim();
    // 维度变化 → 自动后台重建全部索引（vec 表换维度后旧向量已失效）
    if (changed) {
      void rebuildAll((msg) => app.log.info(`[auto-rebuild] ${msg}`))
        .then((r) => app.log.info(`[auto-rebuild] done: ${JSON.stringify(r)}`))
        .catch((e) => app.log.error(`[auto-rebuild] failed: ${e.message}`));
    }
    return { ok: true, dimChanged: changed };
  });

  /** 查看条目完整 API Key（列表通道只下发掩码） */
  app.get('/api/settings/models/:id/key', async (req, reply) => {
    const { id } = req.params as { id: string };
    const key = revealModelKey(id);
    if (key === undefined) return reply.code(404).send({ error: '模型条目不存在' });
    return { apiKey: key };
  });

  /** 服务端厂商目录（预设服务商、线路与模型；前端仅做展示） */
  app.get('/api/settings/model-catalog', async () => {
    return { providers: MODEL_CATALOG };
  });

  app.get('/api/settings/llm-usage', async (req) => {
    const { days } = (req.query || {}) as { days?: string };
    return summarizeLlmUsage(Number(days) || 7);
  });

  app.delete('/api/settings/llm-usage', async () => {
    return { ok: true, deleted: clearLlmUsage() };
  });

  app.put('/api/settings', async (req) => {
    const body = req.body as Record<string, unknown>;
    const prevAcsMode = getSetting('acs_mode') || 'standard';
    for (const k of PUBLIC_SETTINGS) {
      const v = body[k];
      if (v === undefined) continue;
      // JSON 类配置（*_models / feishu_config）客户端可能直接传数组/对象而非 JSON 字符串；
      // String(v) 会把条目变成 "[object Object]" 损坏配置，统一在这里序列化兜底。
      setSetting(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    // 飞书凭证变更后清除 token 缓存并用新凭证重连长连接，无需重启服务
    if (body['feishu_config'] !== undefined) {
      clearTokenCache();
      restartFeishuLongConn();
    }
    // DDNS 配置变更后立即到期，下个 30s tick 内按新配置执行
    if (body['ddns_config'] !== undefined) {
      kickDdns();
    }
    const { changed } = syncEmbeddingDim();
    // 维度变化 → 自动后台重建全部索引（vec 表换维度后旧向量已失效）
    if (changed) {
      void rebuildAll((msg) => app.log.info(`[auto-rebuild] ${msg}`))
        .then((r) => app.log.info(`[auto-rebuild] done: ${JSON.stringify(r)}`))
        .catch((e) => app.log.error(`[auto-rebuild] failed: ${e.message}`));
    }
    // 信捷模式切换不触发批量重综合：模式在下次整页综合时自然生效，避免切换即全量 LLM 开销。
    const nextAcsMode = (body.acs_mode !== undefined ? String(body.acs_mode) : prevAcsMode) || 'standard';
    return { ok: true, dimChanged: changed, acsModeChanged: nextAcsMode !== prevAcsMode };
  });

  /** 测试连接。
   *  - 无入参：测试当前激活的 chat + embedding（兼容旧的全局测试按钮）。
   *  - 带 { entry, kind }：测试单个模型配置（不依赖激活状态，用于逐个验证）。 */
  app.post('/api/settings/test-llm', async (req) => {
    const body = req.body as { entry?: ModelEntry; kind?: 'chat' | 'embedding' | 'document' | 'rerank' } | null;
    if (body?.entry && body?.kind) {
      return testModel(body.entry, body.kind);
    }
    return testConnection();
  });

  /** 飞书长连接状态查询：配置是否完整、连接是否建立、最近事件/错误时间。 */
  app.get('/api/settings/feishu-status', async () => {
    const cfg = getFeishuConfig();
    return {
      configured: isFeishuConfigured(),
      appId: cfg.appId ? `${cfg.appId.slice(0, 6)}…` : '',
      apiBase: cfg.apiBase,
      longConn: getFeishuLongConnStatus(),
    };
  });

  /** 测试飞书连接：用传入凭证换取 tenant_access_token，验证 appId/appSecret 是否有效。 */
  app.post('/api/settings/test-feishu', async (req, reply) => {
    const body = (req.body || {}) as { appId?: string; appSecret?: string; apiBase?: string };
    if (!body.appId || !body.appSecret) {
      return reply.code(400).send({ ok: false, error: 'App ID 和 App Secret 不能为空' });
    }
    try {
      const token = await fetchTenantAccessToken({
        appId: body.appId,
        appSecret: body.appSecret,
        apiBase: body.apiBase || 'https://open.feishu.cn',
      });
      return { ok: true, token: token.slice(0, 8) + '…' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** DDNS 同步状态：配置是否完整、上次执行结果与下次执行时间。 */
  app.get('/api/settings/ddns-status', async () => {
    const cfg = getDdnsConfig();
    return {
      configured: Boolean(cfg.token && cfg.record),
      enabled: cfg.enabled,
      record: cfg.record,
      type: cfg.type,
      intervalMin: cfg.intervalMin,
      status: getDdnsStatus(),
    };
  });

  /** 立即检测 DDNS（dryRun：探测本机 IP 并与 Cloudflare 比对，不写入）。token 传掩码时沿用库中原值。 */
  app.post('/api/settings/test-ddns', async (req) => {
    const body = (req.body || {}) as { token?: string; record?: string; type?: string };
    const stored = getDdnsConfig();
    const typeRaw = String(body.type || '').toLowerCase();
    const cfg = {
      ...stored,
      enabled: true,
      token: !body.token || body.token.includes('*') ? stored.token : body.token.trim(),
      record: (body.record || stored.record).trim().toLowerCase(),
      type: typeRaw === 'a' ? ('A' as const) : typeRaw === 'aaaa' ? ('AAAA' as const) : typeRaw === 'auto' ? ('auto' as const) : stored.type,
    };
    if (!cfg.token) return { ok: false, error: '缺少 Cloudflare API Token' };
    if (!cfg.record) return { ok: false, error: '缺少记录域名' };
    const r = await syncDdnsRecord(cfg, { dryRun: true });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, record: r.record, type: r.type, detectedIp: r.ip, dnsIp: r.dnsIp, outcome: r.outcome };
  });

  app.post('/api/settings/discover-models', async (req, reply) => {
    const body = (req.body || {}) as {
      baseUrl?: string;
      modelsUrl?: string;
      apiKey?: string;
      /** 已存条目 id：apiKey 为掩码/留空时按 id 补全库中原值 */
      entryId?: string;
      kind?: 'chat' | 'embedding' | 'document' | 'rerank';
      /** 模型列表接口协议（anthropic 用 x-api-key 头）与匿名访问标志：由前端按当前线路提供 */
      modelsProtocol?: 'openai' | 'anthropic';
      anonymous?: boolean;
    };
    if (!['chat', 'embedding', 'document', 'rerank'].includes(body.kind || '')) {
      return reply.code(400).send({ error: '模型类型无效' });
    }
    let apiKey = body.apiKey;
    if ((!apiKey || apiKey.includes('*')) && body.entryId) {
      apiKey = revealModelKey(body.entryId);
    }
    try {
      return await discoverModels({
        baseUrl: body.baseUrl,
        modelsUrl: body.modelsUrl,
        apiKey,
        kind: body.kind as 'chat' | 'embedding' | 'document' | 'rerank',
        ...(body.modelsProtocol ? { modelsProtocol: body.modelsProtocol } : {}),
        ...(body.anonymous !== undefined ? { anonymous: body.anonymous } : {}),
      });
    } catch (error: any) {
      return reply.code(502).send({ error: error?.message || '模型列表拉取失败' });
    }
  });

  app.post('/api/settings/probe-image-input', async (req, reply) => {
    const body = (req.body || {}) as { entry?: ModelEntry; force?: boolean };
    const entry = body.entry || getActiveChat();
    if (!entry) return reply.code(400).send({ error: '尚未配置对话模型' });
    // 前端带回的 apiKey 可能是掩码：按 id 补全原值后再探测
    return probeImageInput({ ...entry, apiKey: resolveEntrySecretKey(entry) }, { force: body.force === true });
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

  // ---------- ZCode 引擎（桌面端独占：凭据按设备加密，容器内无 CLI）----------

  /** 检测本机 ZCode 安装/登录状态与当前引擎配置 */
  app.get('/api/settings/zcode-status', async () => {
    const config = getZcodeConfig();
    const installed = zcodeInstalled(config);
    let loggedIn = false;
    try {
      const credentials = JSON.parse(fs.readFileSync(
        path.join(os.homedir(), '.zcode', 'v2', 'credentials.json'), 'utf8'
      ) as string);
      loggedIn = Object.keys(credentials).some((key) => key.startsWith('oauth:'));
    } catch { /* 无凭据文件视为未登录 */ }
    let registered = false;
    try {
      const cliConfig = JSON.parse(fs.readFileSync(zcodeCliConfigPath(), 'utf8') as string);
      registered = Boolean(cliConfig?.mcp?.servers?.engram);
    } catch { /* 无配置文件视为未注册 */ }
    return { installed, loggedIn, registered, mode: config.mode, path: config.path, enabled: config.enabled };
  });

  /** 把 Engram MCP（回环地址 + Bearer token）注册进 ZCode 的 cli/config.json */
  app.post('/api/settings/zcode-register', async () => {
    let token = (db.prepare(`SELECT token FROM mcp_tokens WHERE name = 'zcode'`).get() as any)?.token;
    if (!token) {
      token = `lwiki_${crypto.randomBytes(24).toString('hex')}`;
      db.prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
        .run(token, 'zcode', now());
    }
    const configPath = zcodeCliConfigPath();
    let cliConfig: any = {};
    try { cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf8') as string); } catch { /* 新建 */ }
    cliConfig.mcp = cliConfig.mcp || {};
    cliConfig.mcp.servers = cliConfig.mcp.servers || {};
    cliConfig.mcp.servers.engram = {
      url: zcodeMcpUrl,
      headers: { Authorization: `Bearer ${token}` },
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cliConfig, null, 2));
    return { ok: true, mcpUrl: zcodeMcpUrl };
  });

  app.post('/api/settings/zcode-unregister', async () => {
    const configPath = zcodeCliConfigPath();
    try {
      const cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf8') as string);
      if (cliConfig?.mcp?.servers?.engram) {
        delete cliConfig.mcp.servers.engram;
        fs.writeFileSync(configPath, JSON.stringify(cliConfig, null, 2));
      }
    } catch { /* 无配置文件时无需移除 */ }
    db.prepare(`DELETE FROM mcp_tokens WHERE name = 'zcode'`).run();
    return { ok: true };
  });

  // ---------- desktop tokens（桌面端远端连接令牌）----------
  app.get('/api/settings/desktop-tokens', async () => {
    const rows = db
      .prepare(
        `SELECT id, token, name, created_at, expires_at, revoked, last_used_at
         FROM desktop_tokens ORDER BY id`
      )
      .all();
    return { tokens: rows };
  });

  app.post('/api/settings/desktop-tokens', async (req) => {
    const { name } = (req.body || {}) as { name?: string };
    const token = `lwid_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const r = db
      .prepare(
        `INSERT INTO desktop_tokens(token, name, created_at, expires_at) VALUES(?, ?, ?, ?)`
      )
      .run(token, name || 'default', now(), expiresAt);
    return { id: Number(r.lastInsertRowid), token, expires_at: expiresAt };
  });

  app.delete('/api/settings/desktop-tokens/:id', async (req) => {
    const { id } = req.params as { id: string };
    // 撤销而非物理删除，保留审计记录；已撤销令牌不可再兑换
    db.prepare(`UPDATE desktop_tokens SET revoked = 1 WHERE id = ?`).run(id);
    return { ok: true };
  });

  /** 一键清除：删除知识正文、整理报告、入库记录与派生索引，保留配置/认证/系统日志。清除后后台全量重建索引，接口快速返回，避免长耗时操作阻塞容器健康探针。 */
  app.post('/api/settings/wipe', async (req, reply) => {
    const { password } = (req.body || {}) as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const { result, cancelledJobs } = await withJobsStopped(() => wipeKnowledgeData({ rebuild: false }));
    // 全量重建在后台进行，与 /api/settings/rebuild-index 同为 fire-and-forget。
    void rebuildAll()
      .then((r) => app.log.info(`[wipe-rebuild] done: ${JSON.stringify(r)}`))
      .catch((e) => app.log.error(`[wipe-rebuild] failed: ${e?.message}`));
    return { ok: true, ...result, cancelledJobs };
  });

  /** 清空 AI 整理日志、操作日志与关系库，保留知识正文。需密码校验。 */
  app.post('/api/settings/wipe-ai-logs', async (req, reply) => {
    const { password } = (req.body || {}) as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const { result, cancelledJobs } = await withJobsStopped(wipeAiLogsAndRelations);
    return { ok: true, ...result, cancelledJobs };
  });
}
