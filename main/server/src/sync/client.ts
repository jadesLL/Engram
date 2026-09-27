import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { FormData as UndiciFormData } from 'undici';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { getSetting, setSetting } from '../lib/db.js';
import { lookup } from 'node:dns/promises';
import { consumeSseStream } from '../lib/sseStream.js';
import { dualStackConfig, dualStackFetch, dualStackStatus, type HostFamilyStatus } from './dualStack.js';
import {
  classifyBase,
  hostOf,
  hostnameOf,
  normalizeAnnouncedLan,
  pickWinner,
  planProbes,
  type SyncChannelKind,
  type SyncLinkCandidate,
  type SyncLinkStatus,
} from './link.js';
import { safeJoin, syncPageFile, movePage, toRel, markPageDeleted, PagePathTakenError } from '../lib/vault.js';
import { classifyBrainEntry, isInboxPath } from '../lib/brainPaths.js';
import { moveToTrash } from '../lib/trash.js';
import { enqueuePagePipeline } from '../jobs.js';
import { applyEvidenceSnapshot, collectEvidenceForPage, type EvidenceSnapshot } from './rows.js';
import { formatBytes, formatDuration, logSyncEvent, recentSyncLog, type SyncLogEntry } from './eventLog.js';
import { describeOpList, describeOpSummary, flattenChangeLines, formatLineDelta, isNoteworthyOp, pickReplaySamples, summarizeBoardChange, summarizeDelete, summarizeMove, summarizePageChange, summarizeSessionChange, type SyncOpSummary } from './opText.js';
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
  repairSessionOriginLabel,
  sessionContentHash,
  sessionFingerprint,
  sessionManifest,
  sessionUpdatedAt,
  type BoardPayload,
  type SessionSnapshot,
} from './sessions.js';
import { HUB_DEVICE_LABEL, learnDeviceLabelFromHub } from './deviceLabel.js';
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
  /** 当前连接通道（局域网 / IPv6 / IPv4 / 断开）与候选探测明细；未启用同步时为 null */
  link: SyncLinkStatus | null;
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
/** 会话快照待补拉（远端 hash + 来源端），成功后移除（会话正文比文件大，失败必须留待重试；
 *  来源端一并留着——补拉同样要能标出「来自哪台设备」，不能因为是重试就把来源丢了） */
const pendingSessionPulls = new Map<string, { hash: string; nodeId: string; nodeLabel: string }>();
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
  // 通道记账可能还停在上一次失败上（比如中枢刚重启：数据面已经通了，但最近一轮探测还是「都不通」）：
  // 这时补一次探测把状态追上，否则界面会显示「已断开」而同步其实正常。
  // 探测自带 20 秒节流，不会因为这里被高频调用而变吵。
  if (linkChannel === 'offline') void probeLinkChannel();
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

/**
 * 补拉条目的人话描述：拿本端当前内容当基准，说清「中枢把哪个文件改成了什么样」。
 * 页面条目同时把改动正文采样带出来（返回的 summary），补拉记录才能列出「改了什么」。
 */
