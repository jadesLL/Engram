import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import JSZip from 'jszip';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import { DATA_DIR, BRAIN_DIR } from '../config.js';
import { RESTORE_STAGING_NAME } from '../lib/stagedRestore.js';
import {
  getZcodeConfig,
  zcodeInstalled,
  resolveZcodeEnginePath,
  zcodeCliConfigPath,
  zcodeMcpUrl,
} from '../lib/zcodeConfig.js';
import { getDshStatus, registerDshMcp, unregisterDshMcp } from '../lib/dshConfig.js';
import { requireAuth } from './auth.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { wipeAiLogsAndRelations, wipeKnowledgeData } from '../lib/dataCleanup.js';
import { withJobsStopped } from '../jobs.js';
import { getDdnsConfig, getDdnsStatus, kickDdns, syncDdnsRecord } from '../lib/ddns.js';

const PUBLIC_SETTINGS = [
  'zcode_config',
  'ddns_config',
  'search_synonyms',
];

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/settings', async () => {
    const out: Record<string, string> = {};
    for (const k of PUBLIC_SETTINGS) out[k] = getSetting(k) || '';
    return { settings: out };
  });

  app.put('/api/settings', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    // DDNS 仅中枢设备可开启（UI 已按角色隐藏，这里兜底拦 API 直调）
    if (body['ddns_config'] !== undefined) {
      let incoming: Record<string, unknown> = {};
      try {
        incoming = JSON.parse(String(body['ddns_config'])) as Record<string, unknown>;
      } catch { /* 非法 JSON 交由原样保存 */ }
      if (incoming.enabled === true && getSetting('sync_role') !== 'hub') {
        return reply.code(400).send({ error: '仅中枢设备可开启 DDNS' });
      }
    }
    for (const k of PUBLIC_SETTINGS) {
      const v = body[k];
      if (v === undefined) continue;
      setSetting(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    // DDNS 配置变更后立即到期，下个 30s tick 内按新配置执行
    if (body['ddns_config'] !== undefined) {
      kickDdns();
    }
    return { ok: true };
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

  /** 全量重建索引（异步执行，立即返回） */
  app.post('/api/settings/rebuild-index', async () => {
    void rebuildAll((msg) => app.log.info(`[rebuild] ${msg}`))
      .then((r) => app.log.info(`[rebuild] done: ${JSON.stringify(r)}`))
      .catch((e) => app.log.error(`[rebuild] failed: ${e.message}`));
    return { ok: true };
  });

  // ---------- MCP tokens（同时授权 /mcp 端点与 REST API Bearer）----------

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

  // ---------- ZCode / Agent 接入（一键把 Engram MCP 注册进 ZCode）----------

  /** 检测本机 ZCode 安装/登录状态与 MCP 注册状态 */
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
    return { installed, loggedIn, registered, path: resolveZcodeEnginePath(config) };
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
    try { cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* 新建 */ }
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

  // ---------- DeepSeek Harness（dsh）接入（写 $DSH_HOME/cordis.patch.yml）----------

  app.get('/api/settings/dsh-status', async () => getDshStatus());

  app.post('/api/settings/dsh-register', async () => {
    let token = (db.prepare(`SELECT token FROM mcp_tokens WHERE name = 'dsh'`).get() as any)?.token;
    if (!token) {
      token = `lwiki_${crypto.randomBytes(24).toString('hex')}`;
      db.prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
        .run(token, 'dsh', now());
    }
    const patchPath = registerDshMcp(zcodeMcpUrl, token);
    return { ok: true, mcpUrl: zcodeMcpUrl, patchPath };
  });

  app.post('/api/settings/dsh-unregister', async () => {
    unregisterDshMcp();
    db.prepare(`DELETE FROM mcp_tokens WHERE name = 'dsh'`).run();
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
    return { id: Number(r.lastInsertRowid), token, expiresAt: expiresAt };
  });

  app.delete('/api/settings/desktop-tokens/:id', async (req) => {
    const { id } = req.params as { id: string };
    // 撤销而非物理删除，保留审计记录；已撤销令牌不可再兑换
    db.prepare(`UPDATE desktop_tokens SET revoked = 1 WHERE id = ?`).run(id);
    return { ok: true };
  });

  /** 一键清除：删除知识正文、整理报告、入库记录与派生索引，保留配置/认证/系统日志。清除后后台全量重建索引，接口快速返回，避免长耗时操作阻塞容器健康探针。 */
  /** 整库备份：wiki.db 一致性快照 + brain/ 全量（不含回收站）打包下载。 */
  app.get('/api/settings/backup', async (_req, reply) => {
    // VACUUM INTO 生成含全部已提交数据的一致性快照，不碰在线库；同盘临时文件，打包后即删
    const snapshot = path.join(DATA_DIR, `wiki.db.backup-${process.pid}`);
    try {
      fs.rmSync(snapshot, { force: true });
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } catch (e: any) {
      return reply.code(500).send({ error: `数据库快照失败：${e?.message}` });
    }
    try {
      const zip = new JSZip();
      zip.file('wiki.db', fs.readFileSync(snapshot));
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          if (name === '.trash') continue; // 回收站不入备份
          const abs = path.join(dir, name);
          const rel = path.relative(BRAIN_DIR, abs).replace(/\\/g, '/');
          if (fs.statSync(abs).isDirectory()) walk(abs);
          else zip.file(`brain/${rel}`, fs.readFileSync(abs));
        }
      };
      if (fs.existsSync(BRAIN_DIR)) walk(BRAIN_DIR);
      const buf = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      const zipName = `engram-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
      reply.header('Content-Length', buf.length);
      return reply.send(buf);
    } finally {
      fs.rmSync(snapshot, { force: true });
    }
  });

  /** 整库恢复：校验备份 zip 后解压到 .restore-staging，进程下次启动时换入（见 lib/stagedRestore.ts），不动运行中的数据。需密码校验。 */
  app.post('/api/settings/restore', async (req, reply) => {
    let zipBuffer: Buffer | null = null;
    let password = '';
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'password') password = String(part.value ?? '');
      } else if (part.type === 'file') {
        zipBuffer = await part.toBuffer();
      }
    }
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    if (!zipBuffer || !zipBuffer.length) {
      return reply.code(400).send({ error: '未选择备份文件' });
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBuffer);
    } catch {
      return reply.code(400).send({ error: '备份文件无法解析（需要 zip 格式）' });
    }
    if (!zip.file('wiki.db')) {
      return reply.code(400).send({ error: '备份缺少 wiki.db，不是有效的 Engram 整库备份' });
    }
    const staging = path.join(DATA_DIR, RESTORE_STAGING_NAME);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    let extracted = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      // 白名单 + 越界拒绝：只接受 wiki.db 与 brain/ 前缀内的规范路径
      const name = entry.name.replace(/\\/g, '/');
      const segments = name.split('/');
      if (segments.some((s) => s === '..' || s === '')) continue;
      if (name !== 'wiki.db' && segments[0] !== 'brain') continue;
      const abs = path.join(staging, ...segments);
      if (!abs.startsWith(staging + path.sep)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, await entry.async('nodebuffer'));
      extracted++;
    }
    if (extracted === 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      return reply.code(400).send({ error: '备份内容为空' });
    }
    return { ok: true, needsRestart: true, files: extracted };
  });

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
