import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { getSetting } from '../lib/db.js';
import { consumeSseStream } from '../lib/sseStream.js';
import { safeJoin, syncPageFile, movePage, toRel, markPageDeleted, PagePathTakenError } from '../lib/vault.js';
import { classifyBrainEntry, isInboxPath } from '../lib/brainPaths.js';
import { moveToTrash } from '../lib/trash.js';
import { enqueuePagePipeline } from '../jobs.js';
import { applyEvidenceSnapshot, collectEvidenceForPage, type EvidenceSnapshot } from './rows.js';
import { formatBytes, formatDuration, logSyncEvent, recentSyncLog, type SyncLogEntry } from './eventLog.js';
import { describeOpList, describeOpSummary, formatLineDelta, isNoteworthyOp, summarizeBoardChange, summarizeDelete, summarizeMove, summarizePageChange, summarizeSessionChange, type SyncOpSummary } from './opText.js';
import { isDistilledPath } from '../pipeline/sourceLedger.js';
import { BOARD_SYNC_ID } from '../assistant/boardCore.js';
import {
  boardWins,
  collectBoardPayload,
  collectSessionSnapshot,
  deleteSessionWithTombstone,
  deviceLabel,
  mergeBoardPayload,
  mergeSessionSnapshot,
  sessionContentHash,
  sessionFingerprint,
  sessionManifest,
  sessionUpdatedAt,
  type BoardPayload,
  type SessionSnapshot,
} from './sessions.js';
import {
  currentNodeId,
  getCursor,
  getPageSyncRevision,
  setCursor,
  setPageSyncRevision,
  type SyncKind,
} from './store.js';

/**
 * 节点端同步客户端：
 *  - 本端写入 → enqueueLocalChange() 入队 → 顺序 POST /api/sync/push（ack 返回 hub 合并后的权威内容）
 *  - hub 广播 → SSE 长连接实时接收 → origin='sync' 写入本地（触发本地 page-changed，前端自动刷新）
 *  - 重连先补拉 changes?since=cursor，落后过多（oplog 裁剪）或首次接入走全量对账
 *  - 断网期间本端照常工作；队列在内存中，重启丢失的未推改动由全量对账补推
 *  所有文件读写均先经 safeJoin 限定在 brain 根目录内。
 */

export interface ClientStatus {
  enabled: boolean;
  connected: boolean;
  /** 首次接入的引导阶段（全量对账 + 从头补拉）尚未走完：面板据此显示「同步中」而不是干等 */
  syncing: boolean;
  /** 全量对账（首次接入 / 手动触发 / 周期自愈）正在执行：首页状态条据此显示「同步中」 */
  reconciling: boolean;
  hubUrl: string;
  hubToken: string;
  nodeId: string;
  cursor: number;
  pending: number;
  pendingPulls: number;
  lastSyncAt: string | null;
  lastError: string | null;
  log: SyncLogEntry[];
}

/** 全量对账的触发原因：日志里必须能看出「这一轮是谁触发的」，否则只有一条「对账完成」看不出因果 */
export type ReconcileReason = 'bootstrap' | 'manual' | 'heal' | 'oplog-gap';

const REASON_LABELS: Record<ReconcileReason, string> = {
  bootstrap: '接入/配置变更',
  manual: '手动触发',
  heal: '周期自愈',
  'oplog-gap': '落后超过保留窗口',
};

export function syncConfigEnabled(): boolean {
  return getSetting('sync_enabled') === '1' && Boolean(getSetting('sync_hub_url')) && Boolean(getSetting('sync_hub_token'));
}

/** 是否配置过 hub 连接（含停用状态）：配置过 hub 的实例永远不充当 hub 角色 */
export function hubConfigured(): boolean {
  return Boolean(getSetting('sync_hub_url'));
}

interface QueueItem {
  kind: SyncKind;
  target: string;
  oldPath?: string;
  /** 会话删除：本地已经删了，推的是「删除」而不是快照 */
  deleted?: boolean;
}

const queue: QueueItem[] = [];
const pendingTargets = new Set<string>();
/** 推送在途期间收到的同页广播（等 ack 后按版本决定是否应用） */
const stashed = new Map<string, { seq: number; kind: SyncKind; target: string; old_path: string; revision: number; content?: string; evidence?: EvidenceSnapshot }>();

let running = false;
/**
 * 「已连上中枢」的判定不是「SSE 长连接已建立」，而是「最近一次与中枢的通信成功」：
 * 首次接入要先做全量对账、再从头补拉整个 oplog，可能持续数分钟，其间 SSE 还没开，
 * 旧口径会让面板一直显示「未连接」，用户以为根本没连上（重启后水位已推进才显示正常）。
 */
let connected = false;
/** 首次接入引导（全量对账 + 补拉重放）是否仍在进行：SSE 连上即结束 */
let syncing = false;
let lastSyncAt: string | null = null;
let lastError: string | null = null;
let backoffMs = 1000;
let loopPromise: Promise<void> | null = null;
let streamAbort: AbortController | null = null;
let pushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** 推送失败重试退避（3s 起、倍增、30s 封顶；任一推送成功即复位） */
let pushRetryMs = 3000;
/** 拉取失败待补拉文件（path → 远端 hash），成功后移除 */
const pendingFilePulls = new Map<string, string>();
/** 会话快照待补拉（sessionId → 远端 hash），成功后移除（会话正文比文件大，失败必须留待重试） */
const pendingSessionPulls = new Map<string, string>();
let pullRetryTimer: ReturnType<typeof setInterval> | null = null;
let healTimer: ReturnType<typeof setInterval> | null = null;
let reconcileRunning = false;

/**
 * 断联台账：记录「什么时候开始连不上、连续失败几次」，连上后补一条恢复记录。
 * 用户的疑问经常是「刚才是不是断过、断了多久、我改的东西会不会丢」，
 * 只写一条 disconnected 回答不了——所以断开与恢复都要写清时长与期间积压的改动。
 */
let disconnectedSince: number | null = null;
let disconnectAttempts = 0;

/** 与中枢通信成功：若此前处于断联状态，补一条「已恢复」记录（含断开时长与积压队列） */
function markConnected(source: string): void {
  if (disconnectedSince === null) return;
  const ms = Date.now() - disconnectedSince;
  disconnectedSince = null;
  const attempts = disconnectAttempts;
  disconnectAttempts = 0;
  logEvent('info', 'reconnected', `已重新连上中枢（${source}），共断开 ${formatDuration(ms)}、重试 ${attempts} 次`
    + `${queue.length ? `；期间本机有 ${queue.length} 项改动已排队，正在补推` : '；期间本端没有待推送的改动'}`, {
    ms,
    attempts,
    source,
    pending: queue.length,
  });
}

/** 与中枢通信失败：首次失败才记台账，其后只累计次数（避免每轮重连都写一条） */
function markDisconnected(error: unknown): void {
  if (disconnectedSince === null) disconnectedSince = Date.now();
  disconnectAttempts += 1;
  void error;
}