function describeReplayOp(op: any): { text: string; summary: SyncOpSummary | null } {
  const target = String(op.target || '');
  const kind = String(op.kind || '');
  if (kind === 'page') {
    const before = readPageRaw(target);
    const after = String(op.content ?? '');
    const summary = summarizePageChange(target, before, after);
    if (summary.verb === 'same') return { text: `页面「${summary.title}」正文与中枢一致（只推进版本号）`, summary: null };
    return {
      text: `中枢${summary.verb === 'add' ? '新增' : '修改'}页面「${summary.title}」（${formatLineDelta(summary.added, summary.removed)}）`,
      summary,
    };
  }
  if (kind === 'delete') return { text: `中枢删除「${target}」`, summary: null };
  if (kind === 'move') return { text: `中枢改名「${String(op.old_path || '')}」→「${target}」`, summary: null };
  if (kind === 'file') return { text: `中枢更新文件「${target}」`, summary: null };
  return { text: `${kind} ${target}`, summary: null };
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

/**
 * ── 连接通道择优：局域网 → IPv6 → IPv4（都不通即「已断开」） ─────────────────────────
 *
 * 中枢在 /api/sync/announce 里通告自己的内网地址；成员端把「内网地址 + 中枢主地址」排成
 * 候选逐个探测（1.5 秒超时），第一个通的作为当前通道。于是家里/公司这类同网段场景自动走
 * 局域网直连（低延迟、不占公网、不绕隧道），出门（蜂窝/别处 Wi-Fi）自动回到主地址，再由
 * 双栈策略选 IPv6/IPv4。**探不到局域网时行为与历史版本完全一致**——跨网段、容器网络、
 * VPN、蜂窝网络都会自然落到这条路上。
 *
 * 通道判定的来源要诚实，界面才不说谎：
 *  - 局域网：候选本身是内网字面量，连上即局域网；
 *  - IPv6/IPv4：走主地址时取双栈记账（设置页「双栈连接」显示的就是它）；
 *    双栈策略被显式关掉时没有记账，退回按域名解析出的协议族判断；
 *  - 断开：候选全部探测失败（保留原地址继续重试，本机改动照常排队）。
 *
 * 探测只打中枢自己的通告端点（带令牌），不做网段扫描、不多播发现——Android 权限与
 * Docker 容器多播都不好搞，而「中枢通告 + 成员探测」已经够用且代价可控。
 */

/** 探测节流：断线重连循环每轮都重探一遍会让退避失去意义 */
const LINK_PROBE_MIN_INTERVAL_MS = 20_000;
/** 局域网候选的探测超时：不可路由地址通常毫秒级失败，1.5 秒足够 */
const LINK_PROBE_LAN_TIMEOUT_MS = 1500;
/** 健康期间的定期复探：从公司回到家、或局域网恢复后要能自动升回局域网 */
const LINK_REPROBE_INTERVAL_MS = 10 * 60_000;
/** 中枢通告的内网地址在这里落一份：重启后第一轮就能走局域网，不必先绕一次公网 */
const LINK_LAN_URLS_SETTING = 'sync_lan_urls';
/** 「优先局域网」开关（设置页「局域网优先」）：只有显式存过 '0' 才算关，老库默认开 */
const LINK_PREFER_LAN_SETTING = 'sync_prefer_lan';

const CHANNEL_LABELS: Record<SyncChannelKind, string> = {
  lan: '局域网直连',
  ipv6: 'IPv6 直连',
  ipv4: 'IPv4 直连',
  offline: '未连接',
};

/** 当前实际在用的基地址；null = 还没择优过，按配置的中枢地址走 */
let activeBase: string | null = null;
/** 中枢通告过的内网地址（懒加载：模块求值时数据库可能还没建表） */
let announcedLanCache: string[] | null = null;
let linkCandidates: SyncLinkCandidate[] = [];
let linkChannel: SyncChannelKind = 'offline';
let linkLatencyMs: number | null = null;
let linkSince: string | null = null;
let linkProbedAt: string | null = null;
let lastProbeRoundAt = 0;
let probeInflight: Promise<void> | null = null;
let linkTimer: ReturnType<typeof setInterval> | null = null;

function loadAnnouncedLan(): string[] {
  try {
    const raw = getSetting(LINK_LAN_URLS_SETTING);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 中枢通告的内网地址（首次用到时才读设置） */
function announcedLanUrls(): string[] {
  if (announcedLanCache === null) announcedLanCache = loadAnnouncedLan();
  return announcedLanCache;
}

export function linkPreferLan(): boolean {
  return getSetting(LINK_PREFER_LAN_SETTING) !== '0';
}

export function setLinkPreferLan(value: boolean): void {
  setSetting(LINK_PREFER_LAN_SETTING, value ? '1' : '0');
}

/** 当前实际使用的基地址：择优命中就用命中的那条，否则回落到配置的中枢地址 */
export function activeHubBase(): string {
  return activeBase || hubUrl();
}

/** 忘掉上一个中枢学到的东西：改绑定/解绑后不能拿旧中枢的内网地址去连新中枢 */
export function resetLinkBinding(): void {
  activeBase = null;
  linkCandidates = [];
  linkChannel = 'offline';
  linkLatencyMs = null;
  linkSince = null;
  linkProbedAt = null;
  lastProbeRoundAt = 0;
  try {
    setSetting(LINK_LAN_URLS_SETTING, '[]');
  } catch { /* 设置写失败不影响同步本身 */ }
  announcedLanCache = [];
}

/** 记住中枢通告的内网地址：本轮与下次启动都用它先试局域网 */
function rememberAnnouncedLan(urls: string[]): void {
  announcedLanCache = urls;
  try {
    setSetting(LINK_LAN_URLS_SETTING, JSON.stringify(urls));
  } catch { /* 同上 */ }
}

/** 探测失败原因：超时/连不上给一句人话，其余截断保留（完整信息在同步详情里） */
function describeLinkError(error: unknown, timeoutMs: number): string {
  const text = error instanceof Error ? error.message : String(error || '');
  if (/abort/i.test(text) || (error instanceof Error && error.name === 'AbortError')) {
    return `探测超时（${timeoutMs} 毫秒）`;
  }
  if (/fetch failed|econnrefused|etimedout|ehostunreach|enetunreach|socket hang up|other side closed|network/i.test(text)) {
    return '连不上';
  }
  return text.slice(0, 60) || '连不上';
}

/**
 * 每个候选的探测超时。
 *
 * 局域网候选是 IP 字面量，双栈策略本来就不介入（不记账），1.5 秒硬超时随便打断都没副作用；
 * 中枢主地址走域名，探测用的就是真实请求那条双栈路径——**超时必须比真实请求更宽松**，
 * 否则「探测超时」会被记进双栈的失败次数（那是真实请求的账本），把界面上的 IPv6/IPv4
 * 判定带偏，还会出现「探测说断开、同步其实正常」。
 */
function probeTimeoutMs(kind: 'lan' | 'hub'): number {
  if (kind === 'lan') return LINK_PROBE_LAN_TIMEOUT_MS;
  return Math.max(LINK_PROBE_LAN_TIMEOUT_MS, dualStackConfig().connectTimeoutMs + 1000);
}

interface AnnounceProbe {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
  lan: string[];
}

/**
 * 一次候选探测：打中枢的连接通告端点（带令牌）。
 * 既证明这个地址可达，又顺手取回中枢的内网地址清单——一举两得，所以不另设 ping 端点。
 */
async function probeAnnounce(base: string, timeoutMs: number): Promise<AnnounceProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await dualStackFetch(`${base}/api/sync/announce`, {
      headers: authHeaders(),
      signal: ctrl.signal,
    }, dualStackConfig(), {
      onEvent: (event) => logEvent(event.level, event.event, event.detail, event.data),
    });
    if (!res.ok) return { ok: false, latencyMs: null, error: `中枢返回 ${res.status}`, lan: [] };
    const data: any = await res.json().catch(() => null);
    if (!data || data.ok !== true) return { ok: false, latencyMs: null, error: '中枢应答异常', lan: [] };
    return { ok: true, latencyMs: Date.now() - startedAt, lan: normalizeAnnouncedLan(data.lan, hubUrl()) };
  } catch (error) {
    return { ok: false, latencyMs: null, error: describeLinkError(error, timeoutMs), lan: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** 走中枢主地址（域名）时到底是 IPv6 还是 IPv4 */
async function detectHubChannel(base: string): Promise<SyncChannelKind> {
  const literal = classifyBase(base);
  if (literal) return literal;
  const host = hostnameOf(base);
  const entry = dualStackStatus().find((item) => item.host === host);
  // 双栈记账是「实际在用的协议族」的唯一可信来源（与设置页显示同一份）
  if (entry) return entry.family === 4 ? 'ipv4' : 'ipv6';
  // 双栈策略被显式关掉时没有记账：按域名解析出的协议族判断（两族齐全时系统默认 IPv6 优先）
  try {
    const records = await lookup(host, { all: true });
    if (records.some((record) => record.family === 6)) return 'ipv6';
    if (records.some((record) => record.family === 4)) return 'ipv4';
  } catch { /* 解析失败不属于通道问题：交给正常请求报错 */ }
  return 'ipv4';
}

/**
 * 跑一轮择优探测并切换基地址。
 * @param force 忽略节流（进程启动、配置变更、定期复探）
 */
export async function probeLinkChannel(force = false): Promise<void> {
  if (!syncConfigEnabled()) return;
  if (probeInflight) return probeInflight;
  const now = Date.now();
  if (!force && now - lastProbeRoundAt < LINK_PROBE_MIN_INTERVAL_MS) return;
  probeInflight = runProbeRound().finally(() => {
    probeInflight = null;
  });
  return probeInflight;
}

async function runProbeRound(): Promise<void> {
  const preferLan = linkPreferLan();
  const hubBase = hubUrl();
  if (!hubBase) return;
  const results: SyncLinkCandidate[] = [];
  let learned: string[] | null = null;

  // 最多两轮：第一轮从中枢取回内网地址清单，第二轮把它们探掉
  // （清单会随家宽前缀/网段变化，所以每次进程启动都要重新学一遍）
  for (let pass = 0; pass < 2; pass += 1) {
    for (const target of planProbes({ hubBase, announcedLan: announcedLanUrls(), preferLan })) {
      if (results.some((item) => item.url === target.url)) continue;
      const probe = await probeAnnounce(target.url, probeTimeoutMs(target.kind));
      results.push({
        kind: target.kind,
        label: target.label,
        url: target.url,
        ok: probe.ok,
        latencyMs: probe.latencyMs,
        error: probe.error,
      });
      if (target.kind === 'hub' && probe.ok && probe.lan.length) learned = probe.lan;
      // 局域网已经通了就不必再探剩下的：这一轮的目的就是找到最快那条路
      if (target.kind === 'lan' && probe.ok && preferLan) break;
    }
    if (learned) {
      const changed = learned.join('|') !== announcedLanUrls().join('|');
      rememberAnnouncedLan(learned);
      learned = null;
      // 刚学到（或清单变了）的地址要立刻探一轮，否则这一轮仍然只走了公网
      if (changed) continue;
    }
    break;
  }

  linkCandidates = results;
  linkProbedAt = new Date().toISOString();
  lastProbeRoundAt = Date.now();

  const winner = pickWinner(results, preferLan);
  if (!winner) {
    // 全部不可达：保留原基地址继续重试，状态置「已断开」（本机改动照常排队）
    linkChannel = 'offline';
    linkLatencyMs = null;
    return;
  }

  const nextBase = winner.url;
  const nextChannel: SyncChannelKind = winner.kind === 'lan' ? 'lan' : await detectHubChannel(nextBase);
  const previousBase = activeBase;
  const baseChanged = nextBase !== previousBase;
  const channelChanged = nextChannel !== linkChannel;
  activeBase = nextBase;
  linkLatencyMs = winner.latencyMs;
  linkChannel = nextChannel;

  if (baseChanged || channelChanged) {
    linkSince = new Date().toISOString();
    logEvent('info', 'link-changed',
      `连接通道：${CHANNEL_LABELS[nextChannel]}（${hostOf(nextBase)}，延迟 ${winner.latencyMs ?? '?'} 毫秒）`,
      { channel: nextChannel, base: nextBase, latencyMs: winner.latencyMs, previous: previousBase || hubUrl() });
    // 基地址换了一条链路：中断当前 SSE，让常驻循环用新地址重连。
    // 进行中的文件传输各自持有自己的连接，不受影响；只有长连接需要重建。
    if (baseChanged && streamAbort) {
      try {
        streamAbort.abort();
      } catch { /* 已结束 */ }
    }
  }
}

/** 通道现状（`/api/sync/status` 的 link 字段）；未启用同步时为 null，界面据此整块隐藏 */
export function linkStatus(): SyncLinkStatus | null {
  if (!syncConfigEnabled()) return null;
  const base = activeBase || '';
  return {
    channel: linkChannel,
    url: linkChannel === 'offline' ? '' : base,
    host: base ? hostOf(base) : '',
    latencyMs: linkLatencyMs,
    since: linkSince,
    probedAt: linkProbedAt,
    preferLan: linkPreferLan(),
    candidates: linkCandidates,
  };
}

/**
 * 「优先局域网」开关变更：记一条日志并立刻按新策略重选一次，用户不必等下一轮探测。
 * 与双栈连接一样只影响后续建连，不需要重启同步客户端。
 */
export function configureLinkPreferLan(value: boolean): void {
  const before = linkPreferLan();
  setLinkPreferLan(value);
  if (before === value) return;
  logEvent('info', 'link-config', value
    ? '已启用「优先局域网」：同一局域网内优先走内网直连，探不到时按 IPv6 → IPv4 自动降级'
    : '已关闭「优先局域网」：只按配置的中枢地址连接', { preferLan: value });
  void probeLinkChannel(true).catch(() => { /* 探测失败由下一轮重试 */ });
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

/**
 * 连接中枢的唯一出口（含 SSE 长连接、文件上传下载）：
 * 基地址取「连接通道择优」的结果（局域网优先，探不到才用配置的中枢地址）；
 * 走域名时按双栈策略选协议族——默认 IPv6 优先，IPv6 连不上改用 IPv4，IPv4 用稳后定期回探。
 * 协议族只在建连那一刻选定：一次传输全程用同一条连接，中途不会被换走。
 */
async function hubRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  return dualStackFetch(activeHubBase() + pathname, init, dualStackConfig(), {
    onEvent: (event) => {
      logEvent(event.level, event.event, event.detail, event.data);
    },
  });
}

/** 协议族现状（设置页「双栈连接」直接展示；IP 直连的中枢不产生条目） */
export function dualStackHosts(): HostFamilyStatus[] {
  return dualStackStatus();
}

async function getJson(pathname: string): Promise<any> {
  const res = await hubRequest(pathname, { headers: authHeaders() });
  if (!res.ok) throw new Error(`hub 返回 ${res.status}: ${pathname}`);
  return res.json();
}

async function postJson(pathname: string, body: unknown): Promise<any> {
  const res = await hubRequest(pathname, {
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
  const res = await hubRequest(`/api/sync/file?path=${encodeURIComponent(relPath)}`, {
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
      changes: flattenChangeLines(visible),
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
        const originNodeId = String(op.node_id || '');
        const originNodeLabel = String(op.node_label || '');
        if (!remoteHash || remoteHash !== sessionContentHash(target)) {
          void pullSessionIfChanged(target, remoteHash, originNodeId, originNodeLabel).catch(
            (error: any) => {
              pendingSessionPulls.set(target, { hash: remoteHash, nodeId: originNodeId, nodeLabel: originNodeLabel });
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
      // 必须用 undici 自己的 FormData：hubRequest 走包内 fetch（要按协议族选连接），
      // 而它只认自己的 FormData 实例——传 Node 全局 FormData 会把 "[object FormData]" 当纯文本发出去，
      // 中枢 @fastify/multipart 直接 406「the request is not multipart」。
      const form = new UndiciFormData();
      form.append('path', item.target);
      form.append('node_id', currentNodeId());
      const abs = safeJoin(item.target);
      const fileBody = isInboxPath(item.target)
        ? await fs.openAsBlob(abs, { type: 'application/octet-stream' })
        : new Blob([new Uint8Array(fs.readFileSync(abs))]);
      // Node 的 Blob 与 undici 的类型同名不同源，运行时按鸭子类型（stream/arrayBuffer/type/size）识别
      type UndiciFormValue = Parameters<UndiciFormData['append']>[1];
      form.append('file', fileBody as unknown as UndiciFormValue, path.basename(item.target));
      const res = await hubRequest('/api/sync/file', {
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
        changes: flattenChangeLines(visible),
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
      // 补拉回来的变更逐条写清文件名与类型：只写「N 条」用户看不出同步了什么；
      // 页面条目再带上改动正文，用户直接看到「中枢把这一页改成了什么」。
      // oplog 里同一个页面有多个版本，采样规则见 pickReplaySamples（只取最后一条，避免
      // 把稍后又被加回来的内容显示成删除）。
      const items: string[] = [];
      const changedOps: SyncOpSummary[] = [];
      const kinds: Record<string, number> = {};
      for (const op of ops) kinds[String(op.kind)] = (kinds[String(op.kind)] || 0) + 1;
      for (const op of pickReplaySamples(ops)) {
        const described = describeReplayOp(op);
        items.push(described.text);
        if (described.summary) changedOps.push(described.summary);
      }
      logEvent('info', 'replay', `补拉 ${ops.length} 条远端变更（自水位 ${getCursor()}）：${items.length ? items.join('；') : kindSummary(kinds as Partial<Record<SyncKind, number>>)}${ops.length > items.length ? `；等 ${ops.length - items.length} 条` : ''}`, {
        count: ops.length,
        from: getCursor(),
        kinds,
        items,
        changes: flattenChangeLines(changedOps),
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
  // 上报给中枢的「本机名称」是**中枢配置里的成员名**（见 deviceLabel.ts）：中枢把它显示在
  // 成员列表与同步日志里，用户要看到的是「书房电脑」而不是这台机器的主机名
  const deviceName = deviceLabel();
  const url = `/api/sync/events?node_id=${encodeURIComponent(currentNodeId())}`
    + `&name=${encodeURIComponent(deviceName)}`;
  const res = await hubRequest(url, { headers: authHeaders(), signal: streamAbort.signal });
  if (!res.ok || !res.body) throw new Error(`事件流连接失败: ${res.status}`);
  connected = true;
  syncing = false;
  backoffMs = 1000;
  lastError = null;
  markConnected('事件流已建立');
  logEvent('info', 'connected', `已与中枢建立实时连接${deviceName ? `（本机名称 ${deviceName}）` : ''}`, {
    hub: hubUrl(),
    device: deviceName || undefined,
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
    // 本机叫什么由中枢说了算：用户在中枢给这台设备起的成员名随清单回来（旧中枢不给这个字段，
    // 那就不动——设备名继续用主机名兜底，别的什么都不受影响）
    const named = learnDeviceLabelFromHub(snap?.device);
    if (named.changed) {
      logEvent('info', 'device-named', `本机名称已按中枢配置更新为「${named.label}」（会话列表里其他设备看到的就是这个名字）`, {
        device: named.label,
      });
    }
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
    const hubSessions: Array<{
      id: string;
      title?: string;
      hash?: string;
      originNodeId?: string;
      originNodeLabel?: string;
    }> = Array.isArray(snap?.sessions) ? snap.sessions : [];
    const hubSessionIds = new Set(hubSessions.map((item) => String(item.id)));
    const hubTombstones: Array<{ sessionId: string; deletedAt: string }> = Array.isArray(snap?.tombstones)
      ? snap.tombstones
      : [];
    const hubTombstoneIds = new Set(hubTombstones.map((item) => String(item.sessionId)));
    let sessionsPulled = 0;
    let labelsRepaired = 0;
    for (const entry of hubSessions) {
      const id = String(entry.id || '');
      if (!id || hubTombstoneIds.has(id)) continue;
      try {
        const originNodeId = String(entry.originNodeId || '');
        const originNodeLabel = String(entry.originNodeLabel || '');
        // 名字以中枢为准：本端记的是别端会话、名字却还是空着或那台设备的主机名时，就地刷成
        // 用户在中枢给设备起的名字——不必为一行名字再拉整份会话正文（旧中枢不带这两个字段，
        // 补不了就留给界面显示「其他设备」）
        if (repairSessionOriginLabel(id, originNodeLabel)) {
          labelsRepaired++;
          emit('session-changed', { id });
          continue;
        }
        if (sessionFingerprint(id) === String(entry.hash || '')) continue;
        const detail = await getJson(`/api/sync/session?id=${encodeURIComponent(id)}`);
        const snapshot = detail?.snapshot as SessionSnapshot | undefined;
        if (!snapshot) continue;
        // 清单里没有来源 id 的会话（旧版中枢上「建好但还没产生过变更」的行）：它只可能是中枢那边的
        // ——按中枢记来源，否则成员端会把它当成自己聊出来的，聊天列表里错标「本机」
        mergeSessionSnapshot(
          snapshot,
          originNodeId || 'hub',
          originNodeLabel || (originNodeId ? '' : HUB_DEVICE_LABEL),
        );
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
      `全量对账完成（${REASON_LABELS[reason]}，${formatDuration(ms)}）：中枢共 ${entries.length} 项 · 从中枢拉取 ${pulled} 项${pulledBytes ? `（${formatBytes(pulledBytes)}）` : ''}${sampleText(pulledSamples)} · 本机补推 ${queued} 项${sampleText(queuedSamples)} · 失败 ${itemFailed} 项 · 待补拉文件 ${pendingFilePulls.size} · 补齐提炼账本 ${repaired}/${ledgerRepairs.length}${sessionsPulled ? ` · 补拉会话 ${sessionsPulled} 条` : ''}${labelsRepaired ? ` · 对齐会话来源名 ${labelsRepaired} 条` : ''}`,
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
        sessionsPulled,
        sessionLabelsRepaired: labelsRepaired,
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
  for (const [sessionId, pending] of Array.from(pendingSessionPulls)) {
    try {
      await pullSessionIfChanged(sessionId, pending.hash, pending.nodeId, pending.nodeLabel);
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
      // 每轮连接前先择优一次（内部有 20 秒节流）：刚开机/刚换网络时第一轮就试对地址
      await probeLinkChannel();
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
  // 定期复探：从公司回到家、或局域网恢复后自动升回局域网直连
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = setInterval(() => {
    if (!running) return;
    void probeLinkChannel(true).catch(() => { /* 探测失败由下一轮重试 */ });
  }, LINK_REPROBE_INTERVAL_MS);
  linkTimer.unref();
}

export function stopClient(): void {
  const wasRunning = running;
  running = false;
  connected = false;
  syncing = false;
  // 下次启动重新择优：回落到配置的中枢地址，避免拿着上一段会话选中的地址直接连
  activeBase = null;
  if (wasRunning) logEvent('info', 'stopped', '同步客户端已停止', { pending: queue.length, pendingPulls: pendingFilePulls.size });
  if (pullRetryTimer) {
    clearInterval(pullRetryTimer);
    pullRetryTimer = null;
  }
  if (healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
  if (linkTimer) {
    clearInterval(linkTimer);
    linkTimer = null;
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

/** /api/sync/status 里带的日志尾巴条数（见 clientStatus 注释） */
const STATUS_LOG_TAIL = 60;

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
    link: linkStatus(),
    // 兼容旧口径：/api/sync/status 仍带一段日志尾巴（首页状态条与「立即同步」只认最新事件时间，
    // 状态日志尾巴 60 条足够）；完整分页/筛选走 /api/sync/log。首轮全量对账期间界面每 5 秒轮询一次
    // 这个接口，不再白搬 200 条。
    log: recentSyncLog(STATUS_LOG_TAIL),
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
