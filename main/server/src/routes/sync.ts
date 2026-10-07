import { notifyCategoriesChanged } from '../sync/hub.js';
import { syncAllowed, saveSyncCategories } from '../sync/categories.js';
import { preferenceSnapshot, preferenceValue } from '../sync/preferences.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../lib/db.js';
import { sse } from '../lib/sse.js';
import { requireAuth } from './auth.js';
import { safeJoin } from '../lib/vault.js';
import { classifyBrainEntry, isInboxPath } from '../lib/brainPaths.js';
import {
  addNodeSubscriber,
  applyPush,
  commitFileChange,
  connectedPeerIds,
  readPageRaw,
  writeRawFileStream,
  sha256,
  type PushApplyResult,
  type PushPayload,
} from '../sync/hub.js';
import {
  createPeer,
  currentNodeId,
  currentRevision,
  findPeerByToken,
  getPeer,
  getPageRevision,
  getOpsSince,
  listPeers,
  needsResync,
  revokePeer,
  touchPeer,
  type SyncOp,
  type SyncPeer,
} from '../sync/store.js';
import { collectEvidenceForPage, collectEvidenceForPath } from '../sync/rows.js';
import {
  collectSessionSnapshot,
  listSessionTombstones,
  readSyncedBoard,
  sessionManifest,
  snapshotHash,
} from '../sync/sessions.js';
import { distilledSourcePaths } from '../pipeline/sourceLedger.js';
import { configure, configureDualStack, configureLinkPreferLan, currentRole, reconcileNow, status } from '../sync/index.js';
import { pairingLink, parsePairingLink } from '../sync/pairing.js';
import { deviceLabel } from '../sync/deviceLabel.js';
import { updateSourceForSync } from '../lib/updateConfig.js';
import { localLanUrls } from '../sync/linkAnnounce.js';
import { memberHubAddresses } from '../sync/hubAddress.js';
import { getDdnsConfig } from '../lib/ddns.js';
import { HOST, PORT } from '../config.js';
import type { DualStackConfig } from '../sync/dualStack.js';
import {
  clearSyncLog,
  logSyncEvent,
  querySyncLog,
  syncLogSummary,
  type SyncLogContent,
  type SyncLogLevel,
  type SyncLogOutcome,
  type SyncLogScope,
} from '../sync/eventLog.js';
import { SYNC_LOG_CONTENTS, SYNC_LOG_OUTCOMES } from '../sync/logClassify.js';
import {
  describeOpSummary,
  flattenChangeLines,
  isNoteworthyOp,
  summarizeFileChange,
} from '../sync/opText.js';

/**
 * 多端同步端点（同步群组模型）：
 *  - 管理面（成员增删、角色与绑定配置、状态）：owner 鉴权（登录 cookie / MCP token）
 *  - 数据面（push/events/file/changes/snapshot/page-content）：群组成员 token（sync_peers）
 *    或 owner 均可；成员身份由中枢在「添加成员」时签发的专属 token 认证
 * 角色说明：每个实例都具备中枢能力；是否作为成员绑定上级由
 * sync_role/sync_enabled/sync_hub_url/sync_hub_token 决定。
 */

declare module 'fastify' {
  interface FastifyRequest {
    syncPeer?: SyncPeer;
  }
}

/** 日志里对成员的称呼：成员名 → 上报的设备名 → 兜底，保证每条记录都有可指认的主体 */
function peerLabel(peer?: SyncPeer): string {
  if (!peer) return '本机（owner 通道）';
  return peer.name || peer.node_label || `成员 ${peer.id.slice(0, 8)}`;
}

/**
 * 中枢侧记录一次成员推送。
 *
 * 旧实现中枢根本不记日志（日志只在成员端），而用户多半是在中枢上打开设置看
 * 「多端同步」——看到空列表就以为功能坏了。这里把「谁在什么时候推了哪个文件、
 * 做了什么增量（新增/修改/删除/改名 + 行数 + 体积）、中枢怎么裁决的」逐条写清楚；
 * 冲突另记 warn 并带上副本路径，方便直接定位。
 * AIWorks/ 下的系统页（操作日志、索引、关系库）由应用自己高频改写，不进用户记录。
 */
