import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { now, db } from '../lib/db.js';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { safeJoin, syncPageFile, movePage, markPageDeleted, notifySyncChange, PagePathTakenError } from '../lib/vault.js';
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
  // 自己写的：文件系统监听据此跳过回声（本函数已经推过 page-changed）
  noteAppWrite(abs);
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

/** 原子流式写入同步文件；普通文件保留大小上限，调用方可为收集箱传 Infinity。 */
async function writeRawFileStream(relPath: string, source: Readable, maxBytes = 200 * 1024 * 1024): Promise<boolean> {
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${Date.now()}-${crypto.randomUUID()}.sync.tmp`;
  let size = 0;
  let tooLarge = false;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (maxBytes === Infinity) {
        callback(null, chunk);
        return;
      }
      size += chunk.length;
      if (tooLarge || size > maxBytes) {
        tooLarge = true;
        callback();
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await streamPipeline(source, limiter, fs.createWriteStream(temp));
    if (tooLarge) {
      fs.rmSync(temp, { force: true });
      return false;
    }
    fs.renameSync(temp, abs);
    return true;
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
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
 * 该机制产生的页面全部入回收站（可恢复）：
 *  - AIWorks 下用户无法自行删除的遗留（AIWorks/同步冲突/*、记录页 conflict.md）；
 *  - 顶级 同步冲突/ 的历史备份页与过时说明页（含冲突败者内容，但机制已废，不再展示）。
 * 各角色都执行：成员端没有中枢迁移可依赖（后加入的成员游标从当前水位起，收不到早期
 * delete op；从旧快照播种的库更是一路留着这些页），而侧栏「AI 工作区」按路径列出
 * AIWorks/ 下全部页面，遗留会长期显示。删除经 notifySyncChange 入同步链路
 * （中枢=本地提交广播，成员=推送队列），删除会传播到中枢与其余成员，不会只清本端
 * 后被对账拉回。
 */
export function migrateConflictBackupDir(): void {
  let rows: { path: string }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT path FROM pages WHERE deleted = 0 AND (
           path LIKE 'AIWorks/同步冲突/%' OR path = 'AIWorks/log/conflict.md' OR path LIKE '同步冲突/%'
         )`,
      )
      .all() as { path: string }[];
  } catch {
    return;
  }
  for (const { path: rel } of rows) {
    try {
      // 文件已被带外删除（只剩索引行）时 moveToTrash 会抛错，此时直接落删除标记，
      // 否则行停在 deleted = 0，侧栏留下点开报「文件不存在」的幽灵页
      if (fs.existsSync(safeJoin(rel))) moveToTrash(rel, 'sync');
      else markPageDeleted(rel);
      notifySyncChange('delete', rel);
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
    try {
      movePage(oldRel, newRel, 'sync');
    } catch (error: any) {
      if (!(error instanceof PagePathTakenError)) throw error;
      // 目标路径已被占用（两端各自建了同名页）：绝不覆盖目标正文。把来源路径按删除广播，
      // 让所有端收敛到「目标页保持原样、来源路径消失」，而不是各端自行搬移互相顶替正文
      // （旧实现在这里覆盖目标后撞唯一约束，来源路径还会留下点开报「文件不存在」的幽灵行）。
      try {
        moveToTrash(oldRel, 'sync');
      } catch {
        markPageDeleted(oldRel);
      }
      const removed = commit('delete', oldRel, actorId);
      return { ok: true, seq: Number(removed.seq), revision: Number(removed.revision) };
    }
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

export { writeRawFile, writeRawFileStream, sha256, applyPageContent, readPageRaw };