/** 补拉条目的人话描述：拿本端当前内容当基准，说清「中枢把哪个文件改成了什么样」 */
function describeReplayOp(op: any): string {
  const target = String(op.target || '');
  const kind = String(op.kind || '');
  if (kind === 'page') {
    const before = readPageRaw(target);
    const after = String(op.content ?? '');
    const summary = summarizePageChange(target, before, after);
    if (summary.verb === 'same') return `页面「${summary.title}」正文与中枢一致（只推进版本号）`;
    return `中枢${summary.verb === 'add' ? '新增' : '修改'}页面「${summary.title}」（${formatLineDelta(summary.added, summary.removed)}）`;
  }
  if (kind === 'delete') return `中枢删除「${target}」`;
  if (kind === 'move') return `中枢改名「${String(op.old_path || '')}」→「${target}」`;
  if (kind === 'file') return `中枢更新文件「${target}」`;
  return `${kind} ${target}`;
}

/** 只留前 3 个文件名做例子，避免大库对账把一行撑成几千字 */
function pushSample(bucket: string[], path: string): void {
  if (bucket.length < 3) bucket.push(path);
}

/** 「（如「A」「B」）」；没有样本时为空串 */
function sampleText(samples: string[]): string {
  if (!samples.length) return '';
  return `（如${samples.map((item) => `「${pageName(item)}」`).join('')}）`;
}

/** 样本里显示成短名：页面用文件名（不带目录与扩展名），附件保留完整相对路径 */
function pageName(relPath: string): string {
  if (/\.(md|markdown)$/i.test(relPath)) {
    return path.posix.basename(relPath).replace(/\.(md|markdown)$/i, '');
  }
  return relPath;
}

// ---------- 同步事件日志 ----------
// 统一走 sync/eventLog：落盘留存、结构化字段，中枢/成员两条链路共用一份。
// 这里只保留成员端视角的薄封装；老事件名（connected/reconcile-done/oplog-trimmed…）全部保留——
// 端到端测试与前端事件标签都按事件名对照。

export type { SyncLogEntry };

/** 成员端事件入口（结构化字段进 eventLog，前端可展开/筛选/导出） */
function logEvent(
  level: SyncLogEntry['level'],
  event: string,
  detail?: string,
  data?: Record<string, unknown>,
): SyncLogEntry {
  return logSyncEvent(level, event, { detail, data, scope: 'member' });
}

/** { page: 2, file: 1 } → 「页面 2 · 文件 1」，用于推送/补拉的批次摘要 */
function kindSummary(counts: Partial<Record<SyncKind, number>>): string {
  const labels: Record<SyncKind, string> = {
    page: '页面',
    file: '文件',
    delete: '删除',
    move: '移动',
    session: '会话',
    board: '任务看板',
  };
  const parts = (Object.keys(labels) as SyncKind[])
    .filter((kind) => Number(counts[kind] || 0) > 0)
    .map((kind) => `${labels[kind]} ${counts[kind]}`);
  return parts.length ? parts.join(' · ') : '无内容变更';
}

export function hubUrl(): string {
  return (getSetting('sync_hub_url') || '').replace(/\/+$/, '');
}