function logPushResult(peer: SyncPeer | undefined, push: PushPayload, result: PushApplyResult): void {
  // 成员名后面直接接动作会连读成「客厅 NAS修改页面…」：带上「成员」前缀并用书名号括起来，
  // 与 opText/文档里的措辞一致；owner 通道保留「本机（owner 通道）」原样
  const who = peer ? `成员「${peerLabel(peer)}」` : peerLabel(peer);
  const target = String(push.target || '');
  const from = String(push.old_path || '');
  const op = result.op;
  if (!isNoteworthyOp(op)) return;
  const describe = describeOpSummary(op);
  const data: Record<string, unknown> = {
    peerId: peer?.id || 'owner',
    kind: push.kind,
    path: target,
    oldPath: from || undefined,
    seq: result.seq,
    revision: result.revision,
    merge: result.merge || 'direct',
    title: op.title,
    added: op.added,
    removed: op.removed,
    beforeBytes: op.beforeBytes,
    afterBytes: op.afterBytes,
    // 「+3 −1 行」之外还要能看出改了哪几行：中枢收到的推送逐条记下改动正文
    changes: flattenChangeLines([op]),
  };
  if (result.merge === 'conflict') {
    const winner = result.theirWins ? '推送方（较新）' : '中枢（较新）';
    const loserKept = result.copyPath ? `，另一版本另存为「${result.copyPath}」` : '，另一版本已丢弃（AI 工作区或空内容不留副本）';
    logSyncEvent('warn', 'push-conflict', {
      detail: `${who}${describe}，与中枢版本冲突：按修改时间以${winner}为准${loserKept}`,
      scope: 'hub',
      peer: peer?.name,
      data: { ...data, copyPath: result.copyPath || undefined, theirWins: result.theirWins },
    });
    return;
  }
  if (result.merge === 'merged') {
    logSyncEvent('info', 'push-merged', {
      detail: `${who}${describe}，双方改动已自动合并（各自新增的内容都保留）`,
      scope: 'hub',
      peer: peer?.name,
      data,
    });
    return;
  }
  logSyncEvent('info', 'push-received', { detail: `${who}${describe}`, scope: 'hub', peer: peer?.name, data });
}

/** 全量对账清单请求：按成员去抖（同一成员 5 分钟内只记一条），否则每 15 分钟的自愈对账会把日志刷满 */
const snapshotLoggedAt = new Map<string, number>();
const SNAPSHOT_LOG_INTERVAL_MS = 5 * 60_000;

/** 数据面鉴权：群组成员 token 优先，其次 owner 通道（登录 cookie / MCP token） */
export async function requireSyncAccess(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') || auth.startsWith('bearer ')
    ? auth.replace(/^Bearer\s+/i, '')
    : '';
  if (bearer) {
    const peer = findPeerByToken(bearer);
    if (peer) {
      req.syncPeer = peer;
      return;
    }
  }
  await requireAuth(req, reply);
}

function peerView(peer: SyncPeer) {
  const online = connectedPeerIds().has(peer.id);
  return {
    id: peer.id,
    name: peer.name,
    node_label: peer.node_label,
    online,
    last_seen_at: peer.last_seen_at,
    last_seq: peer.last_seq,
    created_at: peer.created_at,
    // owner 鉴权面：完整令牌随时可查（前端默认掩码显示，点击展开）
    token: peer.token,
  };
}

