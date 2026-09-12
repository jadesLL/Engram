import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { emit } from '../lib/events.js';
import { getSetting } from '../lib/db.js';
import { consumeSseStream } from '../lib/sseStream.js';
import { safeJoin, syncPageFile, movePage, toRel } from '../lib/vault.js';
import { moveToTrash } from '../lib/trash.js';
import { enqueuePagePipeline } from '../jobs.js';
import { applyEvidenceSnapshot, collectEvidenceForPage, type EvidenceSnapshot } from './rows.js';
import { isDistilledPath } from '../pipeline/sourceLedger.js';
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

export function syncConfigEnabled(): boolean {
  return getSetting('sync_enabled') === '1' && Boolean(getSetting('sync_hub_url')) && Boolean(getSetting('sync_hub_token'));
}

/** 是否配置过 hub 连接（含停用状态）：配置过 hub 的实例永远不充当 hub 角色 */
export function hubConfigured(): boolean {
  return Boolean(getSetting('sync_hub_url'));
}

export function isNodeMode(): boolean {
  return syncConfigEnabled();
}

interface QueueItem {
  kind: SyncKind;
  target: string;
  oldPath?: string;
}

const queue: QueueItem[] = [];
const pendingTargets = new Set<string>();
/** 推送在途期间收到的同页广播（等 ack 后按版本决定是否应用） */
const stashed = new Map<string, { seq: number; kind: SyncKind; target: string; old_path: string; revision: number; content?: string; evidence?: EvidenceSnapshot }>();

let running = false;
let connected = false;
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
let pullRetryTimer: ReturnType<typeof setInterval> | null = null;
let healTimer: ReturnType<typeof setInterval> | null = null;
let reconcileRunning = false;

// ---------- 同步事件日志（内存环形缓冲，/api/sync/status 暴露给前端排查） ----------

export interface SyncLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail?: string;
}

const SYNC_LOG_KEEP = 200;
const syncLog: SyncLogEntry[] = [];

