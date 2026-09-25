import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * 多端同步事件日志（跨重启留存、可按维度筛选）。
 *
 * 旧实现只有一个 200 条的内存环形缓冲，写在 client.ts 里：
 *  - 只有成员端记日志：中枢角色跑的是 hub.ts，一条都不记，中枢上打开「多端同步」
 *    只能看到空列表，用户自然觉得「这记录很垃圾」；
 *  - 进程一重启全丢，「昨晚那台电脑为什么没同步上」事后无从查证；
 *  - 条目只有一行拼好的人话 detail，没有结构化字段，前端只能平铺一列，
 *    既不能按级别/事件/成员筛，也不能导出给别人看。
 *
 * 现在统一落盘到 <DATA_DIR>/logs/sync.jsonl：
 *  - 内存保留最近 maxEntries 条供查询，文件按「条数 + 天数」双上限收敛
 *    （启动加载与超限时重写压缩，不会无限膨胀）；
 *  - 每条记录带 level / event / scope（中枢·成员·本机配置）/ peer / data 结构化字段，
 *    前端能筛选、展开、统计、导出；
 *  - 写入用同步 appendFileSync：同步事件本身是低频的（一个推送批次、一轮对账各一条），
 *    换来的是进程被强杀时最后一条也已经在盘上。
 */

export type SyncLogLevel = 'info' | 'warn' | 'error';
/** 事件视角：hub=本机作为中枢时记录，member=本机作为成员时记录，app=角色/绑定等本机配置动作 */
export type SyncLogScope = 'hub' | 'member' | 'app';

export interface SyncLogFields {
  /** 一行中文描述（列表直接展示） */
  detail?: string;
  /** 相关成员/设备名（中枢侧事件） */
  peer?: string;
  /** 结构化字段：count / bytes / ms / kind / path / seq / cursor…（展开详情与导出用） */
  data?: Record<string, unknown>;
  scope?: SyncLogScope;
}

export interface SyncLogEntry extends SyncLogFields {
  id: number;
  ts: string;
  level: SyncLogLevel;
  event: string;
}

export interface SyncLogQuery {
  /** 本次返回条数上限（默认 200，上限 maxEntries） */
  limit?: number;
  /** 只取 id < before 的（向前翻页） */
  before?: number;
  /** 只取 id > after 的（只看增量） */
  after?: number;
  /** 时间下限（ms epoch） */
  since?: number;
  level?: SyncLogLevel | 'all';
  scope?: SyncLogScope | 'all';
  event?: string;
  /** 关键词：在 detail / peer / 结构化字段里模糊匹配 */
  q?: string;
}

export interface SyncLogQueryResult {
  /** 新 → 旧 */
  entries: SyncLogEntry[];
  /** 命中过滤条件的总条数（不受 limit 影响） */
  total: number;
  hasMore: boolean;
  newestId: number;
  oldestId: number;
}