export async function syncRoutes(app: FastifyInstance) {
  // ---------- 管理面（owner）：逐路由声明 requireAuth ----------
  // 注意不用 addHook：同一插件内多个 addHook 会叠加作用于全部路由

  app.get('/api/sync/status', { preHandler: requireAuth }, async () => status());

  /**
   * 同步详情（设置页「查看同步详情」打开的抽屉用它）：
   * 分页 + 按结果（有改动/没改动/失败）· 内容类型（原始资料/概念/实体/内置 Agent/其他）·
   * 成员 · 关键词筛选，外加汇总统计与当前运行状态。
   * 状态与日志一次返回：抽屉挂的是自己的轮询节奏（可暂停自动刷新），不必再打一次 /status。
   */
  app.get('/api/sync/log', { preHandler: requireAuth }, async (req) => {
    const q = (req.query || {}) as Record<string, string | undefined>;
    const level = q.level === 'info' || q.level === 'warn' || q.level === 'error' ? (q.level as SyncLogLevel) : undefined;
    const scope = q.scope === 'hub' || q.scope === 'member' || q.scope === 'app' ? (q.scope as SyncLogScope) : undefined;
    // 分类筛选：只接受已知取值，写错的值当没筛（不让前端一个拼写错误变成空列表）
    const outcome = (SYNC_LOG_OUTCOMES as string[]).includes(String(q.outcome)) ? (q.outcome as SyncLogOutcome) : undefined;
    const content = (SYNC_LOG_CONTENTS as string[]).includes(String(q.content)) ? (q.content as SyncLogContent) : undefined;
    const result = querySyncLog({
      limit: Number(q.limit || 200),
      before: q.before ? Number(q.before) : undefined,
      after: q.after ? Number(q.after) : undefined,
      since: q.since ? Number(q.since) : undefined,
      level,
      scope,
      event: q.event || undefined,
      outcome,
      content,
      peer: q.peer || undefined,
      q: q.q || undefined,
    });
    const current = status();
    return {
      ...result,
      summary: syncLogSummary(),
      // 抽屉需要角色/连接/队列/成员，但不需要令牌（hubToken 是敏感字段，不在这里重复下发）
      status: { ...current, hubToken: undefined, log: [] },
    };
  });

  /** 清空同步日志（设置页危险区/抽屉里的「清空日志」） */
  app.delete('/api/sync/log', { preHandler: requireAuth }, async () => ({ ok: true, cleared: clearSyncLog() }));

  app.post('/api/sync/config', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      enabled?: boolean;
      hub_url?: string;
      hub_token?: string;
      role?: 'hub' | 'member' | 'none';
      dual_stack?: Partial<DualStackConfig>;
      prefer_lan?: boolean;
      categories?: unknown;
    };
    if (body.categories !== undefined) {
      try { saveSyncCategories(body.categories); } catch (error: any) { return reply.code(400).send({ error: error.message }); }
      if (status().role === 'hub') notifyCategoriesChanged();
      else if (status().enabled) reconcileNow();
    }
    // 双栈参数独立于绑定信息：设置页只改阈值时不能把 enabled 当 false 处理（会误停同步）
    if (body.dual_stack !== undefined) configureDualStack(body.dual_stack || {});
    // 「优先局域网」同理：与绑定信息独立，只改它不会重新绑定、也不会重连
    if (body.prefer_lan !== undefined) configureLinkPreferLan(Boolean(body.prefer_lan));
    const touchesBinding = body.enabled !== undefined || body.hub_url !== undefined
      || body.hub_token !== undefined || body.role !== undefined;
    if (!touchesBinding) return { ok: true };
    const error = await configure({
      enabled: Boolean(body.enabled),
      hub_url: body.hub_url,
      hub_token: body.hub_token,
      role: body.role,
    });
    if (error) return reply.code(400).send({ error });
    return { ok: true };
  });

  app.post('/api/sync/reconcile', { preHandler: requireAuth }, async () => {
    reconcileNow();
    return { ok: true };
  });

  // ---------- 群组成员管理（中枢，owner） ----------
  // 链接与二维码使用相同内容；前端本地绘制二维码，避免把凭据交给外部服务。
  app.post('/api/sync/peers/:id/invite', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (currentRole() !== 'hub') return reply.code(409).send({ error: '请先将本设备设为中枢' });
    const peer = getPeer((req.params as { id: string }).id);
    if (!peer) return reply.code(404).send({ error: '成员不存在' });
    const body = (req.body || {}) as { hub_url?: string; origin?: string };
    const ddns = getDdnsConfig();
    const report = memberHubAddresses({ bindHost: HOST, port: PORT, origin: body.origin,
      ddnsHost: ddns.enabled ? ddns.record : '', env: process.env });
    const address = body.hub_url || report.addresses[0]?.url;
    if (!address || !report.addresses.some((entry) => entry.url === address)) {
      return reply.code(400).send({ error: '没有可用的成员绑定地址，请开启局域网访问或选择已公布的中枢地址' });
    }
    const link = pairingLink({ hubUrl: address, token: peer.token, name: peer.name });
    return { ok: true, link, qrText: link, hubUrl: address, name: peer.name };
  });

  // 中枢校验成员凭据；不能用 owner token 冒充成员配对。
  app.get('/api/sync/pairing/verify', { preHandler: requireSyncAccess }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (currentRole() !== 'hub') return reply.code(409).send({ error: '目标设备当前不是同步中枢' });
    if (!req.syncPeer) return reply.code(403).send({ error: '请使用中枢生成的成员邀请链接' });
    return { ok: true, name: req.syncPeer.name };
  });

  app.post('/api/sync/pairing/join', { preHandler: requireAuth }, async (req, reply) => {
    const invite = parsePairingLink((req.body as { link?: string } | null)?.link);
    if (!invite) return reply.code(400).send({ error: '邀请链接无效，请从中枢重新复制或扫码' });
    if (currentRole() !== 'none') return reply.code(409).send({ error: '本设备已参与同步，请先解除绑定或退出中枢角色' });
    let name = '';
    try {
      const response = await fetch(`${invite.hubUrl}/api/sync/pairing/verify`, {
        headers: { authorization: `Bearer ${invite.token}` }, redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return reply.code(400).send({ error: response.status === 401 || response.status === 403
        ? '邀请令牌已失效，请在中枢重新生成邀请' : '中枢无法确认配对，请检查中枢角色及版本' });
      const result = await response.json() as { ok?: boolean; name?: string };
      if (result.ok !== true || typeof result.name !== 'string') throw new Error('invalid response');
      name = result.name;
    } catch {
      return reply.code(502).send({ error: '无法连接配对中枢，请检查网络和邀请链接中的地址后重试' });
    }
    // 远端检查期间角色可能被另一请求修改，写入前再次检查。
    if (currentRole() !== 'none') return reply.code(409).send({ error: '本设备的同步角色已改变，请刷新后重试' });
    const error = await configure({ role: 'member', enabled: true, hub_url: invite.hubUrl, hub_token: invite.token });
    if (error) return reply.code(400).send({ error });
    return { ok: true, name, hubUrl: invite.hubUrl };
  });

  app.get('/api/sync/peers', { preHandler: requireAuth }, async () => {
    return { peers: listPeers().map(peerView) };
  });

  /** 为成员设备签发专属 token（owner 可随时在成员列表查看完整 token） */
  app.post('/api/sync/peers', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = (req.body || {}) as { name?: string };
    const trimmed = String(name || '').trim();
    if (!trimmed) return reply.code(400).send({ error: '请填写成员名称' });
    const token = `lsync_${crypto.randomBytes(24).toString('hex')}`;
    const peer = createPeer(trimmed.slice(0, 40), token);
    logSyncEvent('info', 'peer-added', {
      detail: `已添加成员「${trimmed.slice(0, 40)}」并生成绑定令牌`,
      scope: 'hub',
      peer: trimmed.slice(0, 40),
      data: { peerId: peer.id, total: listPeers().length },
    });
    return { peer: { ...peerView(peer), token } };
  });

  /** 重置成员 token（旧 token 立即失效） */
  app.post('/api/sync/peers/:id/regenerate', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const peer = getPeer(id);
    if (!peer) return reply.code(404).send({ error: '成员不存在' });
    const token = `lsync_${crypto.randomBytes(24).toString('hex')}`;
    db.prepare(`UPDATE sync_peers SET token = ? WHERE id = ?`).run(token, id);
    logSyncEvent('warn', 'peer-token-reset', {
      detail: `已重置成员「${peer.name}」的绑定令牌（旧令牌立即失效，该设备需要重新绑定）`,
      scope: 'hub',
      peer: peer.name,
      data: { peerId: peer.id },
    });
    return { token };
  });

  app.delete('/api/sync/peers/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const peer = getPeer(id);
    if (!peer) return reply.code(404).send({ error: '成员不存在' });
    revokePeer(id);
    logSyncEvent('warn', 'peer-removed', {
      detail: `已移除成员「${peer.name}」（该设备的令牌立即失效，不再参与同步）`,
      scope: 'hub',
      peer: peer.name,
      data: { peerId: peer.id, remaining: listPeers().length },
    });
    return { ok: true };
  });

  // ---------- 数据面（成员 token / owner）：逐路由声明 requireSyncAccess ----------

  /**
   * 连接通道通告（成员端择优用）：中枢告诉成员「我在这几个内网地址上也能连到」。
   * 成员端拿它当首选候选（局域网优先），探不到就回落到配置的中枢地址。
   *
   * 为什么放在带鉴权的数据面而不是无鉴权的 /health：内网地址清单等于本机网络拓扑，
   * 只该给已经绑定过令牌的成员看，不能播给任何访问者。
   */
  app.get('/api/sync/announce', { preHandler: requireSyncAccess }, async () => ({
    ok: true,
    nodeId: currentNodeId(),
    deviceLabel: deviceLabel(),
    lan: localLanUrls(),
  }));

  /**
   * 成员绑定地址（中枢设置页「同步群组」里的那一列）：告诉用户「别的设备该填哪个地址」。
   *
   * 旧实现直接拿浏览器 `location.origin` 展示与复制，桌面版（内嵌服务只监听 127.0.0.1）
   * 于是永远给出 http://127.0.0.1:18180，填到别的设备上必然连不上。现在由服务端算：
   * 剔除回环、只列真正可达的地址（部署侧声明 / 网卡探测 / DDNS / 当前访问地址），
   * 并且只监听回环时一条都不给（界面据此引导开启「允许局域网访问」）。
   *
   * origin 由设置页把 `location.origin` 传上来：Docker 版常常就是局域网 IP，
   * 是自动探测之外最有价值的一条候选。owner 鉴权：地址清单同样是本机网络拓扑。
   */
  app.get('/api/sync/hub-addresses', { preHandler: requireAuth }, async (req) => {
    const query = (req.query || {}) as { origin?: string };
    const ddns = getDdnsConfig();
    return {
      ok: true,
      ...memberHubAddresses({
        bindHost: HOST,
        port: PORT,
        origin: query.origin,
        ddnsHost: ddns.enabled ? ddns.record : '',
        env: {
          LAN_ACCESS_URL: process.env.LAN_ACCESS_URL,
          LAN_PORT: process.env.LAN_PORT,
          DIRECT_ACCESS_URL: process.env.DIRECT_ACCESS_URL,
        },
      }),
    };
  });

  /** 成员 SSE 下行：实时广播；断开由 req close 触发反注册 */
  app.get('/api/sync/events', { preHandler: requireSyncAccess }, async (req, reply) => {
    const query = req.query as { node_id?: string; name?: string };
    const peer = req.syncPeer;
    const device = String(query.name || '');
    const connectedAt = Date.now();
    if (peer) {
      // 节点 id 也要记：会话行的来源端记的是它（广播里记的是成员 id），补设备名时两种都得认
      touchPeer(peer.id, { nodeLabel: device, nodeId: String(query.node_id || '') });
      // 成员上报的就是它自己在中枢配置里的名字（deviceLabel.ts）：名字一致时不再重复标一遍
      const different = device && device !== peer.name ? `（设备名 ${device}）` : '';
      logSyncEvent('info', 'peer-online', {
        detail: `成员「${peer.name}」已连接${different}`,
        scope: 'hub',
        peer: peer.name,
        data: { peerId: peer.id, device, nodeId: String(query.node_id || '') },
      });
    }
    const peerId = peer?.id || String(query.node_id || 'owner-client');
    const stream = sse(reply);
    const unsubscribe = addNodeSubscriber({ peerId, send: stream.send });
    // 15s：低于常见反代上游读超时（Lucky 默认 30s），留一倍余量避免心跳与超时同刻竞争
    const keepalive = setInterval(() => {
      try {
        (reply.raw as import('node:http').ServerResponse).write(': ping\n\n');
      } catch { /* 断开时由 close 清理 */ }
    }, 15_000);
    keepalive.unref();
    req.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      try { stream.close(); } catch { /* 已关闭 */ }
      if (peer) {
        logSyncEvent('info', 'peer-offline', {
          detail: `成员「${peer.name}」已断开连接（本次在线 ${Math.max(1, Math.round((Date.now() - connectedAt) / 1000))} 秒）`,
          scope: 'hub',
          peer: peer.name,
          data: { peerId: peer.id, sessionMs: Date.now() - connectedAt },
        });
      }
    });
  });

  /** 成员推送变更（page/delete/move） */
  app.post('/api/sync/push', { preHandler: requireSyncAccess }, async (req, reply) => {
    const push = req.body as PushPayload;
    try {
      const result = await applyPush(push, req.syncPeer?.id || 'owner');
      if (req.syncPeer) touchPeer(req.syncPeer.id, { seq: Number(result.seq) || 0 });
      logPushResult(req.syncPeer, push, result);
      return result;
    } catch (error: any) {
      logSyncEvent('error', 'push-rejected', {
        detail: `${peerLabel(req.syncPeer)}推送的 ${push?.kind}「${String(push?.target || '')}」被中枢拒绝：${error?.message || error}`,
        scope: 'hub',
        peer: req.syncPeer?.name,
        data: { kind: push?.kind, path: push?.target, error: error?.message || String(error) },
      });
      return reply.code(400).send({ error: error?.message || '推送应用失败' });
    }
  });

  /** 成员推送非页面文件（multipart），落盘后发号广播 */
  app.post('/api/sync/file', { preHandler: requireSyncAccess }, async (req, reply) => {
    let relPath = '';
    let saved = false;
    let tooLarge = false;
    /** 落盘前的旧体积：据此说明这是「新增」还是「覆盖」，以及变大变小 */
    let beforeBytes = 0;
    for await (const part of req.parts({ limits: { fileSize: Infinity, files: 1 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'path') {
          relPath = String(part.value ?? '');
          try {
            beforeBytes = fs.statSync(safeJoin(relPath)).size;
          } catch { /* 中枢还没有这个文件 → 新增 */ }
        }
      } else if (part.type === 'file' && part.fieldname === 'file') {
        if (!relPath) return reply.code(400).send({ error: '缺少 path 字段' });
        if (!syncAllowed('file', relPath)) { part.file.resume(); continue; }
        try {
          const maxBytes = isInboxPath(relPath) ? Infinity : 200 * 1024 * 1024;
          saved = await writeRawFileStream(relPath, part.file, maxBytes);
          if (!saved) tooLarge = true;
        } catch (error: any) {
          logSyncEvent('error', 'file-rejected', {
            detail: `${peerLabel(req.syncPeer)}推送的文件「${relPath}」落盘失败：${error?.message || error}`,
            scope: 'hub',
            peer: req.syncPeer?.name,
            data: { path: relPath, error: error?.message || String(error) },
          });
          return reply.code(400).send({ error: error?.message || '文件落盘失败' });
        }
      }
    }
    if (relPath && !syncAllowed('file', relPath)) return { ok: true, skipped: true };
    if (tooLarge) return reply.code(413).send({ error: '同步文件超过 200 MB 上限' });
    if (!saved) return reply.code(400).send({ error: '缺少文件' });
    const actorId = req.syncPeer?.id || 'owner';
    const result = commitFileChange(relPath, actorId);
    if (req.syncPeer) touchPeer(req.syncPeer.id, { seq: Number(result.seq) || 0 });
    let bytes = 0;
    try {
      bytes = fs.statSync(safeJoin(relPath)).size;
    } catch { /* 极端情况：刚落盘就被移走 */ }
    // 落盘前先量过旧体积（见上方 beforeBytes）：新增还是覆盖、变大还是变小，用户要看得见
    const op = summarizeFileChange(relPath, beforeBytes, bytes);
    logSyncEvent('info', 'file-received', {
      detail: `${peerLabel(req.syncPeer)}${describeOpSummary(op)}`,
      scope: 'hub',
      peer: req.syncPeer?.name,
      data: {
        path: relPath,
        bytes,
        beforeBytes,
        verb: op.verb,
        seq: result.seq,
        revision: result.revision,
      },
    });
    return { ok: true, seq: result.seq, revision: result.revision, op };
  });

  /** 成员拉取非页面文件 */
  app.get('/api/sync/file', { preHandler: requireSyncAccess }, async (req, reply) => {
    const query = req.query as { path?: string };
    if (!query.path) return reply.code(400).send({ error: '缺少 path' });
    try {
      const abs = safeJoin(query.path);
      if (!fs.existsSync(abs)) return reply.code(404).send({ error: '文件不存在' });
      return reply.send(fs.createReadStream(abs));
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '路径无效' });
    }
  });

  /** 重连补拉：cursor 之后的 op（页面 op 附带当前内容与证据快照）；oplog 已裁剪时要求全量对账 */
  app.get('/api/sync/changes', { preHandler: requireSyncAccess }, async (req) => {
    const query = req.query as { since?: string; limit?: string; compact?: string };
    const since = Number(query.since || 0);
    const requestedLimit = Number(query.limit || 500);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.trunc(requestedLimit))) : 500;
    const compact = query.compact === '1' || query.compact === 'true';
    const ops = getOpsSince(since, limit) as SyncOp[];
    const enriched = ops.map((op) => {
      if (!syncAllowed(op.kind, op.target, op.old_path)) return { seq: op.seq, kind: 'disabled', target: '' };
      if (op.kind === 'preference') return { ...op, preference: preferenceValue(op.target) };
      if (compact) return op;
      if (op.kind !== 'page') return op;
      const content = getPageRevision(op.target, op.revision) ?? readPageRaw(op.target) ?? '';
      return { ...op, content, evidence: collectEvidenceForPage(op.target) };
    });
    if (req.syncPeer) touchPeer(req.syncPeer.id);
    return {
      ops: enriched,
      resync: needsResync(since),
      compact,
    };
  });

  /**
   * 全量对账清单（页面/文件带内容 hash 与 revision；条目另带 distilled 供对端比对本端账本；
   * stale 为本端「见过但当前不持有」的路径：对端据此不再把已删/已改名旧路径补推回来）。
   */
  app.get('/api/sync/preferences', { preHandler: requireSyncAccess }, async () => ({ preferences: preferenceSnapshot() }));

  app.get('/api/sync/snapshot', { preHandler: requireSyncAccess }, async (req) => {
    const entries = buildSnapshotEntries().filter(entry => syncAllowed(entry.kind, entry.path));
    const peer = req.syncPeer;
    if (peer) {
      const key = peer.id;
      const now = Date.now();
      const last = snapshotLoggedAt.get(key) || 0;
      if (now - last > SNAPSHOT_LOG_INTERVAL_MS) {
        snapshotLoggedAt.set(key, now);
        logSyncEvent('info', 'snapshot-served', {
          detail: `成员「${peer.name}」拉取全量清单对账（中枢 ${entries.length} 项）`,
          scope: 'hub',
          peer: peer.name,
          data: { peerId: peer.id, entries: entries.length, cursor: currentRevision() },
        });
      }
    }
    // 会话与看板也在同一份清单里：sessions 只带指纹（不搬正文），tombstones 防复活，board 是全端唯一那份
    return {
      entries,
      preferences: preferenceSnapshot(),
      cursor: currentRevision(),
      stale: buildStalePaths(),
      sessions: syncAllowed('session', '') ? sessionManifest() : [],
      tombstones: syncAllowed('session', '') ? listSessionTombstones() : [],
      board: syncAllowed('board', '') ? readSyncedBoard() : null,
      // 成员端据此把「本机叫什么」对齐成中枢配置里的成员名（deviceLabel.ts）；
      // owner 通道（浏览器/MCP）没有成员身份，返回 null，调用方按「不知道」处理
      device: peer ? { id: peer.id, name: peer.name } : null,
      // 同步群组共用的更新源（中枢「更新源配置」里的仓库地址，不带凭据）：手机端没手填地址时
      // 就用这一份检查 APK 更新，免得多端各填一遍；成员端手填的地址优先（见 AppUpdateConfig）
      updateSource: updateSourceForSync(),
    };
  });

  /**
   * 会话快照拉取（对账/按需拉取用）：只含**完成态**内容——
   * 正在跑的轮次与那一轮的消息都不在里面（「正在对话」不同步）。
   */
  app.get('/api/sync/session', { preHandler: requireSyncAccess }, async (req, reply) => {
    const query = req.query as { id?: string };
    const id = String(query.id || '');
    if (!id) return reply.code(400).send({ error: '缺少 id' });
    const snapshot = collectSessionSnapshot(id);
    if (!snapshot) return reply.code(404).send({ error: '会话不存在' });
    return { snapshot, hash: snapshotHash(snapshot) };
  });

  /** 页面内容拉取（对账用） */
  app.get('/api/sync/page-content', { preHandler: requireSyncAccess }, async (req, reply) => {
    const query = req.query as { path?: string };
    if (!query.path) return reply.code(400).send({ error: '缺少 path' });
    const content = readPageRaw(query.path);
    if (content === null) return reply.code(404).send({ error: '页面不存在' });
    return { content };
  });

  /**
   * 证据账本拉取：按来源路径返回该路径的完整证据快照（版本/运行/事实/贡献）。
   * 「已提炼」标记只存在于这些账本行里，页面与文件同步带不动它；对端发现
   * 清单里 distilled=true 而本端为 false 时，用本端点补齐（snapshot 为 null 表示本端未提炼过）。
   */
  app.get('/api/sync/evidence', { preHandler: requireSyncAccess }, async (req) => {
    const query = req.query as { path?: string };
    const sourcePath = String(query.path || '');
    if (!sourcePath) return { snapshot: null };
    return { snapshot: collectEvidenceForPath(sourcePath) };
  });

  /**
   * 「已提炼」标记清单（轻量，只回路径，不带 hash 也不带正文）。
   *
   * 标记只存在于账本（source_versions / page_contributions）里，**没有对应的同步 op**：
   * 页面与文件同步带不动它，只有全量清单的 distilled 字段能表达。桌面 / Docker 成员端靠
   * 周期自愈对账顺带补齐，但手机端只有前台事件触发的一轮同步、没有自愈对账——中枢在绑定
   * 之后新提炼的资料，在手机上会一直不带「已提炼」（用户看到：电脑上标了，手机没标）。
   * 这里给成员端一条只补标记的轻路：按这份清单与本地比对，只对差异项拉
   * /api/sync/evidence，不必为几个标记把整份清单（每条路径 + hash）拉下来。
   */
  app.get('/api/sync/distilled', { preHandler: requireSyncAccess }, async () => ({
    paths: [...distilledSourcePaths()].filter(path => syncAllowed('file', path)).sort(),
  }));
}

