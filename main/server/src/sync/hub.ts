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
  summarizeBoardChange,
  summarizeDelete,
  summarizeFileChange,
  summarizeMove,
  summarizePageChange,
  summarizeSessionChange,
  type SyncOpSummary,
} from './opText.js';
import {
  collectBoardPayload,
  collectSessionSnapshot,
  deleteSessionWithTombstone,
  deviceLabel,
  mergeBoardPayload,
  mergeSessionSnapshot,
  resolveOriginLabel,
  sessionContentHash,
  snapshotHash,
  stampSessionOrigin,
  type BoardPayload,
  type SessionSnapshot,
} from './sessions.js';
import { BOARD_SYNC_ID } from '../assistant/boardCore.js';
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
function applyConflictResolution(
  target: string,
  hubRaw: string,
  theirsRaw: string,
  theirsMs: number,
  actorId: string,
): { copyPath: string | null; theirsWins: boolean } {
  const hubMs = mtimeMsOf(target);
  const theirsWins = theirsMs > hubMs;
  const winner = theirsWins ? theirsRaw : hubRaw;
  const loser = theirsWins ? hubRaw : theirsRaw;
  applyPageContent(target, winner);
  const isSystemArea = target.startsWith('AIWorks/');
  if (isSystemArea || !loser.trim()) return { copyPath: null, theirsWins };
  const dir = path.posix.dirname(target);
  const base = path.basename(target).replace(/\.md$/i, '');
  let copyRel = `${dir === '.' ? '' : dir + '/'}${base}-${conflictStamp()}.md`;
  while (fs.existsSync(safeJoin(copyRel))) {
    copyRel = `${dir === '.' ? '' : dir + '/'}${base}-${conflictStamp()}.md`;
  }
  try {
    applyPageContent(copyRel, loser);
    commit('page', copyRel, actorId, { evidence: null });
    return { copyPath: copyRel, theirsWins };
  } catch {
    // 副本写失败不阻塞主流程（败者内容仍在原持有方本地）
    return { copyPath: null, theirsWins };
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
  /** 会话删除：广播里带同一个标记，对端据此删掉本地副本并记墓碑 */
  deleted?: boolean;
  /**
   * 这条变更的来源设备名（会话/看板广播给成员端，界面据此显示「来自 <哪台设备>」）。
   * 中枢本端写入留空 = 用本机设备名；成员推来的由 applyPush 传原推送方的名字。
   */
  nodeLabel?: string;
}

/** 中枢本端操作的 actor 标识（成员以 sync_peers.id 作为 actor） */
export const HUB_ACTOR = 'hub';

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
    // 来源设备名随广播下发：只给 node_id 的话，成员端只能记成「来自某个节点」，
    // 会话列表里就成了光秃秃的「来自」。中枢自己的写入用本机设备名，转发成员推送用原设备名
    node_label: opts.nodeLabel ?? (actorId === HUB_ACTOR ? deviceLabel() : ''),
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
  } else if (kind === 'session') {
    // 会话/看板都不在 brain 目录里，载荷只带 hash 等元信息；正文与看板内容由成员按需拉取
    stampSessionOrigin(target);
    const snapshot = collectSessionSnapshot(target);
    payload.hash = snapshot ? snapshotHash(snapshot) : '';
    payload.messages = snapshot?.messages.length || 0;
    if (opts.deleted) payload.deleted = true;
  } else if (kind === 'board') {
    // 看板内容本身很小（一份 markdown），直接随广播下发，成员不再多一趟请求
    const board = collectBoardPayload();
    if (board) payload.board = board;
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
  /** 推送方的设备名（会话/看板广播给其他成员时，界面要能标出「来自哪台设备」） */
  node_label?: string;
  /** kind=session：完成态会话快照（只含终态轮次） */
  session?: SessionSnapshot;
  /** kind=session：删除标记（对端删副本并记墓碑） */
  deleted?: boolean;
  /** kind=board：全端唯一一份的任务看板 */
  board?: BoardPayload;
}