export interface SyncLogSummary {
  total: number;
  byLevel: Record<SyncLogLevel, number>;
  byScope: Record<SyncLogScope, number>;
  /** 出现最多的事件类型（最多 8 个） */
  byEvent: { event: string; count: number }[];
  oldest: string | null;
  newest: string | null;
  retentionDays: number;
  maxEntries: number;
  filePath: string;
  fileSize: number;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/** 字节数转人话（只用于描述文案；结构化字段里保留原始字节数，便于统计与导出） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 毫秒转人话（「1.2 秒」「3 分 20 秒」），对账耗时用 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

/** 条数上限 / 保留天数可由环境变量收紧（测试与私有部署用） */
const MAX_ENTRIES = envInt('SYNC_LOG_MAX_ENTRIES', 2000);
const RETENTION_DAYS = envInt('SYNC_LOG_RETENTION_DAYS', 7);
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 最多比内存多攒多少条淘汰记录就整体重写压缩文件（按上限的 10%、至少 20 条） */
const COMPACT_SLACK = Math.max(20, Math.ceil(MAX_ENTRIES / 10));
const DETAIL_MAX = 500;
const DATA_JSON_MAX = 4000;

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sync.jsonl');

let entries: SyncLogEntry[] = [];
let nextId = 1;
let loaded = false;
/** 文件里当前的行数（含已从内存淘汰、尚未压缩掉的行） */
let fileLines = 0;
/** 自上次压缩以来淘汰的条数：攒够 COMPACT_SLACK 才重写文件，避免高频写入时反复重写 */
let droppedSinceCompact = 0;

function truncate(text: unknown, max: number): string | undefined {
  if (text === undefined || text === null) return undefined;
  const value = String(text);
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** data 是给人看的诊断字段：对象过大时丢弃，避免一条日志把文件撑爆 */
function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') clean[key] = truncate(value, DETAIL_MAX);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
    else if (Array.isArray(value)) clean[key] = value.slice(0, 20).map((item) => (typeof item === 'object' ? JSON.stringify(item).slice(0, 200) : String(item).slice(0, 200)));
    else clean[key] = truncate(JSON.stringify(value), 400);
  }
  if (!Object.keys(clean).length) return undefined;
  try {
    return JSON.stringify(clean).length > DATA_JSON_MAX ? { 摘要: '字段过大已省略' } : clean;
  } catch {
    return undefined;
  }
}

function normalize(raw: Partial<SyncLogEntry>): SyncLogEntry {
  const level: SyncLogLevel = raw.level === 'warn' || raw.level === 'error' ? raw.level : 'info';
  return {
    id: Number(raw.id) || 0,
    ts: String(raw.ts || new Date().toISOString()),
    level,
    event: String(raw.event || 'unknown'),
    scope: raw.scope === 'hub' || raw.scope === 'member' || raw.scope === 'app' ? raw.scope : undefined,
    peer: raw.peer ? String(raw.peer) : undefined,
    detail: truncate(raw.detail, DETAIL_MAX),
    data: raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : undefined,
  };
}

/** 淘汰超期与超上限的条目；返回淘汰条数与是否「按时间过期」（过期要立刻压缩文件） */
function prune(): { dropped: number; expired: boolean } {
  const deadline = Date.now() - RETENTION_MS;
  let expired = 0;
  while (entries.length && Date.parse(entries[0].ts) < deadline) {
    entries.shift();
    expired += 1;
  }
  let overflow = 0;
  if (entries.length > MAX_ENTRIES) {
    overflow = entries.length - MAX_ENTRIES;
    entries.splice(0, overflow);
  }
  return { dropped: expired + overflow, expired: expired > 0 };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  } catch {
    return; // 首次运行没有文件
  }
  const parsed: SyncLogEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(normalize(JSON.parse(trimmed) as Partial<SyncLogEntry>));
    } catch {
      // 半行 JSON（写入途中进程被杀）跳过，不影响其余记录
    }
  }
  fileLines = parsed.length;
  let seq = 0;
  for (const item of parsed) {
    if (!item.id) item.id = ++seq;
    else seq = Math.max(seq, item.id);
  }
  entries = parsed;
  nextId = seq + 1;
  const { dropped, expired } = prune();
  if (expired || dropped > 0) compact();
}

/** 用内存中的条目整体重写文件（原子替换），同时把 fileLines 拉回真实值 */
function compact(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const temp = `${LOG_FILE}.${process.pid}.tmp`;
    const body = entries.map((item) => JSON.stringify(item)).join('\n');
    fs.writeFileSync(temp, body ? `${body}\n` : '');
    fs.renameSync(temp, LOG_FILE);
    fileLines = entries.length;
  } catch {
    // 日志文件不可写不影响同步本身；内存里的记录仍然可查
  }
}

function appendLine(entry: SyncLogEntry): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
    fileLines += 1;
  } catch {
    fileLines = entries.length;
  }
}