export function hubToken(): string {
  return getSetting('sync_hub_token') || '';
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${hubToken()}` };
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sha256Buf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

/** 源文件修改时间（ms；读取失败按 0 = 最旧，与 hub 端裁决口径一致） */
function mtimeMsOf(relPath: string): number {
  try {
    return fs.statSync(safeJoin(relPath)).mtimeMs;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      sleepAbort = null;
      resolve();
    }
    sleepAbort = done;
  });
}

/** 中断在途退避 sleep：stopClient 时让后台循环立即退出，避免配置变更等待最长 30s */
let sleepAbort: (() => void) | null = null;

async function getJson(pathname: string): Promise<any> {
  const res = await fetch(hubUrl() + pathname, { headers: authHeaders() });
  if (!res.ok) throw new Error(`hub 返回 ${res.status}: ${pathname}`);
  return res.json();
}

async function postJson(pathname: string, body: unknown): Promise<any> {
  const res = await fetch(hubUrl() + pathname, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`hub 返回 ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** 原子写远端页面并同步索引（不触发 recordLocalChange，防止回声） */
function writeRemotePage(relPath: string, raw: string): void {
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${Date.now()}.sync.tmp`;
  fs.writeFileSync(temp, raw);
  fs.renameSync(temp, abs);
  // 自己写的：文件系统监听据此跳过回声（拉回的页面已经由本函数推过 SSE 了）
  noteAppWrite(abs);
  const meta = syncPageFile(relPath);
  if (meta) {
    enqueuePagePipeline(meta.id);
    emit('page-changed', { path: relPath, id: meta.id });
  }
}

/** 应用远端页面内容：内容相同只推进版本号（回声抑制），不同则落盘 */
function applyRemotePage(relPath: string, raw: string, revision: number): void {
  const localRaw = readPageRaw(relPath);
  if (localRaw === raw) {
    setPageSyncRevision(relPath, revision);
    return;
  }
  writeRemotePage(relPath, raw);
  setPageSyncRevision(relPath, revision);
}

async function pullFile(relPath: string): Promise<number> {
  const startedAt = Date.now();
  const res = await fetch(hubUrl() + `/api/sync/file?path=${encodeURIComponent(relPath)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`拉取文件失败 ${res.status}: ${relPath}`);
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${Date.now()}.sync.tmp`;
  try {
    if (isInboxPath(relPath)) {
      if (!res.body) throw new Error(`拉取文件响应没有内容: ${relPath}`);
      await streamPipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(temp));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(temp, buf);
    }
    fs.renameSync(temp, abs);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  noteAppWrite(abs);
  // 单个文件拉取只在「值得看一眼」时单独成条（≥ 512 KB 的大附件）：
  // 首次接入可能有成百上千个小文件，逐条记会把日志刷满、把真正有用的记录挤出去；
  // 数量与总字节数由所在批次（reconcile-done / replay）汇总。
  let size = 0;
  try {
    size = fs.statSync(abs).size;
    if (size >= 512 * 1024) {
      logEvent('info', 'file-pull-ok', `拉取文件 ${relPath}（${formatBytes(size)}）`, {
        path: relPath,
        bytes: size,
        ms: Date.now() - startedAt,
      });
    }
  } catch { /* 文件刚被移走时忽略 */ }
  // 原始资料文件拉取后补调度文本提取（与启动扫描/上传路径同一套机制）
  try {
    const { supportsFileExtraction, scheduleFileExtraction } = await import('../pipeline/fileExtraction.js');
    if (supportsFileExtraction(relPath)) scheduleFileExtraction(relPath, { mode: 'auto' });
  } catch { /* 非原始资料目录或提取模块不可用时忽略 */ }
  lastSyncAt = new Date().toISOString();
  return size;
}

/**
 * 应用远端 move：目标路径已就位（新成员「先全量对账、再从头重放 oplog」时必然如此，
 * 成员离线期间页面在中枢被改名也一样）说明页面已经在新路径上，旧路径只是残留副本——
 * 直接入回收站收敛掉，绝不能搬过去覆盖目标正文。
 * 旧实现直接 renameSync：覆盖目标页正文后 `UPDATE pages SET path` 撞唯一约束抛错并被
 * 静默吞掉，旧路径留下 deleted = 0 却无文件的幽灵行（侧栏列出、点开报「文件不存在」，
 * 只有重启扫描才清）。
 */
function applyRemoteMove(oldPath: string, target: string, revision: number): void {
  if (!oldPath || oldPath === target) return;
  try {
    movePage(oldPath, target, 'sync');
  } catch (error: any) {
    if (!(error instanceof PagePathTakenError)) {
      // 源不存在（本端从没拉到）等：后续内容同步会补齐新路径
      return;
    }
    try {
      moveToTrash(oldPath, 'sync');
    } catch {
      markPageDeleted(oldPath);
    }
    logEvent('info', 'move-superseded', `${oldPath} → ${target}：目标已就位，旧路径入回收站`, {
      from: oldPath,
      to: target,
    });
  }
  setPageSyncRevision(target, revision);
}

/**
 * 远端变更应用批次：SSE 是一条条推来的，逐条记日志会在别人批量改动时刷屏，
 * 这里按 200ms 合并成一条「应用中枢变更 N 项」——但**逐项写清文件名与增量**
 * （「中枢修改页面「周报」（+3 −1 行）；中枢新增文件「…」」），不是只有个数字。
 * 只记实时 SSE 来的变更：重连补拉（replay）已经有自己的汇总记录，不必再重复一遍。
 */
const appliedBatch: SyncOpSummary[] = [];
let appliedTimer: ReturnType<typeof setTimeout> | null = null;

function noteAppliedOp(summary: SyncOpSummary): void {
  appliedBatch.push(summary);
  if (appliedTimer) return;
  appliedTimer = setTimeout(() => {
    appliedTimer = null;
    const batch = appliedBatch.splice(0, appliedBatch.length);
    if (!batch.length) return;
    const visible = batch.filter((item) => isNoteworthyOp(item));
    const counts: Partial<Record<SyncKind, number>> = {};
    for (const item of batch) counts[item.kind] = Number(counts[item.kind] || 0) + 1;
    logEvent('info', 'pull-applied', visible.length
      ? `应用中枢变更 ${batch.length} 项：${describeOpList(visible)}${visible.length < batch.length ? `（另有 ${batch.length - visible.length} 项系统页/无变化）` : ''}`
      : `应用中枢变更 ${batch.length} 项（均为系统页或无变化：${kindSummary(counts)}）`, {
      count: batch.length,
      kinds: { ...counts },
      items: visible.slice(0, 10).map(describeOpSummary),
      paths: visible.slice(0, 10).map((item) => item.path),
    });
  }, 200);
  appliedTimer.unref?.();
}

/** 应用一条 hub 广播/补拉 op（seq 单调 guard 防重复应用）。
 *  cursor 只在应用成功后推进：page 应用失败向上抛断开事件流，重连后从 cursor 重放，
 *  避免「失败也前推水位」造成静默丢更新（对齐 fast-note-sync 的未确认不算完成语义） */
function applyRemoteOp(op: any, source: 'live' | 'replay' = 'live'): void {
  const seq = Number(op.seq || 0);
  if (seq <= getCursor()) return;
  const target = String(op.target || '');
  /** 本端是否真的落盘应用了这条变更（页面被暂存、文件改走异步拉取时不算） */
  let applied = false;
  /** 应用了什么（文件名 + 增量），批次记录逐项展示用 */
  let appliedSummary: SyncOpSummary | null = null;
  try {
    if (op.kind === 'page') {
      if (pendingTargets.has(target)) {
        // 本端同页有推送在途：暂存，等 ack 后按版本决定
        const prev = stashed.get(target);
        if (!prev || seq > prev.seq) {
          stashed.set(target, { seq, kind: 'page', target, old_path: '', revision: Number(op.revision || 0), content: op.content, evidence: op.evidence });
        }
      } else {
        const raw = String(op.content ?? '');
        const before = readPageRaw(target);
        applyRemotePage(target, raw, Number(op.revision || 0));
        if (op.evidence) applyEvidenceSnapshot(op.evidence);
        applied = true;
        appliedSummary = summarizePageChange(target, before, raw);
      }
    } else if (op.kind === 'file') {
      // 文件不进内存队列：hash 不同才拉取；失败记入待补拉集合周期重试（水位照常推进）
      // 单个文件拉取的记录由 pullFile 自己写（≥512 KB），这里不计入批次
      void pullFileIfChanged(target, String(op.hash || '')).catch((error: any) => {
        pendingFilePulls.set(target, String(op.hash || ''));
        logEvent('warn', 'file-pull-deferred', `文件「${target}」没能从中枢取回：${error?.message || error}；已加入待补拉队列，每分钟自动重试`, {
          path: target,
          error: error?.message || String(error),
          pending: pendingFilePulls.size,
        });
      });
    } else if (op.kind === 'delete') {
      const bytes = (() => {
        try { return fs.statSync(safeJoin(target)).size; } catch { return 0; }
      })();
      try {
        moveToTrash(target, 'sync');
      } catch {
        // 本端没有该文件（从没拉到/已被带外删除）：索引行仍要落删除标记，
        // 否则行停在 deleted = 0，侧栏留下点开报「文件不存在」的幽灵页
        markPageDeleted(target);
      }
      applied = true;
      appliedSummary = summarizeDelete(target, bytes, /\.(md|markdown)$/i.test(target));
    } else if (op.kind === 'move') {
      applyRemoteMove(String(op.old_path || ''), target, Number(op.revision || 0));
      applied = true;
      appliedSummary = summarizeMove(String(op.old_path || ''), target);
    } else if (op.kind === 'session') {
      if (op.deleted) {
        // 别端删了会话：本端删副本并记墓碑（否则对账会把本地副本推回去，把已删会话复活）
        deleteSessionWithTombstone(target, String(op.node_id || ''));
        applied = true;
        appliedSummary = summarizeSessionChange(target, '', 0, true);
        emit('session-changed', { id: target, deleted: true });
      } else {
        // 快照正文不进广播（可能很大）：按 hash 判断要不要拉；失败进待补拉队列周期重试（水位照常推进）
        const remoteHash = String(op.hash || '');
        if (!remoteHash || remoteHash !== sessionContentHash(target)) {
          void pullSessionIfChanged(target, remoteHash, String(op.node_id || ''), String(op.node_label || '')).catch(
            (error: any) => {
              pendingSessionPulls.set(target, remoteHash);
              logEvent('warn', 'session-pull-deferred', `会话「${target}」没能从中枢取回：${error?.message || error}；已加入待补拉队列，每分钟自动重试`, {
                session: target,
                error: error?.message || String(error),
                pending: pendingSessionPulls.size,
              });
            }
          );
        }
      }
    } else if (op.kind === 'board') {
      // 看板内容很小，直接随广播下发，不需要再拉一趟
      if (op.board && mergeBoardPayload(op.board)) {
        applied = true;
        appliedSummary = summarizeBoardChange();
        emit('board-changed', { from: String(op.node_id || '') });
      }
    }
  } catch (error: any) {
    logEvent('error', 'apply-failed', `中枢对「${target}」的改动没能写到本端：${error?.message || error}（将断开重连并重放这条变更，本端内容未被破坏）`, {
      kind: op.kind,
      path: target,
      seq,
      error: error?.message || String(error),
    });
    throw error;
  }
  if (seq > 0) setCursor(seq);
  lastSyncAt = new Date().toISOString();
  // 只记实时 SSE 来的变更：重连补拉已有 replay 汇总，逐条再记一遍是重复噪声
  if (applied && appliedSummary && source === 'live') noteAppliedOp(appliedSummary);
}

async function pullFileIfChanged(relPath: string, remoteHash: string): Promise<number> {
  try {
    const buf = fs.readFileSync(safeJoin(relPath));
    if (remoteHash && sha256Buf(buf) === remoteHash) return 0;
  } catch {
    // 本端没有该文件 → 拉取
  }
  if (!remoteHash) return 0;
  return pullFile(relPath);
}

/** 推送在途结束后的收尾：应用暂存的同页广播（仅当其版本比 ack 结果新） */
function drainStash(target: string, ackedRevision: number): void {
  const op = stashed.get(target);
  stashed.delete(target);
  if (!op) return;
  if (op.revision > ackedRevision && op.content !== undefined) {
    applyRemotePage(target, op.content, op.revision);
    if (op.evidence) applyEvidenceSnapshot(op.evidence);
  }
}

interface PushOutcome {
  /** 本次真正上行的字节数（页面正文 / 文件字节；delete、move 为 0） */
  bytes: number;
  /** hub 做过合并或规范化，返回内容与本端不同（已按 hub 结果写回本端） */
  merged: boolean;
  /** 中枢回执里的「哪个文件 + 什么增量」摘要（两端记录用同一句人话） */
  op?: SyncOpSummary;
}

async function pushOne(item: QueueItem): Promise<PushOutcome> {
  pendingTargets.add(item.target);
  try {
    if (item.kind === 'page') {
      const raw = readPageRaw(item.target);
      if (raw === null) return { bytes: 0, merged: false }; // 本地文件已消失（如已被删除入队）→ 丢弃
      const payload: Record<string, unknown> = {
        node_id: currentNodeId(),
        kind: 'page',
        target: item.target,
        base_revision: getPageSyncRevision(item.target),
        content: raw,
        // 冲突裁决「最新者胜」的依据：源文件修改时间
        mtime: mtimeMsOf(item.target),
      };
      const evidence = collectEvidenceForPage(item.target);
      if (evidence) payload.evidence = evidence;
      const res = await postJson('/api/sync/push', payload);
      const ackedRevision = Number(res.revision || 0);
      // ack 内容与本端不同 → hub 做过合并/规范化，以 hub 为准写回
      const merged = res.content !== undefined && res.content !== raw;
      if (merged) {
        applyRemotePage(item.target, String(res.content), ackedRevision);
        // 合并是「本端内容被别人改过」的唯一信号，旧版只在界面看板里体现为内容变了，
        // 日志里连一行都没有——排查「我的改动去哪了」时缺的正是这一条。
        // 系统页（AIWorks/）的合并由应用自己维护，不进用户记录。
        const op = res.op as SyncOpSummary | undefined;
        if (!String(item.target).startsWith('AIWorks/')) {
          const delta = op?.added || op?.removed ? `（合并后 ${formatLineDelta(op.added, op.removed)}）` : '';
          logEvent('info', 'push-merged', `页面「${op?.title || item.target}」本端与中枢都有改动，已按中枢合并结果写回本端${delta}`, {
            path: item.target,
            title: op?.title,
            revision: ackedRevision,
            added: op?.added,
            removed: op?.removed,
            localBytes: Buffer.byteLength(raw, 'utf8'),
            mergedBytes: Buffer.byteLength(String(res.content), 'utf8'),
          });
        }
      } else {
        setPageSyncRevision(item.target, ackedRevision);
      }
      drainStash(item.target, ackedRevision);
      lastSyncAt = new Date().toISOString();
      return { bytes: Buffer.byteLength(raw, 'utf8'), merged, op: res.op as SyncOpSummary | undefined };
    }
    if (item.kind === 'file') {
      const form = new FormData();
      form.append('path', item.target);
      form.append('node_id', currentNodeId());
      const abs = safeJoin(item.target);
      const fileBody = isInboxPath(item.target)
        ? await fs.openAsBlob(abs, { type: 'application/octet-stream' })
        : new Blob([new Uint8Array(fs.readFileSync(abs))]);
      form.append('file', fileBody, path.basename(item.target));
      const res = await fetch(hubUrl() + '/api/sync/file', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      if (!res.ok) throw new Error(`文件推送失败 ${res.status}: ${item.target}`);
      // 中枢在回执里带回「新增还是覆盖、体积变化」，本端记录直接复用同一句
      const ack = (await res.json().catch(() => null)) as { op?: SyncOpSummary } | null;
      lastSyncAt = new Date().toISOString();
      return { bytes: fileBody.size, merged: false, op: ack?.op };
    }
    if (item.kind === 'session') {
      // 删除：本地已经没有快照可推，推的是墓碑标记
      if (item.deleted) {
        const res = await postJson('/api/sync/push', {
          node_id: currentNodeId(),
          node_label: deviceLabel(),
          kind: 'session',
          target: item.target,
          deleted: true,
        });
        lastSyncAt = new Date().toISOString();
        return { bytes: 0, merged: false, op: res.op as SyncOpSummary | undefined };
      }
      // 只推「完成态」快照：正在跑的轮次与那一轮的消息都不在快照里（见 sync/sessions.ts）
      const snapshot = collectSessionSnapshot(item.target);
      if (!snapshot) return { bytes: 0, merged: false };
      const res = await postJson('/api/sync/push', {
        node_id: currentNodeId(),
        node_label: deviceLabel(),
        kind: 'session',
        target: item.target,
        session: snapshot,
      });
      lastSyncAt = new Date().toISOString();
      return { bytes: 0, merged: false, op: res.op as SyncOpSummary | undefined };
    }
    if (item.kind === 'board') {
      // 看板只推本机那一份（不是同步下来的那份）：本机没生成过就看板会话为空，直接跳过
      const board = collectBoardPayload();
      if (!board) return { bytes: 0, merged: false };
      const res = await postJson('/api/sync/push', {
        node_id: currentNodeId(),
        node_label: deviceLabel(),
        kind: 'board',
        target: BOARD_SYNC_ID,
        board,
      });
      lastSyncAt = new Date().toISOString();
      return { bytes: 0, merged: false, op: res.op as SyncOpSummary | undefined };
    }
    const res = item.kind === 'delete'
      ? await postJson('/api/sync/push', { node_id: currentNodeId(), kind: 'delete', target: item.target })
      : await postJson('/api/sync/push', {
        node_id: currentNodeId(),
        kind: 'move',
        target: item.target,
        old_path: item.oldPath || '',
      });
    lastSyncAt = new Date().toISOString();
    return { bytes: 0, merged: false, op: res.op as SyncOpSummary | undefined };
  } finally {
    pendingTargets.delete(item.target);
  }
}

async function pushLoop(): Promise<void> {
  if (pushing) return;
  pushing = true;
  const startedAt = Date.now();
  const counts: Partial<Record<SyncKind, number>> = {};
  const ops: SyncOpSummary[] = [];
  let bytes = 0;
  let merged = 0;
  /**
   * 批次摘要落日志：成功的推送以前一条记录都没有（只有失败才写 push-retry），
   * 用户看到的「记录」自然只有报错和空列表。这里按批次聚合，但**逐条写清文件名与增量**：
   * 「推送 3 项：新增页面「会议纪要」（+18 行，1.2 KB）；修改页面「周报」（+3 −1 行）」，
   * 超过 3 条只列前 3 条 + 「等 N 项」，其余在展开的结构化字段里。
   */
  const flush = (): void => {
    const total = (Object.keys(counts) as SyncKind[]).reduce((sum, kind) => sum + Number(counts[kind] || 0), 0);
    if (!total) return;
    // 只列「真的改了东西」的条目：AIWorks 系统页与内容没变的占位推送不进用户记录
    const visible = ops.filter((op) => isNoteworthyOp(op));
    if (visible.length) {
      const systemOnly = total - visible.length;
      logEvent('info', 'push-ok', `推送 ${visible.length} 项变更：${describeOpList(visible)}`
        + (systemOnly > 0 ? `（另有 ${systemOnly} 项系统页/无变化，未展开）` : ''), {
        count: visible.length,
        systemCount: systemOnly,
        kinds: { ...counts },
        bytes,
        merged,
        ms: Date.now() - startedAt,
        items: visible.slice(0, 10).map(describeOpSummary),
        paths: visible.slice(0, 10).map((op) => op.path),
      });
    }
    for (const kind of Object.keys(counts) as SyncKind[]) counts[kind] = 0;
    ops.length = 0;
    bytes = 0;
    merged = 0;
  };
  try {
    while (queue.length > 0) {
      // 先出队再推送：推送在途时同目标的新写入仍可入队（否则最新内容会被去重吞掉）
      const item = queue.shift()!;
      try {
        const outcome = await pushOne(item);
        counts[item.kind] = Number(counts[item.kind] || 0) + 1;
        bytes += outcome.bytes;
        if (outcome.merged) merged += 1;
        // 中枢回执里带的条目摘要（哪个文件、什么增量）；老中枢不带 op 时兜底用路径
        ops.push(outcome.op || {
          kind: item.kind,
          verb: item.kind === 'delete' ? 'delete' : item.kind === 'move' ? 'move' : 'update',
          path: item.target,
        });
      } catch (error: any) {
        flush(); // 已经推上去的部分先留痕，否则「推了一半又失败」在日志里看不出来
        if (item.kind === 'page' && readPageRaw(item.target) === null) {
          continue;
        }
        if (item.kind === 'file' && !fs.existsSync(safeJoin(item.target))) {
          continue;
        }
        // 网络/hub 错误：塞回队首保序，指数退避后自动重试（3s→30s，成功复位）
        queue.unshift(item);
        lastError = String(error?.message || error);
        logEvent('warn', 'push-retry', `「${item.target}」没能推送到中枢：${lastError}；${Math.round(pushRetryMs / 1000)} 秒后自动重试（队列还有 ${queue.length} 项）`, {
          kind: item.kind,
          path: item.target,
          error: lastError,
          retryInMs: pushRetryMs,
          queued: queue.length,
        });
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void pushLoop();
          }, pushRetryMs);
          pushRetryMs = Math.min(pushRetryMs * 2, 30_000);
        }
        return;
      }
    }
    pushRetryMs = 3000;
    flush();
  } finally {
    pushing = false;
  }
}

/** 本端变更入队（sync/index.ts 调用）：同类内容操作按 target 去重（后写为准），move/delete 不合并保序 */
export function enqueueLocalChange(kind: SyncKind, target: string, oldPath?: string, deleted = false): void {
  if (kind === 'page' || kind === 'file' || kind === 'session' || kind === 'board') {
    if (!queue.some((item) => item.kind === kind && item.target === target)) {
      queue.push({ kind, target, oldPath, deleted });
    }
  } else {
    queue.push({ kind, target, oldPath, deleted });
  }
  void pushLoop();
}

async function syncMissedChanges(): Promise<void> {
  // oplog 缺口（落后超过保留窗口）不能只重放保留区：缺口里的删除/移动 op 与证据账本
  // 再也取不回来，必须补一次全量对账。但保留区里的 op 仍要先逐条应用——它们带着账本快照
  // 与删除语义，而且应用后游标会推过保留区起点，缺口判据随之消失，不会每轮重连都触发对账。
  let gap = false;
  for (;;) {
    const res = await getJson(`/api/sync/changes?since=${getCursor()}`);
    connected = true;
    markConnected('补拉远端变更');
    if (res?.resync) gap = true;
    const ops: any[] = res?.ops || [];
    if (ops.length > 0) {
      // 补拉回来的变更逐条写清文件名与类型：只写「N 条」用户看不出同步了什么
      const items: string[] = [];
      const kinds: Record<string, number> = {};
      for (const op of ops) {
        kinds[String(op.kind)] = (kinds[String(op.kind)] || 0) + 1;
        if (items.length < 5 && !String(op.target || '').startsWith('AIWorks/')) {
          items.push(describeReplayOp(op));
        }
      }
      logEvent('info', 'replay', `补拉 ${ops.length} 条远端变更（自水位 ${getCursor()}）：${items.length ? items.join('；') : kindSummary(kinds as Partial<Record<SyncKind, number>>)}${ops.length > items.length ? `；等 ${ops.length - items.length} 条` : ''}`, {
        count: ops.length,
        from: getCursor(),
        kinds,
        items,
      });
    }
    for (const op of ops) applyRemoteOp(op, 'replay');
    if (ops.length < 500) break;
  }
  if (gap) {
    logEvent('info', 'oplog-trimmed', `落后超过保留窗口，补一次全量对账补齐内容与提炼账本（cursor=${getCursor()}）`, {
      cursor: getCursor(),
    });
    await reconcile('oplog-gap');
  }
}

/** 解析 SSE 字节流（事件流断开或出错时返回，重连由 runLoop 负责） */
async function consumeStream(): Promise<void> {
  // stopClient 可能落在本轮迭代更早的阶段（如 syncMissedChanges 在途请求）：那时 abort
  // 打在旧 controller 上无害，若此处仍开新流，会得到一条无人 abort 的僵尸 SSE——
  // 中枢 keepalive 使其永不断开，loopPromise 永不 resolve，stopClientAndWait 死锁。
  // 该检查与下方 fetch 之间无 await（同步段），stopClient 只能落在 fetch 之后命中新
  // controller，二者必居其一，窗口确定闭合。
  if (!running) return;
  streamAbort = new AbortController();
  const deviceName = os.hostname().slice(0, 60);
  const url = `${hubUrl()}/api/sync/events?node_id=${encodeURIComponent(currentNodeId())}&name=${encodeURIComponent(deviceName)}`;
  const res = await fetch(url, { headers: authHeaders(), signal: streamAbort.signal });
  if (!res.ok || !res.body) throw new Error(`事件流连接失败: ${res.status}`);
  connected = true;
  syncing = false;
  backoffMs = 1000;
  lastError = null;
  markConnected('事件流已建立');
  logEvent('info', 'connected', `已与中枢建立实时连接（本机设备名 ${deviceName}）`, {
    hub: hubUrl(),
    device: deviceName,
  });
  try {
    // 应用失败（含写盘异常）由回调经共享解析器向外抛：断开本条流，重连后从 cursor 重放
    await consumeSseStream(res.body, (_event, data) => {
      if (data && typeof data === 'object') applyRemoteOp(data);
    });
  } finally {
    connected = false;
    streamAbort = null;
  }
}

/** 全量对账：首次接入、手动触发、oplog 落后过多、周期自愈时使用（并发触发时仅跑一轮） */
export async function reconcile(reason: ReconcileReason = 'manual'): Promise<void> {
  if (reconcileRunning) return;
  reconcileRunning = true;
  const startedAt = Date.now();
  try {
    logEvent('info', 'reconcile-start', `开始全量对账（${REASON_LABELS[reason]}）`, { reason, label: REASON_LABELS[reason] });
    const snap = await getJson('/api/sync/snapshot');
    // 中枢已应答即视为已连接：首次接入的全量对账可能持续数分钟，此前不能显示「未连接」
    connected = true;
    markConnected('全量对账');
    const entries: {
      kind: 'page' | 'file';
      path: string;
      hash: string;
      revision: number;
      /** 中枢端该路径是否已提炼（旧中枢不带此字段 → 视为未知，跳过账本补齐） */
      distilled?: boolean;
    }[] = snap?.entries || [];
    const hubTargets = new Set(entries.map((e) => e.path));
    /**
     * 中枢见过、但当前不持有的路径（已删除、已改名移走的旧路径）。
     * 反向补推只对「中枢从没见过」的本端内容成立：把这类路径推回去等于让中枢
     * 复活已删页面并广播给所有端（成员停用期间中枢删页 → 重新接入即复活）。
     * 旧中枢不带该字段 → 视为空集，退回旧行为。
     */
    const hubStale = new Set<string>(Array.isArray(snap?.stale) ? snap.stale.map(String) : []);
    let pulled = 0;
    /** 本端补拉/补推的字节数（文件大小求和），对账摘要里显示，省得用户去猜同步了多少东西 */
    let pulledBytes = 0;
    let queued = 0;
    let itemFailed = 0;
    /** 对账涉及的具体文件名（各留前 3 个）：只写「拉取 4 项」用户不知道是哪些文件 */
    const pulledSamples: string[] = [];
    const queuedSamples: string[] = [];
    /** 中枢已提炼、本端账本缺失的来源路径：页面全部落位后统一补拉账本 */
    const ledgerRepairs: string[] = [];

    // hub → 本端
    for (const entry of entries) {
      try {
        // 「已提炼」标记不在页面/文件正文里，内容 hash 一致≠账本一致：
        // 本端账本为空就记下来，循环结束后按来源路径补（页面先到位，账本才挂得上）
        if (entry.distilled === true && !isDistilledPath(entry.path)) ledgerRepairs.push(entry.path);
        if (entry.kind === 'page') {
          const localRaw = readPageRaw(entry.path);
          if (localRaw !== null && sha256Text(localRaw) === entry.hash) {
            setPageSyncRevision(entry.path, entry.revision);
            continue;
          }
          if (localRaw !== null && getPageSyncRevision(entry.path) > 0) {
            // 两端都有且内容不同、本端同步过该页 → 推本端内容由 hub 裁决（离线改动不丢）
            queued++;
            pushSample(queuedSamples, entry.path);
            enqueueLocalChange('page', entry.path);
            continue;
          }
          // 本端没有、或从未同步过（首次接入）→ 以 hub 为准拉取
          const detail = await getJson(`/api/sync/page-content?path=${encodeURIComponent(entry.path)}`);
          applyRemotePage(entry.path, String(detail.content ?? ''), entry.revision);
          pulled++;
          pushSample(pulledSamples, entry.path);
        } else {
          let localHash = '';
          try {
            localHash = sha256Buf(fs.readFileSync(safeJoin(entry.path)));
          } catch { /* 本端没有 */ }
          if (localHash === entry.hash) {
            pendingFilePulls.delete(entry.path);
            continue;
          }
          if (localHash) {
            // 两端文件不同 → 本端为准推送（文件不可合并，按到达先后覆盖）
            queued++;
            pushSample(queuedSamples, entry.path);
            enqueueLocalChange('file', entry.path);
            continue;
          }
          pulledBytes += await pullFile(entry.path);
          pendingFilePulls.delete(entry.path);
          pulled++;
          pushSample(pulledSamples, entry.path);
        }
      } catch (error: any) {
        lastError = String(error?.message || error);
        itemFailed++;
        logEvent('warn', 'reconcile-item-failed', `「${entry.path}」对账没对上：${lastError}（已跳过，下一轮对账会再试一次）`, {
          kind: entry.kind,
          path: entry.path,
          error: lastError,
        });
      }
    }

    // 会话与看板：与页面/文件同一轮对账
    //  - 中枢清单里的会话：指纹不一致才拉完整快照合并（指纹是一条 SQL 聚合，不搬正文）
    //  - 中枢已删的会话（墓碑）：本端副本更旧就删掉，否则下面的补推会把它复活
    //  - 本端有、中枢没有的会话：补推（首次接入、中枢重装时的追赶）
    //  - 看板：全端唯一一份，谁的最新用谁
    const hubSessions: Array<{ id: string; title?: string; hash?: string }> = Array.isArray(snap?.sessions)
      ? snap.sessions
      : [];
    const hubSessionIds = new Set(hubSessions.map((item) => String(item.id)));
    const hubTombstones: Array<{ sessionId: string; deletedAt: string }> = Array.isArray(snap?.tombstones)
      ? snap.tombstones
      : [];
    const hubTombstoneIds = new Set(hubTombstones.map((item) => String(item.sessionId)));
    let sessionsPulled = 0;
    for (const entry of hubSessions) {
      const id = String(entry.id || '');
      if (!id || hubTombstoneIds.has(id)) continue;
      try {
        if (sessionFingerprint(id) === String(entry.hash || '')) continue;
        const detail = await getJson(`/api/sync/session?id=${encodeURIComponent(id)}`);
        const snapshot = detail?.snapshot as SessionSnapshot | undefined;
        if (!snapshot) continue;
        mergeSessionSnapshot(snapshot, '', '');
        pendingSessionPulls.delete(id);
        sessionsPulled++;
      } catch (error: any) {
        itemFailed++;
        logEvent('warn', 'reconcile-item-failed', `会话「${entry.title || id}」对账没对上：${error?.message || error}（已跳过，下一轮对账会再试一次）`, {
          kind: 'session',
          path: id,
          error: String(error?.message || error),
        });
      }
    }
    for (const item of hubTombstones) {
      const id = String(item.sessionId || '');
      if (!id) continue;
      const localUpdatedAt = sessionUpdatedAt(id);
      if (!localUpdatedAt || !item.deletedAt || localUpdatedAt > item.deletedAt) continue;
      deleteSessionWithTombstone(id, '');
      emit('session-changed', { id, deleted: true });
    }
    for (const entry of sessionManifest()) {
      if (hubSessionIds.has(entry.id) || hubTombstoneIds.has(entry.id)) continue;
      queued++;
      pushSample(queuedSamples, entry.title || entry.id);
      enqueueLocalChange('session', entry.id);
    }
    {
      const localBoard = collectBoardPayload();
      const hubBoard = snap?.board as BoardPayload | undefined;
      if (localBoard && (!hubBoard || boardWins(localBoard, hubBoard))) {
        queued++;
        pushSample(queuedSamples, '任务看板');
        enqueueLocalChange('board', BOARD_SYNC_ID);
      } else if (hubBoard && mergeBoardPayload(hubBoard)) {
        emit('board-changed', { from: String(hubBoard.nodeId || '') });
      }
    }

    // 本端 → hub：只补推 hub「从没见过」的页面/文件。hub 报过的已删/已改名旧路径不推，
    // 否则等于把中枢已删页面复活并广播给所有端（成员停用期间中枢删页 → 重新接入即复活）。
    const localEntries = localSnapshot();
    for (const entry of localEntries) {
      if (hubTargets.has(entry.path) || hubStale.has(entry.path)) continue;
      queued++;
      pushSample(queuedSamples, entry.path);
      enqueueLocalChange(entry.kind, entry.path);
    }
    // 证据账本补齐：中枢已提炼而本端账本为空（载体页面 op 早已被 oplog 裁剪、或本端是后加入的）。
    // 排在页面拉取之后——贡献按页路径落位，页面到位才能挂上；但产物页面在中枢已删除时
    // 本端永远不会有该页，此时快照里的 active 版本行也已足以恢复「已提炼」标记
    // （isDistilledPath 认版本行）。这一步可重复执行（applyEvidenceSnapshot 按来源路径精确替换）。
    let repaired = 0;
    for (const sourcePath of ledgerRepairs) {
      try {
        const res = await getJson(`/api/sync/evidence?path=${encodeURIComponent(sourcePath)}`);
        const snapshot = (res?.snapshot || null) as EvidenceSnapshot | null;
        if (snapshot) {
          applyEvidenceSnapshot(snapshot);
          if (isDistilledPath(sourcePath)) repaired++;
        }
      } catch (error: any) {
        logEvent('warn', 'ledger-repair-failed', `「${sourcePath}」的提炼账本没能补上：${error?.message || error}（下轮对账会再试）`, {
          path: sourcePath,
          error: error?.message || String(error),
        });
      }
    }
    const ms = Date.now() - startedAt;
    lastSyncAt = new Date().toISOString();
    logEvent(
      'info',
      'reconcile-done',
      `全量对账完成（${REASON_LABELS[reason]}，${formatDuration(ms)}）：中枢共 ${entries.length} 项 · 从中枢拉取 ${pulled} 项${pulledBytes ? `（${formatBytes(pulledBytes)}）` : ''}${sampleText(pulledSamples)} · 本机补推 ${queued} 项${sampleText(queuedSamples)} · 失败 ${itemFailed} 项 · 待补拉文件 ${pendingFilePulls.size} · 补齐提炼账本 ${repaired}/${ledgerRepairs.length}`,
      {
        reason,
        ms,
        hubEntries: entries.length,
        pulled,
        pulledBytes,
        queued,
        failed: itemFailed,
        pendingPulls: pendingFilePulls.size,
        ledgerRepaired: repaired,
        ledgerTotal: ledgerRepairs.length,
        localEntries: localEntries.length,
        pulledSamples,
        queuedSamples,
      }
    );
    await pushLoop();
  } catch (error: any) {
    logEvent('error', 'reconcile-failed', `全量对账失败（${REASON_LABELS[reason]}）：${error?.message || error}；本端内容保持原样，联网后会自动重试`, {
      reason,
      error: error?.message || String(error),
      ms: Date.now() - startedAt,
    });
    throw error;
  } finally {
    reconcileRunning = false;
  }
}

/** 本端 brain 目录全量清单（页面取 raw 文本 hash，文件取字节 hash）；路径经 safeJoin 限定在根目录内 */
function localSnapshot(): { kind: 'page' | 'file'; path: string; hash: string }[] {
  const out: { kind: 'page' | 'file'; path: string; hash: string }[] = [];
  function walk(rel: string): void {
    const absDir = safeJoin(rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? toRel(safeJoin(`${rel}/${e.name}`)) : e.name;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (classifyBrainEntry(childRel) === 'page') {
        out.push({ kind: 'page', path: childRel, hash: sha256Text(fs.readFileSync(safeJoin(childRel), 'utf8')) });
      } else {
        out.push({ kind: 'file', path: childRel, hash: sha256Buf(fs.readFileSync(safeJoin(childRel))) });
      }
    }
  }
  walk('');
  return out;
}

/**
 * 拉一个会话的完整快照并合并；远端 hash 与本端一致时直接跳过（省一趟请求）。
 * 与文件拉取同构：失败由调用方记入 pendingSessionPulls，由 retryPendingPulls 周期重试。
 */
async function pullSessionIfChanged(
  sessionId: string,
  remoteHash: string,
  nodeId: string,
  nodeLabel: string
): Promise<boolean> {
  if (!sessionId) return false;
  if (remoteHash && remoteHash === sessionContentHash(sessionId)) return false;
  let snapshot: SessionSnapshot | undefined;
  try {
    const res = await getJson(`/api/sync/session?id=${encodeURIComponent(sessionId)}`);
    snapshot = res?.snapshot as SessionSnapshot | undefined;
  } catch (error: any) {
    // 中枢已经删掉这个会话（清单是拉取前取的）：没有可拉的内容，不算失败、不进待补拉
    if (String(error?.message || '').includes('404')) {
      pendingSessionPulls.delete(sessionId);
      return false;
    }
    throw error;
  }
  if (!snapshot) return false;
  const merged = mergeSessionSnapshot(snapshot, nodeId, nodeLabel);
  pendingSessionPulls.delete(sessionId);
  emit('session-changed', { id: sessionId, created: merged.created, messages: merged.messages });
  return true;
}

/** 重试此前拉取失败的文件与会话（成功移出集合；失败留待下一轮） */
async function retryPendingFilePulls(): Promise<void> {
  if (pendingFilePulls.size === 0 && pendingSessionPulls.size === 0) return;
  for (const [relPath, hash] of Array.from(pendingFilePulls)) {
    try {
      const bytes = await pullFileIfChanged(relPath, hash);
      pendingFilePulls.delete(relPath);
      logEvent('info', 'file-pull-retry-ok', `补拉文件成功 ${relPath}${bytes ? `（${formatBytes(bytes)}）` : ''}`, {
        path: relPath,
        bytes,
        pending: pendingFilePulls.size,
      });
    } catch (error: any) {
      logEvent('warn', 'file-pull-retry-failed', `补拉文件仍失败 ${relPath}：${error?.message || error}`, {
        path: relPath,
        error: error?.message || String(error),
        pending: pendingFilePulls.size,
      });
    }
  }
  // 会话快照与文件同一节拍补拉：会话正文更大，一次失败不该让它永远停在「历史不全」的状态
  for (const [sessionId, hash] of Array.from(pendingSessionPulls)) {
    try {
      await pullSessionIfChanged(sessionId, hash, '', '');
      pendingSessionPulls.delete(sessionId);
      logEvent('info', 'session-pull-retry-ok', `补拉会话成功「${sessionId}」`, {
        session: sessionId,
        pending: pendingSessionPulls.size,
      });
    } catch (error: any) {
      logEvent('warn', 'session-pull-retry-failed', `补拉会话仍失败「${sessionId}」：${error?.message || error}`, {
        session: sessionId,
        error: error?.message || String(error),
        pending: pendingSessionPulls.size,
      });
    }
  }
}

/** 周期自愈：全量对账兜底未知路径的漏同步（SSE/补拉都修不了的静默不一致） */
const HEAL_INTERVAL_MS = 15 * 60_000;
const PULL_RETRY_MS = 60_000;

function isSelfAbort(error: any): boolean {
  return error?.name === 'AbortError';
}

async function runLoop(): Promise<void> {
  while (running) {
    try {
      await syncMissedChanges();
      await pushLoop();
      await retryPendingFilePulls();
      await consumeStream();
    } catch (error: any) {
      // 停用/改配置导致的主动中断不是故障：不写「最近错误」，避免误报
      if (!isSelfAbort(error)) {
        connected = false;
        lastError = String(error?.message || error);
        markDisconnected(error);
        // 断联要写清「断了多久、为什么、本地改动会不会丢」：队列里的改动等重连后自动补推
        const downFor = disconnectedSince ? formatDuration(Date.now() - disconnectedSince) : '刚刚';
        logEvent('warn', 'disconnected', `与中枢的联系中断（已持续 ${downFor}，第 ${disconnectAttempts} 次重试）：${lastError}；${Math.round(backoffMs / 1000)} 秒后自动重连`
          + `${queue.length ? `，本机 ${queue.length} 项改动仍保存在本地，连上后自动补推` : ''}`, {
          error: lastError,
          backoffMs,
          attempts: disconnectAttempts,
          pending: queue.length,
          downMs: disconnectedSince ? Date.now() - disconnectedSince : 0,
        });
      }
    }
    if (!running) break;
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

export function startClient(): void {
  if (running) return;
  running = true;
  // 引导阶段开始：全量对账 + 从头补拉走完、SSE 连上之前，面板显示「同步中」
  syncing = true;
  backoffMs = 1000;
  pushRetryMs = 3000;
  logEvent('info', 'start', `同步客户端启动（节点 ${currentNodeId().slice(0, 8)}）`, {
    node: currentNodeId(),
    hub: hubUrl(),
  });
  loopPromise = runLoop();
  loopPromise.catch(() => {
    running = false;
  });
  if (pullRetryTimer) clearInterval(pullRetryTimer);
  pullRetryTimer = setInterval(() => {
    void retryPendingFilePulls();
  }, PULL_RETRY_MS);
  pullRetryTimer.unref();
  if (healTimer) clearInterval(healTimer);
  healTimer = setInterval(() => {
    if (!running) return;
    void reconcile('heal').catch(() => { /* reconcile 内部已记日志 */ });
  }, HEAL_INTERVAL_MS);
  healTimer.unref();
}

export function stopClient(): void {
  const wasRunning = running;
  running = false;
  connected = false;
  syncing = false;
  if (wasRunning) logEvent('info', 'stopped', '同步客户端已停止', { pending: queue.length, pendingPulls: pendingFilePulls.size });
  if (pullRetryTimer) {
    clearInterval(pullRetryTimer);
    pullRetryTimer = null;
  }
  if (healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
  // 唤醒可能在退避 sleep 中的后台循环，让它立即观察到 running=false
  try {
    sleepAbort?.();
  } catch { /* already done */ }
  try {
    streamAbort?.abort();
  } catch { /* 已结束 */ }
}

/**
 * 首次接入引导开始：reinitClient 在「对账 → 进常驻循环」之前调用。
 * 面板据此在整段引导期间显示「同步中」，而不是在中枢已应答、内容正在进来时显示「未连接」。
 */
export function beginBootstrap(): void {
  syncing = true;
}

export function clientStatus(): ClientStatus {
  return {
    enabled: syncConfigEnabled(),
    connected,
    syncing,
    reconciling: reconcileRunning,
    hubUrl: hubUrl(),
    hubToken: hubToken(),
    nodeId: currentNodeId(),
    cursor: getCursor(),
    pending: queue.length,
    pendingPulls: pendingFilePulls.size,
    lastSyncAt,
    lastError,
    // 兼容旧口径：/api/sync/status 仍带最近 200 条；完整分页/筛选走 /api/sync/log
    log: recentSyncLog(200),
  };
}

/** 等待后台循环退出（配置变更/测试收尾用） */
export async function stopClientAndWait(): Promise<void> {
  stopClient();
  try {
    await loopPromise;
  } catch { /* 循环内已兜底 */ }
  loopPromise = null;
}
