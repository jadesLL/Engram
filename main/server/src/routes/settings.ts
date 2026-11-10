import { stampPreference } from '../sync/preferences.js';
import { currentNodeId } from '../sync/store.js';
import { recordLocalChange } from '../sync/index.js';
import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
// JSZip 只在整库备份/恢复时用：类型走 import type，实例与 loadAsync 在 handler 里动态 import
import type JSZip from 'jszip';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import { DATA_DIR, BRAIN_DIR } from '../config.js';
import { RESTORE_STAGING_NAME } from '../lib/stagedRestore.js';
import { isNestedVaultPath } from '../lib/brainPaths.js';
import {
  agentClients,
  isAgentClientId,
  registerAgentAccess,
  unregisterAgentAccess,
} from '../lib/agentAccess.js';
import { cliConfigPath, resolveCliRuntime } from '../lib/cliShim.js';
import {
  CUSTOMER_RESEARCH_SKILL,
  CUSTOMER_RESEARCH_SKILL_NAME,
  ENGRAM_SKILL,
  ENGRAM_SKILL_NAME,
  renderSkillText,
} from '../content/agentSkill.js';
import { requireAuth } from './auth.js';
import { rebuildAll } from '../pipeline/indexer.js';
import { wipeAiLogsAndRelations, wipeKnowledgeData } from '../lib/dataCleanup.js';
import { withJobsStopped } from '../jobs.js';
import { applyVideoConfigInput, normalizeStoredVideoConfig, videoConfigForClient } from '../lib/videoConfig.js';
import {
  DDNS_SETTINGS_KEY,
  clampInterval,
  getDdnsConfig,
  getDdnsStatus,
  kickDdns,
  listCloudflareZones,
  normalizeRecord,
  syncDdnsRecord,
  verifyCloudflareToken,
  type DdnsConfig,
} from '../lib/ddns.js';