export interface PushApplyResult {
  ok: true;
  seq: number;
  revision: number;
  /** hub 侧最终内容（可能与推送内容不同：合并/规范化）；非页面操作为空 */
  content?: string;
  /** 页面写入方式：direct=直接应用；merged=字符级三方合并；conflict=无法融合按修改时间最新者胜 */
  merge?: 'direct' | 'merged' | 'conflict';
  /** conflict 时败者内容的另存副本路径（AIWorks 系统区或空内容不产生副本） */
  copyPath?: string | null;
  /** conflict 时是否由推送方内容胜出（false=中枢版本更新，推送方改动被另存） */
  theirWins?: boolean;
  /**
   * 本次推送的「哪个文件 + 什么增量」摘要（新增/修改/删除/改名 + 行数 + 体积）。
   * 随 ack 一起回给成员端：两端记录用同一句人话，成员端不用自己再算一遍。
   */
  op?: SyncOpSummary;
}

/** 页面在本次推送前的版本（共同的同步基准）：拿它算「这一轮改了多少行」 */
function previousPageContent(target: string, baseRevision: number, fallback: string | null): string | null {
  if (baseRevision > 0) {
    const snapshot = getPageRevision(target, baseRevision);
    if (snapshot !== null) return snapshot;
  }
  return fallback;
}