/** brain 目录全量清单（页面取 raw 文本 hash，文件取字节 hash；
 *  distilled 为中文本端该路径的「已提炼」状态——标记只存在于账本里，清单必须显式带上，
 *  否则对端无法区分「内容已同步」与「账本已同步」） */
function buildSnapshotEntries(): {
  kind: 'page' | 'file';
  path: string;
  hash: string;
  revision: number;
  distilled: boolean;
}[] {
  const entries: {
    kind: 'page' | 'file';
    path: string;
    hash: string;
    revision: number;
    distilled: boolean;
  }[] = [];
  const distilledPaths = distilledSourcePaths();
  function walk(rel: string): void {
    const absDir = safeJoin(rel);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirents) {
      if (e.name.startsWith('.')) continue;
      const childAbs = safeJoin(rel ? `${rel}/${e.name}` : e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (classifyBrainEntry(childRel) === 'page') {
        const raw = fs.readFileSync(childAbs, 'utf8');
        const revision = Number(
          (db.prepare(`SELECT sync_revision FROM pages WHERE path = ?`).get(childRel) as
            | { sync_revision: number }
            | undefined)?.sync_revision || 0
        );
        entries.push({
          kind: 'page',
          path: childRel,
          hash: sha256(Buffer.from(raw, 'utf8')),
          revision,
          distilled: distilledPaths.has(childRel),
        });
      } else {
        entries.push({
          kind: 'file',
          path: childRel,
          hash: sha256(fs.readFileSync(childAbs)),
          revision: 0,
          distilled: distilledPaths.has(childRel),
        });
      }
    }
  }
  walk('');
  return entries;
}

