import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { now } from '../lib/db.js';
import { emit } from '../lib/events.js';
import { safeJoin, syncPageFile, movePage } from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { enqueuePagePipeline } from '../jobs.js';
import { merge3 } from './merge.js';
import { applyEvidenceSnapshot, collectEvidenceForPage, type EvidenceSnapshot } from './rows.js';
import {
  appendOplog,
  getPageRevision,
  getPageSyncRevision,
  nextRevision,
  savePageRevision,
  setPageSyncRevision,
  type SyncKind,
} from './store.js';

/**
 * 中枢端：持有权威 revision 序列。
 *  - 本端写入 → commitLocalChange()：发号、快照、oplog、广播
 *  - 成员推送 → applyPush()：base 落后时以 page_revisions 祖先做字符级三方合并，
 *    同位置冲突取先到方（中枢当前内容），后到方完整内容写入冲突备份页
 *  - 广播经独立的成员 SSE 订阅集合下发（与浏览器 SSE 互不干扰），排除来源成员防回声；
 *    成员身份由群组 token（sync_peers 表）认证
 */

export interface NodeSubscriber {
  peerId: string;
  send(event: string, data: unknown): void;
}

const nodeSubs = new Set<NodeSubscriber>();

export function addNodeSubscriber(sub: NodeSubscriber): () => void {
  nodeSubs.add(sub);
  return () => nodeSubs.delete(sub);
}

export function connectedPeerIds(): Set<string> {
  return new Set([...nodeSubs].map((s) => s.peerId));
}

