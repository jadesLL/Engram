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
  type PushPayload,
} from '../sync/hub.js';
import {
  createPeer,
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
import { distilledSourcePaths } from '../pipeline/sourceLedger.js';
import { configure, reconcileNow, status } from '../sync/index.js';

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

  app.post('/api/sync/config', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { enabled?: boolean; hub_url?: string; hub_token?: string; role?: 'hub' | 'member' | 'none' };
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
    return { peer: { ...peerView(peer), token } };
  });

  /** 重置成员 token（旧 token 立即失效） */
  app.post('/api/sync/peers/:id/regenerate', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const peer = getPeer(id);
    if (!peer) return reply.code(404).send({ error: '成员不存在' });
    const token = `lsync_${crypto.randomBytes(24).toString('hex')}`;
    db.prepare(`UPDATE sync_peers SET token = ? WHERE id = ?`).run(token, id);
    return { token };
  });

  app.delete('/api/sync/peers/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const peer = getPeer(id);
    if (!peer) return reply.code(404).send({ error: '成员不存在' });
    revokePeer(id);
    return { ok: true };
  });

  // ---------- 数据面（成员 token / owner）：逐路由声明 requireSyncAccess ----------

  /** 成员 SSE 下行：实时广播；断开由 req close 触发反注册 */
  app.get('/api/sync/events', { preHandler: requireSyncAccess }, async (req, reply) => {
    const query = req.query as { node_id?: string; name?: string };
    const peer = req.syncPeer;
    if (peer) {
      touchPeer(peer.id, { nodeLabel: String(query.name || '') });
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
    });
  });

  /** 成员推送变更（page/delete/move） */
  app.post('/api/sync/push', { preHandler: requireSyncAccess }, async (req, reply) => {
    const push = req.body as PushPayload;
    try {
      const result = await applyPush(push, req.syncPeer?.id || 'owner');
      if (req.syncPeer) touchPeer(req.syncPeer.id, { seq: Number(result.seq) || 0 });
      return result;
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message || '推送应用失败' });
    }
  });

  /** 成员推送非页面文件（multipart），落盘后发号广播 */
  app.post('/api/sync/file', { preHandler: requireSyncAccess }, async (req, reply) => {
    let relPath = '';
    let saved = false;
    let tooLarge = false;
    for await (const part of req.parts({ limits: { fileSize: Infinity, files: 1 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'path') relPath = String(part.value ?? '');
      } else if (part.type === 'file' && part.fieldname === 'file') {
        if (!relPath) return reply.code(400).send({ error: '缺少 path 字段' });
        try {
          const maxBytes = isInboxPath(relPath) ? Infinity : 200 * 1024 * 1024;
          saved = await writeRawFileStream(relPath, part.file, maxBytes);
          if (!saved) tooLarge = true;
        } catch (error: any) {
          return reply.code(400).send({ error: error?.message || '文件落盘失败' });
        }
      }
    }
    if (tooLarge) return reply.code(413).send({ error: '同步文件超过 200 MB 上限' });
    if (!saved) return reply.code(400).send({ error: '缺少文件' });
    const actorId = req.syncPeer?.id || 'owner';
    const result = commitFileChange(relPath, actorId);
    if (req.syncPeer) touchPeer(req.syncPeer.id, { seq: Number(result.seq) || 0 });
    return { ok: true, seq: result.seq, revision: result.revision };
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
  app.get('/api/sync/snapshot', { preHandler: requireSyncAccess }, async () => {
    return { entries: buildSnapshotEntries(), cursor: currentRevision(), stale: buildStalePaths() };
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