/**
 * 中枢「见过、但当前不持有」的路径清单（对账时下发给成员）。
 *
 * 全量对账的反向补推只对「中枢从没见过」的本端内容成立：成员停用期间中枢删页、
 * 或页面在中枢被改名移走时，成员手里的旧副本若被补推回来，等于让中枢复活已删页面
 * 并广播给所有端（用户可见的「之前删了的文件又冒出来」）。四个来源合起来覆盖
 * 「行还在但已软删」「已永久删除（行没了）」「已改名移走的旧路径」三类：
 *  - pages/files 软删行
 *  - page_revisions 里出现过的路径（改名后旧路径的历史版本仍留在这里，不受 oplog 裁剪影响）
 *  - oplog 里 move 的 old_path 与 delete 的 target
 * 当前仍然存活的路径一律剔除（页面可能在同一路径上被删后重建）。
 */
function buildStalePaths(): string[] {
  const rows = db
    .prepare(
      `SELECT path FROM pages WHERE deleted = 1
       UNION SELECT path FROM files WHERE deleted = 1
       UNION SELECT path FROM page_revisions
       UNION SELECT old_path FROM sync_oplog WHERE kind = 'move' AND old_path != ''
       UNION SELECT target FROM sync_oplog WHERE kind = 'delete'`
    )
    .all() as { path: string }[];
  const live = new Set<string>();
  for (const row of db.prepare(`SELECT path FROM pages WHERE deleted = 0`).all() as { path: string }[]) {
    live.add(row.path);
  }
  for (const row of db.prepare(`SELECT path FROM files WHERE deleted = 0`).all() as { path: string }[]) {
    live.add(row.path);
  }
  return rows.map((r) => r.path).filter((p) => p && !live.has(p));
}