function broadcast(data: Record<string, unknown>, excludePeerId?: string): void {
  for (const sub of nodeSubs) {
    if (excludePeerId && sub.peerId === excludePeerId) continue;
    try {
      sub.send('sync', data);
    } catch {
      nodeSubs.delete(sub);
    }
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 原子写页面文件并同步 DB 索引（同步链路专用：不经 writePage，避免再次触发本地变更通知） */
function applyPageContent(relPath: string, raw: string): { id: string } | null {
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${Date.now()}.sync.tmp`;
  fs.writeFileSync(temp, raw);
  fs.renameSync(temp, abs);
  const meta = syncPageFile(relPath);
  if (!meta) return null;
  enqueuePagePipeline(meta.id);
  emit('page-changed', { path: relPath, id: meta.id });
  return { id: meta.id };
}

function readPageRaw(relPath: string): string | null {
  try {
    const abs = safeJoin(relPath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function writeRawFile(relPath: string, buf: Buffer): void {
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${Date.now()}.sync.tmp`;
  fs.writeFileSync(temp, buf);
  fs.renameSync(temp, abs);
}

/** 冲突备份页：后到方的完整内容不丢，落到 AIWorks/同步冲突/ 并随同步传播 */
function writeConflictBackup(relPath: string, theirsRaw: string, nodeId: string, baseRevision: number): void {
  const stamp = now().replace(/[-:]/g, '').replace(/\..+/, '');
  const base = path.basename(relPath).replace(/\.md$/i, '');
  const backupRel = `AIWorks/同步冲突/${base}-${stamp}.md`;
  const body = [
    '---',
    `标题: "同步冲突: ${base}（${stamp}）"`,
    '类型: doc',
    '---',
    '',
    `> 多端同步自动生成的冲突备份。冲突页面：\`${relPath}\`；`,
    `> 内容来源节点：\`${nodeId || '未知'}\`（其基准版本 ${baseRevision} 已过期）。`,
    `> 按先到方为准保留了线上页面内容，本页保存后到方完整内容，请人工核对合并后删除。`,
    '',
    '```markdown',
    theirsRaw.replace(/```/g, '```\u200b'),
    '```',
    '',
  ].join('\n');
  try {
    applyPageContent(backupRel, body);
    commit('page', backupRel, HUB_ACTOR, { evidence: null });
  } catch {
    // 备份页写失败不阻塞主流程（冲突内容仍在推送方本地）
  }
}

interface CommitOptions {
  oldPath?: string;
  evidence?: EvidenceSnapshot | null;
}

/** 中枢本端操作的 actor 标识（成员以 sync_peers.id 作为 actor） */
export const HUB_ACTOR = 'hub';

interface CommitOptions {
  oldPath?: string;
  evidence?: EvidenceSnapshot | null;
}

/** 中枢变更统一提交：发号 → 页面快照 → oplog → 广播 */
function commit(kind: SyncKind, target: string, actorId: string, opts: CommitOptions = {}): Record<string, unknown> {
  const revision = nextRevision();
  const seq = appendOplog(kind, target, revision, actorId, opts.oldPath || '');
  const payload: Record<string, unknown> = {
    seq,
    kind,
    target,
    old_path: opts.oldPath || '',
    revision,
    node_id: actorId,
  };
  if (kind === 'page') {
    const raw = readPageRaw(target) ?? '';
    savePageRevision(target, revision, raw, actorId);
    setPageSyncRevision(target, revision);
    payload.content = raw;
    const evidence = opts.evidence !== undefined ? opts.evidence : collectEvidenceForPage(target);
    if (evidence) payload.evidence = evidence;
  } else if (kind === 'file') {
    try {
      const buf = fs.readFileSync(safeJoin(target));
      payload.hash = sha256(buf);
      payload.size = buf.length;
    } catch {
      payload.hash = '';
      payload.size = 0;
    }
  }
  // 中枢自身写入广播给全部成员；成员推送来的变更排除来源成员（其结果经 push ack 返回）
  broadcast(payload, actorId === HUB_ACTOR ? undefined : actorId);
  return payload;
}

export interface PushPayload {
  node_id: string;
  kind: SyncKind;
  target: string;
  base_revision?: number;
  content?: string;
  evidence?: EvidenceSnapshot | null;
  old_path?: string;
}

export interface PushApplyResult {
  ok: true;
  seq: number;
  revision: number;
  /** hub 侧最终内容（可能与推送内容不同：合并/规范化）；非页面操作为空 */
  content?: string;
}

export function applyPush(push: PushPayload, actorId: string): PushApplyResult {
  if (push.kind === 'page') {
    const target = String(push.target || '');
    const raw = String(push.content ?? '');
    const base = Number(push.base_revision || 0);
    if (push.evidence) applyEvidenceSnapshot(push.evidence);
    const cur = getPageSyncRevision(target);
    if (base >= cur || cur === 0) {
      // 基准未落后（或双方都不知道该页）：直接应用
      applyPageContent(target, raw);
      const result = commit('page', target, actorId, {});
      return {
        ok: true,
        seq: Number(result.seq),
        revision: Number(result.revision),
        content: String(result.content),
      };
    }
    // 基准落后：三方合并（祖先 = 成员基准版本的快照）
    const hubRaw = readPageRaw(target) ?? '';
    const ancestor = getPageRevision(target, base);
    if (ancestor === null) {
      // 祖先缺失（离线太久/快照被裁剪）：保守处理——保留中枢内容，后到方写入冲突备份
      writeConflictBackup(target, raw, actorId, base);
      return { ok: true, seq: 0, revision: getPageSyncRevision(target), content: hubRaw };
    }
    const merged = merge3(ancestor, hubRaw, raw);
    if (merged.conflicts.length > 0) {
      writeConflictBackup(target, raw, actorId, base);
    }
    applyPageContent(target, merged.content);
    const result = commit('page', target, actorId, {});
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      content: String(result.content),
    };
  }

  if (push.kind === 'file') {
    // 文件内容经 /api/sync/file 已落盘，这里只发号广播
    const result = commit('file', String(push.target || ''), actorId);
    return { ok: true, seq: Number(result.seq), revision: Number(result.revision) };
  }

  if (push.kind === 'delete') {
    const target = String(push.target || '');
    try {
      moveToTrash(target, 'sync');
    } catch {
      return { ok: true, seq: 0, revision: getPageSyncRevision(target) };
    }
    const result = commit('delete', target, actorId);
    return { ok: true, seq: Number(result.seq), revision: Number(result.revision) };
  }

  if (push.kind === 'move') {
    const oldRel = String(push.old_path || '');
    const newRel = String(push.target || '');
    movePage(oldRel, newRel, 'sync');
    const result = commit('move', newRel, actorId, { oldPath: oldRel });
    return { ok: true, seq: Number(result.seq), revision: Number(result.revision) };
  }

  throw new Error(`未知同步类型: ${push.kind}`);
}

/** 中枢收到成员推送的非页面文件、落盘后调用：发号广播 */
export function commitFileChange(relPath: string, actorId: string): Record<string, unknown> {
  return commit('file', relPath, actorId);
}

/** 中枢本端产生变更后的提交入口（由 sync/index.ts 的 recordLocalChange 调用） */
export function commitLocalChange(kind: SyncKind, target: string, oldPath = ''): Record<string, unknown> {
  return commit(kind, target, HUB_ACTOR, { oldPath });
}

export { writeRawFile, sha256, applyPageContent, readPageRaw };