const PUBLIC_SETTINGS = [
  'zcode_config',
  'ddns_config',
  'search_synonyms',
  // 专名勘误表（每行 `错写=正写`）：记灵感的落盘前勘误无条件照它改。
  // 编辑界面属 P3，先支持接口写入（见 lib/textFix.ts 的 parseFixTable）。
  'name_fixes',
  // 界面偏好：侧栏是否显示「AI 工作区」（服务端自动生成的日志/索引/关系库）。
  // 用户日常不需要看这些内容，默认隐藏；'1' 才显示。
  'show_ai_workspace',
  // 界面偏好：首页自定义看板布局（JSON 字符串，形如 {"version":1,"modules":[...]}）。
  // 服务端只按白名单原样存取、不校验 JSON：前端 lib/homeBoard.ts 负责解析与归一化，
  // 缺省（''）或写坏的内容一律由前端回退默认布局，因此这里不做特判。
  'home_layout',
  'theme',
  'editor_mode',
  // 收集箱「视频链接 → 提炼」的视频理解总开关（JSON：只有 enabled）。
  // 2026-11 起模型/API Key 复用内置 Agent 控制台的 dsh 模型配置（见 lib/videoModel.ts），
  // 这里不再存 baseUrl/apiKey/model；旧 JSON 里的这些字段在读取时被忽略。
  'video_config',
];

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** DDNS 只在中枢设备上有意义（只有中枢能把自己的公网 IP 写进域名）：UI 已按角色隐藏，这里兜底拦 API 直调 */
  function isHubDevice(): boolean {
    return getSetting('sync_role') === 'hub';
  }

  app.get('/api/settings', async () => {
    const out: Record<string, string> = {};
    for (const k of PUBLIC_SETTINGS) {
      const raw = getSetting(k) || '';
      // 视频配置只回 enabled（模型/Key 在 dsh 配置里，面板用 /api/inbox/video-status 的 hasKey 判断）；
      // v1.5.1 起视频配置另有独立读写口 /api/settings/video-config（手机成员令牌可用），
      // 这里保留旧口径兼容旧客户端。
      if (k === 'video_config') {
        // 旧 JSON 归一化（清掉 baseUrl/apiKey 等历史字段）：必须先归一化再 stamp，避免旧 Key 被同步出去
        if (normalizeStoredVideoConfig()) {
          stampPreference(k, currentNodeId());
          recordLocalChange('preference', k);
        }
        out[k] = videoConfigForClient();
      } else {
        out[k] = raw;
      }
    }
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
      if (incoming.enabled === true && !isHubDevice()) {
        return reply.code(400).send({ error: '仅中枢设备可开启 DDNS' });
      }
    }
    for (const k of PUBLIC_SETTINGS) {
      const v = body[k];
      if (v === undefined) continue;
      if (k === 'video_config') {
        // 视频配置走归一化保存：只认 enabled，旧客户端的 baseUrl/apiKey/model 字段被忽略。
        // 与 /api/settings/video-config 共用同一套解析/保存语义（见 lib/videoConfig.ts）。
        const { changed } = applyVideoConfigInput(v);
        if (changed) {
          stampPreference(k, currentNodeId());
          recordLocalChange('preference', k);
        }
        continue;
      }
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      if (getSetting(k) === text) continue;
      setSetting(k, text);
      stampPreference(k, currentNodeId());
      recordLocalChange('preference', k);
    }
    // DDNS 配置变更后立即到期，下个 30s tick 内按新配置执行
    if (body['ddns_config'] !== undefined) {
      kickDdns();
    }
    return { ok: true };
  });

  /**
   * DDNS 状态：配置是否完整、上次执行结果、下次执行时间，
   * 外加「到底能不能用」的判据——zone 生效状态、公共解析核验（live）、每族明细与处置建议。
   */
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
      record: normalizeRecord(body.record || stored.record),
      type: typeRaw === 'a' ? ('A' as const) : typeRaw === 'aaaa' ? ('AAAA' as const) : typeRaw === 'auto' ? ('auto' as const) : stored.type,
    };
    if (!cfg.token) return { ok: false, error: '缺少 Cloudflare API Token' };
    if (!cfg.record) return { ok: false, error: '缺少记录域名' };
    const r = await syncDdnsRecord(cfg, { dryRun: true });
    // 检测结果带上 zone 状态与公共解析核验：界面据此说清「记录对上了但外网查不到」这类情况
    if (!r.ok) {
      return { ok: false, error: r.error, outcome: r.outcome, zone: r.zone, hint: r.hint, families: r.families };
    }
    return {
      ok: true,
      record: r.record,
      type: r.type,
      types: r.types,
      detectedIp: r.ip,
      dnsIp: r.dnsIp,
      outcome: r.outcome,
      live: r.live,
      resolver: r.resolver,
      zone: r.zone,
      families: r.families,
      hint: r.hint,
    };
  });

  /**
   * 一键配置·第一步：校验 Token 并列出它名下可维护的域名（zone）。
   * 用户不必知道 FQDN / zone 这些概念——粘一个 Token，从列表里选一个域名就行。
   * 失败要带 code：`token`=Token 本身有问题，`no-domain`=客户还没买域名（界面据此醒目引导购买与绑定），
   * `permission`=权限不足，`network`=网络/Cloudflare 侧问题——不能都含糊成一句「失败」。
   */
  app.post('/api/settings/ddns/discover', async (req, reply) => {
    if (!isHubDevice()) return reply.code(400).send({ error: '仅中枢设备可配置 DDNS', code: 'not-hub' });
    const { token } = (req.body || {}) as { token?: string };
    const value = String(token || '').trim();
    if (!value) return reply.code(400).send({ error: '请先填入 Cloudflare API Token', code: 'no-token' });
    const verified = await verifyCloudflareToken(value);
    if (!verified.ok) return { ok: false, code: 'token', error: verified.error };
    const listed = await listCloudflareZones(value);
    if (!listed.ok) return { ok: false, code: listed.code, error: listed.error };
    const current = getDdnsConfig();
    return { ok: true, zones: listed.zones, record: current.record, type: current.type };
  });

  /**
   * 一键配置·第二步：一次调用完成「探测本机公网 IP → 与 Cloudflare 现值比对 → 保存 → 立即执行」。
   * 先 dryRun（不写 DNS）；失败默认不落库（避免把写错的 Token / 域名留在设置里反复重试），
   * 确认要继续时传 force=true。等价于设置页里勾启用 + 填四个字段 + 保存 + 等一轮。
   */
  app.post('/api/settings/ddns/setup', async (req, reply) => {
    if (!isHubDevice()) return reply.code(400).send({ error: '仅中枢设备可配置 DDNS', code: 'not-hub' });
    const body = (req.body || {}) as {
      token?: string;
      record?: string;
      type?: string;
      intervalMin?: number;
      force?: boolean;
    };
    const stored = getDdnsConfig();
    const token = String(body.token || '').trim() || stored.token;
    // 用户常直接粘浏览器地址或带端口：统一归一化成纯 FQDN 再比对/落库
    const record = normalizeRecord(body.record);
    const typeRaw = String(body.type || 'auto').trim().toLowerCase();
    const type: DdnsConfig['type'] = typeRaw === 'a' ? 'A' : typeRaw === 'aaaa' ? 'AAAA' : 'auto';
    if (!token) return reply.code(400).send({ error: '缺少 Cloudflare API Token' });
    if (!record) return reply.code(400).send({ error: '缺少记录域名' });

    const cfg: DdnsConfig = {
      enabled: true,
      token,
      record,
      type,
      intervalMin: clampInterval(body.intervalMin ?? stored.intervalMin),
    };
    const probe = await syncDdnsRecord(cfg, { dryRun: true });
    if (!probe.ok && !body.force) {
      return reply.code(400).send({
        error: probe.error || '检测失败',
        record,
        detectedIp: probe.ip,
        dnsIp: probe.dnsIp,
        outcome: probe.outcome,
        zone: probe.zone,
        hint: probe.hint,
      });
    }
    setSetting(DDNS_SETTINGS_KEY, JSON.stringify({
      enabled: true,
      token,
      record,
      type: type.toLowerCase(),
      intervalMin: cfg.intervalMin,
    }));
    // 保存后立刻到期：下个 30 秒 tick 内按新配置执行，用户不用等一个完整周期
    kickDdns();
    // 域名没生效（NS 未切到 Cloudflare）也算配置成功：记录先写好，zone 一变 active 就自动发布；
    // 界面据 outcome=zone-pending + hint 告诉用户该去注册商把 NS 换成哪两条。
    return {
      ok: true,
      saved: true,
      record,
      type: probe.type,
      types: probe.types,
      detectedIp: probe.ip,
      dnsIp: probe.dnsIp,
      outcome: probe.outcome,
      live: probe.live,
      resolver: probe.resolver,
      zone: probe.zone,
      families: probe.families,
      hint: probe.hint,
      error: probe.error,
    };
  });

  // ---------- Agent 令牌（沿用 mcp_tokens 表：历史表名不改，避免迁移风险；语义已泛化为「Agent 令牌」） ----------

  /** Agent 令牌：CLI / 外部 Agent 访问 REST API 的 Bearer Token（表名与旧版一致，仅界面文案改「Agent 令牌」） */
  app.get('/api/settings/agent-tokens', async () => {
    const rows = db.prepare(`SELECT id, token, name, created_at FROM mcp_tokens ORDER BY id`).all();
    return { tokens: rows };
  });

  app.post('/api/settings/agent-tokens', async (req) => {
    const { name } = (req.body || {}) as { name?: string };
    const token = `lwiki_${crypto.randomBytes(24).toString('hex')}`;
    const r = db
      .prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
      .run(token, name || 'default', now());
    return { id: Number(r.lastInsertRowid), token };
  });

  app.delete('/api/settings/agent-tokens/:id', async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`DELETE FROM mcp_tokens WHERE id = ?`).run(id);
    return { ok: true };
  });

  // ---------- Agent 接入（CLI + skill；不再写任何客户端的 MCP 配置） ----------

  /**
   * 本机 CLI 运行时 + 各客户端检测 + 两份 skill 正文。
   * skills 里的 {{ENGRAM}} 已换成实际调用命令，供设置页「复制入口 skill」与展示；正文不含令牌。
   */
  app.get('/api/settings/agent-access', async () => {
    const cli = resolveCliRuntime();
    const command = cli.available ? cli.command : 'engram';
    return {
      clients: agentClients(os.homedir(), { runtime: cli }),
      cli,
      configPath: cliConfigPath(),
      skillCommand: command,
      skills: {
        engram: { name: ENGRAM_SKILL_NAME, body: renderSkillText(ENGRAM_SKILL, command) },
        customerResearch: {
          name: CUSTOMER_RESEARCH_SKILL_NAME,
          body: renderSkillText(CUSTOMER_RESEARCH_SKILL, command),
        },
      },
    };
  });

  /** 一键接入：写本机 engram 包装脚本 + 安装 skill（不写客户端 MCP 配置） */
  app.post('/api/settings/agent-access/register', async (req, reply) => {
    const { id } = (req.body || {}) as { id?: string };
    if (!id || !isAgentClientId(id)) return reply.code(400).send({ error: '未知客户端' });
    try {
      return { ok: true, ...registerAgentAccess(id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 移除接入：只删带 Engram 管理标记的 skill，不改客户端其他配置 */
  app.post('/api/settings/agent-access/unregister', async (req, reply) => {
    const { id } = (req.body || {}) as { id?: string };
    if (!id || !isAgentClientId(id)) return reply.code(400).send({ error: '未知客户端' });
    try {
      return { ok: true, ...unregisterAgentAccess(id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 远程接入：下载 cli.js（保存为 engram.js 后 `node engram.js login --url ... --token ...`） */
  app.get('/api/settings/agent-cli-source', async (_req, reply) => {
    const cli = resolveCliRuntime();
    if (!cli.available) {
      return reply.code(500).send({ error: 'CLI 尚未构建：' + (cli.error || cli.scriptPath) });
    }
    let source: string;
    try {
      source = fs.readFileSync(cli.scriptPath, 'utf8');
    } catch (error) {
      return reply
        .code(500)
        .send({ error: '读取 CLI 源文件失败：' + (error instanceof Error ? error.message : String(error)) });
    }
    reply.header('Content-Type', 'text/javascript; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="engram.js"');
    return reply.send(source);
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
      // jszip 只在真正导出备份时加载（约 127ms），启动时不付这份成本
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      zip.file('wiki.db', fs.readFileSync(snapshot));
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          if (name === '.trash') continue; // 回收站不入备份
          const abs = path.join(dir, name);
          const rel = path.relative(BRAIN_DIR, abs).replace(/\\/g, '/');
          // 整库副本（vault 里又套了一层 brain/）不进备份：否则备份体积翻倍，恢复时还会继续嵌套
          if (isNestedVaultPath(rel)) continue;
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
      // 备份恢复才需要 jszip；密码校验通过后才加载
      const { default: JSZip } = await import('jszip');
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
    let nested = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      // 白名单 + 越界拒绝：只接受 wiki.db 与 brain/ 前缀内的规范路径
      const name = entry.name.replace(/\\/g, '/');
      const segments = name.split('/');
      if (segments.some((s) => s === '..' || s === '')) continue;
      if (name !== 'wiki.db' && segments[0] !== 'brain') continue;
      // vault 里又套了一层 vault（brain/brain/…）：这种备份来自已出问题的数据卷，恢复会立刻复现重复
      if (isNestedVaultPath(segments.slice(1).join('/'))) { nested += 1; continue; }
      const abs = path.join(staging, ...segments);
      if (!abs.startsWith(staging + path.sep)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, await entry.async('nodebuffer'));
      extracted++;
    }
    if (nested > 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      return reply.code(400).send({
        error: `备份里有 ${nested} 个嵌套 brain/brain/ 路径（整库副本残留），已拒绝恢复：请在来源端清理后重新导出备份`,
      });
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