function logEvent(level: SyncLogEntry['level'], event: string, detail?: string): void {
  syncLog.push({ ts: new Date().toISOString(), level, event, detail: detail?.slice(0, 500) });
  if (syncLog.length > SYNC_LOG_KEEP) syncLog.splice(0, syncLog.length - SYNC_LOG_KEEP);
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

async function pullFile(relPath: string): Promise<void> {
  const res = await fetch(hubUrl() + `/api/sync/file?path=${encodeURIComponent(relPath)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`拉取文件失败 ${res.status}: ${relPath}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const abs = safeJoin(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${Date.now()}.sync.tmp`;
  fs.writeFileSync(temp, buf);
  fs.renameSync(temp, abs);
  // 原始资料文件拉取后补调度文本提取（与启动扫描/上传路径同一套机制）
  try {
    const { supportsFileExtraction, scheduleFileExtraction } = await import('../pipeline/fileExtraction.js');
    if (supportsFileExtraction(relPath)) scheduleFileExtraction(relPath, { mode: 'auto' });
  } catch { /* 非原始资料目录或提取模块不可用时忽略 */ }
  lastSyncAt = new Date().toISOString();
}

/** 应用一条 hub 广播/补拉 op（seq 单调 guard 防重复应用）。
 *  cursor 只在应用成功后推进：page 应用失败向上抛断开事件流，重连后从 cursor 重放，
 *  避免「失败也前推水位」造成静默丢更新（对齐 fast-note-sync 的未确认不算完成语义） */
function applyRemoteOp(op: any): void {
  const seq = Number(op.seq || 0);
  if (seq <= getCursor()) return;
  const target = String(op.target || '');
  try {
    if (op.kind === 'page') {
      if (pendingTargets.has(target)) {
        // 本端同页有推送在途：暂存，等 ack 后按版本决定
        const prev = stashed.get(target);
        if (!prev || seq > prev.seq) {
          stashed.set(target, { seq, kind: 'page', target, old_path: '', revision: Number(op.revision || 0), content: op.content, evidence: op.evidence });
        }
      } else {
        applyRemotePage(target, String(op.content ?? ''), Number(op.revision || 0));
        if (op.evidence) applyEvidenceSnapshot(op.evidence);
      }
    } else if (op.kind === 'file') {
      // 文件不进内存队列：hash 不同才拉取；失败记入待补拉集合周期重试（水位照常推进）
      void pullFileIfChanged(target, String(op.hash || '')).catch(() => {
        pendingFilePulls.set(target, String(op.hash || ''));
        logEvent('warn', 'file-pull-deferred', target);
      });
    } else if (op.kind === 'delete') {
      try {
        moveToTrash(target, 'sync');
      } catch { /* 本端没有该文件/已删除 */ }
    } else if (op.kind === 'move') {
      try {
        movePage(String(op.old_path || ''), target, 'sync');
        setPageSyncRevision(target, Number(op.revision || 0));
      } catch { /* 源不存在时忽略（后续内容同步会补齐新路径） */ }
    }
  } catch (error: any) {
    logEvent('error', 'apply-failed', `${op.kind} ${target}: ${error?.message || error}`);
    throw error;
  }
  if (seq > 0) setCursor(seq);
  lastSyncAt = new Date().toISOString();
}

async function pullFileIfChanged(relPath: string, remoteHash: string): Promise<void> {
  try {
    const buf = fs.readFileSync(safeJoin(relPath));
    if (remoteHash && sha256Buf(buf) === remoteHash) return;
  } catch {
    // 本端没有该文件 → 拉取
  }
  if (!remoteHash) return;
  await pullFile(relPath);
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

async function pushOne(item: QueueItem): Promise<void> {
  pendingTargets.add(item.target);
  try {
    if (item.kind === 'page') {
      const raw = readPageRaw(item.target);
      if (raw === null) return; // 本地文件已消失（如已被删除入队）→ 丢弃
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
      if (res.content !== undefined && res.content !== raw) {
        applyRemotePage(item.target, String(res.content), ackedRevision);
      } else {
        setPageSyncRevision(item.target, ackedRevision);
      }
      drainStash(item.target, ackedRevision);
    } else if (item.kind === 'file') {
      const buf = fs.readFileSync(safeJoin(item.target));
      const form = new FormData();
      form.append('path', item.target);
      form.append('node_id', currentNodeId());
      form.append('file', new Blob([new Uint8Array(buf)]), path.basename(item.target));
      const res = await fetch(hubUrl() + '/api/sync/file', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      if (!res.ok) throw new Error(`文件推送失败 ${res.status}: ${item.target}`);
    } else if (item.kind === 'delete') {
      await postJson('/api/sync/push', { node_id: currentNodeId(), kind: 'delete', target: item.target });
    } else if (item.kind === 'move') {
      await postJson('/api/sync/push', {
        node_id: currentNodeId(),
        kind: 'move',
        target: item.target,
        old_path: item.oldPath || '',
      });
    }
    lastSyncAt = new Date().toISOString();
  } finally {
    pendingTargets.delete(item.target);
  }
}

async function pushLoop(): Promise<void> {
  if (pushing) return;
  pushing = true;
  try {
    while (queue.length > 0) {
      // 先出队再推送：推送在途时同目标的新写入仍可入队（否则最新内容会被去重吞掉）
      const item = queue.shift()!;
      try {
        await pushOne(item);
      } catch (error: any) {
        if (item.kind === 'page' && readPageRaw(item.target) === null) {
          continue;
        }
        if (item.kind === 'file' && !fs.existsSync(safeJoin(item.target))) {
          continue;
        }
        // 网络/hub 错误：塞回队首保序，指数退避后自动重试（3s→30s，成功复位）
        queue.unshift(item);
        lastError = String(error?.message || error);
        logEvent('warn', 'push-retry', `${item.kind} ${item.target}: ${lastError}（${Math.round(pushRetryMs / 1000)}s 后重试，队列 ${queue.length} 项）`);
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
  } finally {
    pushing = false;
  }
}

/** 本端变更入队（sync/index.ts 调用）：同类内容操作按 target 去重（后写为准），move/delete 不合并保序 */
export function enqueueLocalChange(kind: SyncKind, target: string, oldPath?: string): void {
  if (kind === 'page' || kind === 'file') {
    if (!queue.some((item) => item.kind === kind && item.target === target)) {
      queue.push({ kind, target, oldPath });
    }
  } else {
    queue.push({ kind, target, oldPath });
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
    if (res?.resync) gap = true;
    const ops: any[] = res?.ops || [];
    if (ops.length > 0) logEvent('info', 'replay', `补拉 ${ops.length} 条远端变更（自水位 ${getCursor()}）`);
    for (const op of ops) applyRemoteOp(op);
    if (ops.length < 500) break;
  }
  if (gap) {
    logEvent('info', 'oplog-trimmed', `落后超过保留窗口，补一次全量对账补齐内容与提炼账本（cursor=${getCursor()}）`);
    await reconcile();
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
  backoffMs = 1000;
  lastError = null;
  logEvent('info', 'connected', `中枢事件流已连接`);
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
export async function reconcile(): Promise<void> {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    logEvent('info', 'reconcile-start');
    const snap = await getJson('/api/sync/snapshot');
    const entries: {
      kind: 'page' | 'file';
      path: string;
      hash: string;
      revision: number;
      /** 中枢端该路径是否已提炼（旧中枢不带此字段 → 视为未知，跳过账本补齐） */
      distilled?: boolean;
    }[] = snap?.entries || [];
    const hubTargets = new Set(entries.map((e) => e.path));
    let pulled = 0;
    let queued = 0;
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
            enqueueLocalChange('page', entry.path);
            continue;
          }
          // 本端没有、或从未同步过（首次接入）→ 以 hub 为准拉取
          const detail = await getJson(`/api/sync/page-content?path=${encodeURIComponent(entry.path)}`);
          applyRemotePage(entry.path, String(detail.content ?? ''), entry.revision);
          pulled++;
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
            enqueueLocalChange('file', entry.path);
            continue;
          }
          await pullFile(entry.path);
          pendingFilePulls.delete(entry.path);
          pulled++;
        }
      } catch (error: any) {
        lastError = String(error?.message || error);
        logEvent('warn', 'reconcile-item-failed', `${entry.kind} ${entry.path}: ${lastError}`);
      }
    }

    // 本端 → hub：hub 没有的页面/文件推上去
    const localEntries = localSnapshot();
    for (const entry of localEntries) {
      if (!hubTargets.has(entry.path)) {
        queued++;
        enqueueLocalChange(entry.kind, entry.path);
      }
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
        logEvent('warn', 'ledger-repair-failed', `${sourcePath}: ${error?.message || error}`);
      }
    }
    lastSyncAt = new Date().toISOString();
    logEvent(
      'info',
      'reconcile-done',
      `hub ${entries.length} 项：拉取 ${pulled}、入队补推 ${queued}、待补拉文件 ${pendingFilePulls.size}、补齐提炼账本 ${repaired}/${ledgerRepairs.length}`
    );
    await pushLoop();
  } catch (error: any) {
    logEvent('error', 'reconcile-failed', String(error?.message || error));
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
      } else if (e.name.toLowerCase().endsWith('.md')) {
        out.push({ kind: 'page', path: childRel, hash: sha256Text(fs.readFileSync(safeJoin(childRel), 'utf8')) });
      } else {
        out.push({ kind: 'file', path: childRel, hash: sha256Buf(fs.readFileSync(safeJoin(childRel))) });
      }
    }
  }
  walk('');
  return out;
}

/** 重试此前拉取失败的文件（成功移出集合；失败留待下一轮） */
async function retryPendingFilePulls(): Promise<void> {
  if (pendingFilePulls.size === 0) return;
  for (const [relPath, hash] of Array.from(pendingFilePulls)) {
    try {
      await pullFileIfChanged(relPath, hash);
      pendingFilePulls.delete(relPath);
      logEvent('info', 'file-pull-retry-ok', relPath);
    } catch {
      logEvent('warn', 'file-pull-retry-failed', relPath);
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
        lastError = String(error?.message || error);
        logEvent('warn', 'disconnected', `${lastError}（${Math.round(backoffMs / 1000)}s 后重连）`);
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
  backoffMs = 1000;
  pushRetryMs = 3000;
  logEvent('info', 'start', `同步客户端启动（节点 ${currentNodeId().slice(0, 8)}）`);
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
    logEvent('info', 'heal', '周期自愈对账触发');
    void reconcile().catch(() => { /* reconcile 内部已记日志 */ });
  }, HEAL_INTERVAL_MS);
  healTimer.unref();
}

export function stopClient(): void {
  running = false;
  connected = false;
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

export function clientStatus(): ClientStatus {
  return {
    enabled: syncConfigEnabled(),
    connected,
    hubUrl: hubUrl(),
    hubToken: hubToken(),
    nodeId: currentNodeId(),
    cursor: getCursor(),
    pending: queue.length,
    pendingPulls: pendingFilePulls.size,
    lastSyncAt,
    lastError,
    log: syncLog.slice(),
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
