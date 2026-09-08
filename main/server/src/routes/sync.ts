import fs from 'node:fs';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../lib/db.js';
import { sse } from '../lib/sse.js';
import { requireAuth } from './auth.js';
import { safeJoin } from '../lib/vault.js';
import {
  addNodeSubscriber,
  applyPush,
  commitFileChange,
  connectedPeerIds,
  readPageRaw,
  writeRawFile,
  sha256,
  type PushPayload,
} from '../sync/hub.js';
import {
  createPeer,
  findPeerByToken,
  getPeer,
  getPageRevision,
  getOpsSince,
  listPeers,
  minOplogSeq,
  revokePeer,
  touchPeer,
  type SyncOp,
  type SyncPeer,
} from '../sync/store.js';
import { collectEvidenceForPage } from '../sync/rows.js';
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
async function requireSyncAccess(req: FastifyRequest, reply: FastifyReply) {
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

  app.get('/api/sync/conflicts', { preHandler: requireAuth }, async () => {
    const rows = db
      .prepare(
        `SELECT id, path, title, updated_at FROM pages
         WHERE path LIKE 'AIWorks/同步冲突/%' AND deleted = 0
           AND path != 'AIWorks/同步冲突/说明.md'
         ORDER BY updated_at DESC LIMIT 200`
      )
      .all();
    return { conflicts: rows };
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
    const keepalive = setInterval(() => {
      try {
        (reply.raw as import('node:http').ServerResponse).write(': ping\n\n');
      } catch { /* 断开时由 close 清理 */ }
    }, 30_000);
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
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'path') relPath = String(part.value ?? '');
      } else if (part.type === 'file' && part.fieldname === 'file') {
        if (!relPath) return reply.code(400).send({ error: '缺少 path 字段' });
        const buf = await part.toBuffer();
        try {
          writeRawFile(relPath, buf);
        } catch (error: any) {
          return reply.code(400).send({ error: error?.message || '文件落盘失败' });
        }
        saved = true;
      }
    }
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
    const query = req.query as { since?: string };
    const since = Number(query.since || 0);
    const ops = getOpsSince(since) as SyncOp[];
    const enriched = ops.map((op) => {
      if (op.kind !== 'page') return op;
      const content = getPageRevision(op.target, op.revision) ?? readPageRaw(op.target) ?? '';
      return { ...op, content, evidence: collectEvidenceForPage(op.target) };
    });
    if (req.syncPeer) touchPeer(req.syncPeer.id);
    return {
      ops: enriched,
      resync: ops.length === 0 && minOplogSeq() > since + 1,
    };
  });

  /** 全量对账清单 */
  app.get('/api/sync/snapshot', { preHandler: requireSyncAccess }, async () => {
    return { entries: buildSnapshotEntries() };
  });

  /** 页面内容拉取（对账用） */
  app.get('/api/sync/page-content', { preHandler: requireSyncAccess }, async (req, reply) => {
    const query = req.query as { path?: string };
    if (!query.path) return reply.code(400).send({ error: '缺少 path' });
    const content = readPageRaw(query.path);
    if (content === null) return reply.code(404).send({ error: '页面不存在' });
    return { content };
  });
}

/** brain 目录全量清单（页面取 raw 文本 hash，文件取字节 hash） */
function buildSnapshotEntries(): { kind: 'page' | 'file'; path: string; hash: string; revision: number }[] {
  const entries: { kind: 'page' | 'file'; path: string; hash: string; revision: number }[] = [];
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
      } else if (e.name.toLowerCase().endsWith('.md')) {
        const raw = fs.readFileSync(childAbs, 'utf8');
        const revision = Number(
          (db.prepare(`SELECT sync_revision FROM pages WHERE path = ?`).get(childRel) as
            | { sync_revision: number }
            | undefined)?.sync_revision || 0
        );
        entries.push({ kind: 'page', path: childRel, hash: sha256(Buffer.from(raw, 'utf8')), revision });
      } else {
        entries.push({ kind: 'file', path: childRel, hash: sha256(fs.readFileSync(childAbs)), revision: 0 });
      }
    }
  }
  walk('');
  return entries;
}
