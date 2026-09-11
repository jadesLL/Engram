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
  nodeId: string;
  cursor: number;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
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

/** 应用一条 hub 广播/补拉 op（seq 单调 guard 防重复应用） */
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
      // 文件不进内存队列：hash 不同才拉取（失败由对账兜底）
      pullFileIfChanged(target, String(op.hash || '')).catch(() => { /* 对账兜底 */ });
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
  } finally {
    if (seq > 0) setCursor(seq);
    lastSyncAt = new Date().toISOString();
  }
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
        // 网络/hub 错误：塞回队首保序；3 秒后自动重试（不再依赖下一次入队或重连触发）
        queue.unshift(item);
        lastError = String(error?.message || error);
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void pushLoop();
          }, 3000);
        }
        return;
      }
    }
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
  for (;;) {
    const res = await getJson(`/api/sync/changes?since=${getCursor()}`);
    if (res?.resync) {
      await reconcile();
      return;
    }
    const ops: any[] = res?.ops || [];
    for (const op of ops) applyRemoteOp(op);
    if (ops.length < 500) return;
  }
}

/** 解析 SSE 字节流（事件流断开或出错时返回，重连由 runLoop 负责） */
async function consumeStream(): Promise<void> {
  streamAbort = new AbortController();
  const deviceName = os.hostname().slice(0, 60);
  const url = `${hubUrl()}/api/sync/events?node_id=${encodeURIComponent(currentNodeId())}&name=${encodeURIComponent(deviceName)}`;
  const res = await fetch(url, { headers: authHeaders(), signal: streamAbort.signal });
  if (!res.ok || !res.body) throw new Error(`事件流连接失败: ${res.status}`);
  connected = true;
  backoffMs = 1000;
  lastError = null;
  try {
    await consumeSseStream(res.body, (_event, data) => {
      if (data && typeof data === 'object') applyRemoteOp(data);
    });
  } finally {
    connected = false;
    streamAbort = null;
  }
}

/** 全量对账：首次接入、手动触发、oplog 落后过多时使用 */
export async function reconcile(): Promise<void> {
  const snap = await getJson('/api/sync/snapshot');
  const entries: { kind: 'page' | 'file'; path: string; hash: string; revision: number }[] = snap?.entries || [];
  const hubTargets = new Set(entries.map((e) => e.path));

  // hub → 本端
  for (const entry of entries) {
    try {
      if (entry.kind === 'page') {
        const localRaw = readPageRaw(entry.path);
        if (localRaw !== null && sha256Text(localRaw) === entry.hash) {
          setPageSyncRevision(entry.path, entry.revision);
          continue;
        }
        if (localRaw !== null && getPageSyncRevision(entry.path) > 0) {
          // 两端都有且内容不同、本端同步过该页 → 推本端内容由 hub 裁决（离线改动不丢）
          enqueueLocalChange('page', entry.path);
          continue;
        }
        // 本端没有、或从未同步过（首次接入）→ 以 hub 为准拉取
        const detail = await getJson(`/api/sync/page-content?path=${encodeURIComponent(entry.path)}`);
        applyRemotePage(entry.path, String(detail.content ?? ''), entry.revision);
      } else {
        let localHash = '';
        try {
          localHash = sha256Buf(fs.readFileSync(safeJoin(entry.path)));
        } catch { /* 本端没有 */ }
        if (localHash === entry.hash) continue;
        if (localHash) {
          // 两端文件不同 → 本端为准推送（文件不可合并，按到达先后覆盖）
          enqueueLocalChange('file', entry.path);
          continue;
        }
        await pullFile(entry.path);
      }
    } catch (error: any) {
      lastError = String(error?.message || error);
    }
  }

  // 本端 → hub：hub 没有的页面/文件推上去
  const localEntries = localSnapshot();
  for (const entry of localEntries) {
    if (!hubTargets.has(entry.path)) enqueueLocalChange(entry.kind, entry.path);
  }
  lastSyncAt = new Date().toISOString();
  await pushLoop();
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

/**
 * 本模块内 AbortError 只可能来自 stopClient() 主动中止在途 SSE 读
 * （真实网络故障是 TypeError: fetch failed / terminated），故不作为同步错误上报
 */
function isSelfAbort(error: any): boolean {
  return error?.name === 'AbortError';
}

async function runLoop(): Promise<void> {
  while (running) {
    try {
      await syncMissedChanges();
      await pushLoop();
      await consumeStream();
    } catch (error: any) {
      // 停用/改配置导致的主动中断不是故障：不写「最近错误」，避免误报
      if (!isSelfAbort(error)) lastError = String(error?.message || error);
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
  loopPromise = runLoop();
  loopPromise.catch(() => {
    running = false;
  });
}

export function stopClient(): void {
  running = false;
  connected = false;
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
    nodeId: currentNodeId(),
    cursor: getCursor(),
    pending: queue.length,
    lastSyncAt,
    lastError,
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
