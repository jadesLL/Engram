import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { now, db } from '../lib/db.js';
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
 *  - 成员推送 → applyPush()：base 落后时先以 page_revisions 祖先做字符级三方合并，
 *    无法融合的冲突按文件修改时间最新者胜整页裁决：AIWorks 区直接覆盖不产生新文件，
 *    其他页面败者以「原名-时间戳」重命名保留在原目录
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

/** 文件修改时间（ms；读取失败按 0 = 最旧） */
function mtimeMsOf(relPath: string): number {
  try {
    return fs.statSync(safeJoin(relPath)).mtimeMs;
  } catch {
    return 0;
  }
}

/** 冲突副本文件名时间戳（UTC 紧凑格式，与正文无关联，仅用于命名排序） */
function conflictStamp(): string {
  return now().replace(/[-:]/g, '').replace(/\..+/, '');
}

/**
 * 冲突裁决（以修改时间最新者为准，废弃旧的「先到方为准 + 备份页」）：
 *  - 胜者内容占用原页面；
 *  - AIWorks 系统区不允许产生任何新文件：败者直接丢弃；
 *  - 其他页面：败者以「原名-时间戳」重命名保存在原目录，供人工核对后删除。
 * 返回需要写入的副本路径（无副本时为 null）。副本写失败不阻塞正本。
 */
function applyConflictResolution(target: string, hubRaw: string, theirsRaw: string, theirsMs: number, actorId: string): void {
  const hubMs = mtimeMsOf(target);
  const theirsWins = theirsMs > hubMs;
  const winner = theirsWins ? theirsRaw : hubRaw;
  const loser = theirsWins ? hubRaw : theirsRaw;
  applyPageContent(target, winner);
  const isSystemArea = target.startsWith('AIWorks/');
  if (isSystemArea || !loser.trim()) return;
  const dir = path.posix.dirname(target);
  const base = path.basename(target).replace(/\.md$/i, '');
  let copyRel = `${dir === '.' ? '' : dir + '/'}${base}-${conflictStamp()}.md`;
  while (fs.existsSync(safeJoin(copyRel))) {
    copyRel = `${dir === '.' ? '' : dir + '/'}${base}-${conflictStamp()}.md`;
  }
  try {
    applyPageContent(copyRel, loser);
    commit('page', copyRel, actorId, { evidence: null });
  } catch {
    // 副本写失败不阻塞主流程（败者内容仍在原持有方本地）
  }
}

/**
 * 一次性迁移：冲突备份机制已废弃（改为最新者胜 + 原目录重命名副本）。
 *  - AIWorks 下用户无法自行删除的冲突遗留（AIWorks/同步冲突/*、记录页 conflict.md）入回收站；
 *  - 顶级 同步冲突/ 的历史备份页（说明页之外）是用户可删内容，保留原样由用户自行处理，
 *    其中的说明页已过时，入回收站。
 * 仅数据权威端（hub/未组网端）执行；成员端的清理由 hub 发出的 delete op 传播完成。
 */
export function migrateConflictBackupDir(): void {
  let rows: { path: string }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT path FROM pages WHERE deleted = 0 AND (
           path LIKE 'AIWorks/同步冲突/%' OR path = 'AIWorks/log/conflict.md' OR path = '同步冲突/说明.md'
         )`,
      )
      .all() as { path: string }[];
  } catch {
    return;
  }
  for (const { path: rel } of rows) {
    try {
      moveToTrash(rel, 'sync');
      commit('delete', rel, HUB_ACTOR);
    } catch {
      // 单页清理失败不阻塞其余迁移与启动
    }
  }
  try {
    fs.rmdirSync(safeJoin('AIWorks/同步冲突'));
  } catch {
    // 目录非空或不存在时忽略
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
  /** 推送方源文件的修改时间（ms）；冲突裁决「最新者胜」的依据，缺失按 0（最旧） */
  mtime?: number;
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
    // 基准落后：先做字符级三方合并；无法融合的冲突按修改时间最新者胜整页裁决
    const hubRaw = readPageRaw(target) ?? '';
    const ancestor = getPageRevision(target, base);
    const theirsMs = Number(push.mtime || 0);
    if (ancestor === null) {
      // 祖先缺失（离线太久/快照被裁剪/双方各自创建）：无法融合，整页按最新裁决
      applyConflictResolution(target, hubRaw, raw, theirsMs, actorId);
      const result = commit('page', target, actorId, {});
      return {
        ok: true,
        seq: Number(result.seq),
        revision: Number(result.revision),
        content: String(result.content),
      };
    }
    const merged = merge3(ancestor, hubRaw, raw);
    if (merged.conflicts.length > 0) {
      applyConflictResolution(target, hubRaw, raw, theirsMs, actorId);
    } else {
      applyPageContent(target, merged.content);
    }
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