/** 删除前的体积：页面算正文字节，其他文件按磁盘大小（取不到就记 0） */
function sizeBefore(target: string): number {
  try {
    return fs.statSync(safeJoin(target)).size;
  } catch {
    return 0;
  }
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
      const before = previousPageContent(target, base, cur > 0 ? readPageRaw(target) : null);
      applyPageContent(target, raw);
      const result = commit('page', target, actorId, {});
      return {
        ok: true,
        seq: Number(result.seq),
        revision: Number(result.revision),
        content: String(result.content),
        merge: 'direct',
        op: summarizePageChange(target, before, String(result.content ?? raw)),
      };
    }
    // 基准落后：先做字符级三方合并；无法融合的冲突按修改时间最新者胜整页裁决
    const hubRaw = readPageRaw(target) ?? '';
    const ancestor = getPageRevision(target, base);
    const theirsMs = Number(push.mtime || 0);
    if (ancestor === null) {
      // 祖先缺失（离线太久/快照被裁剪/双方各自创建）：无法融合，整页按最新裁决
      const resolved = applyConflictResolution(target, hubRaw, raw, theirsMs, actorId);
      const result = commit('page', target, actorId, {});
      return {
        ok: true,
        seq: Number(result.seq),
        revision: Number(result.revision),
        content: String(result.content),
        merge: 'conflict',
        copyPath: resolved.copyPath,
        theirWins: resolved.theirsWins,
        op: summarizePageChange(target, hubRaw, raw),
      };
    }
    const merged = merge3(ancestor, hubRaw, raw);
    if (merged.conflicts.length > 0) {
      const resolved = applyConflictResolution(target, hubRaw, raw, theirsMs, actorId);
      const result = commit('page', target, actorId, {});
      return {
        ok: true,
        seq: Number(result.seq),
        revision: Number(result.revision),
        content: String(result.content),
        merge: 'conflict',
        copyPath: resolved.copyPath,
        theirWins: resolved.theirsWins,
        op: summarizePageChange(target, ancestor, raw),
      };
    }
    applyPageContent(target, merged.content);
    const result = commit('page', target, actorId, {});
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      content: String(result.content),
      merge: 'merged',
      op: summarizePageChange(target, ancestor, raw),
    };
  }

  if (push.kind === 'file') {
    // 文件内容经 /api/sync/file 已落盘，这里只发号广播
    const target = String(push.target || '');
    const result = commit('file', target, actorId);
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      merge: 'direct',
      op: summarizeFileChange(target, 0, sizeBefore(target)),
    };
  }

  if (push.kind === 'delete') {
    const target = String(push.target || '');
    // 页面/文件在日志里的说法不同：先按扩展名判类型，再在删除前量体积
    const isPage = /\.(md|markdown)$/i.test(target);
    const bytes = sizeBefore(target);
    try {
      moveToTrash(target, 'sync');
    } catch {
      // 中枢本就没有这个路径（成员删的是他本地的副本）：不发号，但也不能算失败
      return { ok: true, seq: 0, revision: getPageSyncRevision(target), merge: 'direct' };
    }
    const result = commit('delete', target, actorId);
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      merge: 'direct',
      op: summarizeDelete(target, bytes, isPage),
    };
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
      return {
        ok: true,
        seq: Number(removed.seq),
        revision: Number(removed.revision),
        merge: 'direct',
        copyPath: null,
        op: summarizeDelete(oldRel, 0, true),
      };
    }
    const result = commit('move', newRel, actorId, { oldPath: oldRel });
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      merge: 'direct',
      op: summarizeMove(oldRel, newRel),
    };
  }

  if (push.kind === 'session') {
    // 会话同步：完成态快照按 id 并集合并；删除走墓碑。两者都不做字符级合并。
    const sessionId = String(push.target || '');
    if (!sessionId) throw new Error('会话推送缺少 target');
    // 来源设备名：推送方自己报的优先，没带就按成员注册的设备名补（广播要把它带给别的成员端，
    // 否则它们只记得「来自某个节点」，会话列表里就成了光秃秃的「来自」）
    const originLabel = String(push.node_label || resolveOriginLabel(actorId, ''));
    if (push.deleted) {
      deleteSessionWithTombstone(sessionId, actorId);
      const result = commit('session', sessionId, actorId, { deleted: true, nodeLabel: originLabel });
      // 中枢自己的浏览器也要刷会话列表（广播只发给成员端，不发本机 SSE）
      emit('session-changed', { id: sessionId, deleted: true, from: push.node_id || '' });
      return {
        ok: true,
        seq: Number(result.seq),
        revision: Number(result.revision),
        op: summarizeSessionChange(sessionId, ''),
      };
    }
    const snapshot = push.session;
    if (!snapshot?.session?.id) throw new Error('会话推送缺少快照');
    // 合并前后比一次内容 hash：没有新内容（本端已是同一份、或被墓碑挡住）就不发号、不广播，
    // 否则两端会把同一份快照反复推来推去
    const hashBefore = sessionContentHash(sessionId);
    const merged = mergeSessionSnapshot(snapshot, push.node_id || actorId, originLabel);
    if (sessionContentHash(sessionId) === hashBefore) {
      return { ok: true, seq: 0, revision: 0, op: summarizeSessionChange(sessionId, snapshot.session.title) };
    }
    const result = commit('session', sessionId, actorId, { nodeLabel: originLabel });
    emit('session-changed', { id: sessionId, from: push.node_id || '' });
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      op: summarizeSessionChange(sessionId, snapshot.session.title, merged.messages),
    };
  }

  if (push.kind === 'board') {
    const board = push.board;
    if (!board) throw new Error('看板推送缺少内容');
    const changed = mergeBoardPayload(board);
    if (!changed) {
      // 本端这份同样新或更新：不回发号（否则两端会互相把旧看板推来推去）
      return { ok: true, seq: 0, revision: 0, op: summarizeBoardChange() };
    }
    const result = commit('board', BOARD_SYNC_ID, actorId, {});
    // 中枢自己的页面也要换成最新那版看板（本机 SSE 不在成员广播里）
    emit('board-changed', { from: String(board.nodeId || '') });
    return {
      ok: true,
      seq: Number(result.seq),
      revision: Number(result.revision),
      op: summarizeBoardChange(),
    };
  }

  throw new Error(`未知同步类型: ${push.kind}`);
}

/** 中枢收到成员推送的非页面文件、落盘后调用：发号广播 */
export function commitFileChange(relPath: string, actorId: string): Record<string, unknown> {
  return commit('file', relPath, actorId);
}

/** 中枢本端产生变更后的提交入口（由 sync/index.ts 的 recordLocalChange / recordSessionChange 调用） */
export function commitLocalChange(kind: SyncKind, target: string, oldPath = '', deleted = false): Record<string, unknown> {
  return commit(kind, target, HUB_ACTOR, { oldPath, deleted });
}

export { writeRawFile, writeRawFileStream, sha256, applyPageContent, readPageRaw };