/** 记一条同步事件（唯一写入口） */
export function logSyncEvent(level: SyncLogLevel, event: string, fields: SyncLogFields = {}): SyncLogEntry {
  ensureLoaded();
  const entry: SyncLogEntry = {
    id: nextId++,
    ts: new Date().toISOString(),
    level,
    event,
    scope: fields.scope,
    peer: fields.peer ? String(fields.peer) : undefined,
    detail: truncate(fields.detail, DETAIL_MAX),
    data: sanitizeData(fields.data),
  };
  entries.push(entry);
  // 先落盘再判断压缩：压缩重写用的是内存里的最终列表，不会把这条写丢或写重
  appendLine(entry);
  const { dropped, expired } = prune();
  droppedSinceCompact += dropped;
  if (expired || droppedSinceCompact >= COMPACT_SLACK) {
    compact();
    droppedSinceCompact = 0;
  }
  return entry;
}

function matchFilters(item: SyncLogEntry, query: SyncLogQuery, needle: string): boolean {
  if (query.level && query.level !== 'all' && item.level !== query.level) return false;
  if (query.scope && query.scope !== 'all' && item.scope !== query.scope) return false;
  if (query.event && item.event !== query.event) return false;
  if (query.since && Date.parse(item.ts) < query.since) return false;
  if (needle) {
    const haystack = `${item.detail || ''} ${item.peer || ''} ${item.event} ${item.data ? JSON.stringify(item.data) : ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** 按条件查询（新 → 旧）；before/after 与其余过滤条件是 AND 关系 */
export function querySyncLog(query: SyncLogQuery = {}): SyncLogQueryResult {
  ensureLoaded();
  const limit = Math.min(Math.max(1, Math.trunc(Number(query.limit) || 200)), MAX_ENTRIES);
  const needle = String(query.q || '').trim().toLowerCase();
  const matched: SyncLogEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i];
    if (query.before && item.id >= query.before) continue;
    if (query.after && item.id <= query.after) continue;
    if (!matchFilters(item, query, needle)) continue;
    matched.push(item);
  }
  return {
    entries: matched.slice(0, limit),
    total: matched.length,
    hasMore: matched.length > limit,
    newestId: entries.length ? entries[entries.length - 1].id : 0,
    oldestId: entries.length ? entries[0].id : 0,
  };
}

/** 最近 n 条（旧 → 新，环形缓冲口径；/api/sync/status 的 log 字段与旧版兼容） */
export function recentSyncLog(limit = 200): SyncLogEntry[] {
  ensureLoaded();
  return entries.slice(Math.max(0, entries.length - limit));
}

export function syncLogSummary(): SyncLogSummary {
  ensureLoaded();
  const byLevel: Record<SyncLogLevel, number> = { info: 0, warn: 0, error: 0 };
  const byScope: Record<SyncLogScope, number> = { hub: 0, member: 0, app: 0 };
  const eventCounts = new Map<string, number>();
  for (const item of entries) {
    byLevel[item.level] += 1;
    if (item.scope) byScope[item.scope] += 1;
    eventCounts.set(item.event, (eventCounts.get(item.event) || 0) + 1);
  }
  const byEvent = [...eventCounts.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  let fileSize = 0;
  try {
    fileSize = fs.statSync(LOG_FILE).size;
  } catch {
    fileSize = 0;
  }
  return {
    total: entries.length,
    byLevel,
    byScope,
    byEvent,
    oldest: entries.length ? entries[0].ts : null,
    newest: entries.length ? entries[entries.length - 1].ts : null,
    retentionDays: RETENTION_DAYS,
    maxEntries: MAX_ENTRIES,
    filePath: LOG_FILE,
    fileSize,
  };
}

/** 清空全部同步日志（内存 + 文件）；设置页/抽屉里的「清空日志」用 */
export function clearSyncLog(): number {
  ensureLoaded();
  const count = entries.length;
  entries = [];
  nextId = 1;
  droppedSinceCompact = 0;
  compact();
  fileLines = 0;
  return count;
}
