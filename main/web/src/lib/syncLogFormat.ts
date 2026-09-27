/**
 * 同步日志的展示层工具（纯函数，无 DOM / 无请求依赖，可直接单测）。
 *
 * 事件名 → 中文标签、结构化字段 → 中文名、时间/字节/耗时格式化、导出文本构建都在这里；
 * 状态与请求逻辑在 lib/syncLog.ts（抽屉用），两者拆开是为了让标签与导出格式能被测试钉住。
 */

export type SyncLogLevel = 'info' | 'warn' | 'error';
export type SyncLogScope = 'hub' | 'member' | 'app';

export interface SyncLogEntry {
  id: number;
  ts: string;
  level: SyncLogLevel;
  event: string;
  scope?: SyncLogScope;
  peer?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface SyncLogSummary {
  total: number;
  byLevel: Record<SyncLogLevel, number>;
  byScope: Record<SyncLogScope, number>;
  byEvent: { event: string; count: number }[];
  oldest: string | null;
  newest: string | null;
  retentionDays: number;
  maxEntries: number;
  filePath: string;
  fileSize: number;
}

export interface SyncLogPeer {
  id: string;
  name: string;
  node_label?: string;
  online?: boolean;
  last_seen_at?: string | null;
  last_seq?: number;
  created_at?: string;
}

export interface SyncLogStatus {
  role: 'hub' | 'member' | 'none';
  enabled: boolean;
  connected: boolean;
  syncing: boolean;
  reconciling: boolean;
  hubUrl: string;
  nodeId: string;
  /** 成员端：已应用到的中枢 oplog 水位；中枢端恒为 0 */
  cursor: number;
  /** 中枢端：本机权威 revision 序号；成员端为 0 */
  revision?: number;
  pending: number;
  pendingPulls: number;
  /** 成员端同步进行中的一句话进度（「正在下载内容（队列 4 项）」）；中枢端可能不给 */
  syncProgress?: string;
  /** 成员端本机内容版本号：每落地一项同步改动 +1，前端据此在对账进行中渐进刷新文件树 */
  contentRevision?: number;
  lastSyncAt: string | null;
  lastError: string | null;
  peers: SyncLogPeer[];
}

export interface SyncLogPage {
  entries: SyncLogEntry[];
  total: number;
  hasMore: boolean;
  newestId: number;
  oldestId: number;
  summary: SyncLogSummary;
  status: SyncLogStatus;
}

/** 事件归类：筛选栏的「事件」下拉按它分组，用户先按「我想看哪类事」缩小范围 */
export type SyncEventCategory = '连接' | '推送' | '拉取' | '对账' | '冲突' | '成员' | '配置' | '其他';

interface SyncEventMeta {
  label: string;
  category: SyncEventCategory;
}

/**
 * 事件名 → 中文标签。事件名是服务端（sync/eventLog.ts）写入的稳定英文 id，
 * 日志文件里也是它；这里只做展示映射，未知事件直接显示原名，不隐藏。
 */
export const SYNC_EVENT_META: Record<string, SyncEventMeta> = {
  // 连接
  start: { label: '同步客户端启动', category: '连接' },
  stopped: { label: '同步客户端停止', category: '连接' },
  connected: { label: '已连接中枢', category: '连接' },
  reconnected: { label: '断线后已恢复', category: '连接' },
  disconnected: { label: '连接断开，自动重连', category: '连接' },
  'sync-done': { label: '一轮同步完成', category: '连接' },
  'sync-paused': { label: '同步已暂停', category: '连接' },
  'sync-failed': { label: '同步失败', category: '连接' },
  // 推送
  'push-ok': { label: '推送完成', category: '推送' },
  'push-page': { label: '推送页面', category: '推送' },
  'push-file': { label: '推送文件', category: '推送' },
  'push-delete': { label: '推送删除', category: '推送' },
  'push-move': { label: '推送改名', category: '推送' },
  'push-retry': { label: '推送失败，退避重试', category: '推送' },
  'push-received': { label: '收到成员推送', category: '推送' },
  'push-rejected': { label: '推送被拒绝', category: '推送' },
  'push-merged': { label: '自动合并', category: '推送' },
  'apply-failed': { label: '应用远端变更失败', category: '推送' },
  'move-superseded': { label: '改名收敛', category: '推送' },
  'local-broadcast': { label: '本机改动已广播', category: '推送' },
  // 文件与补拉
  'file-pull-ok': { label: '拉取文件', category: '拉取' },
  'file-pull-deferred': { label: '文件待补拉', category: '拉取' },
  'file-pull-retry-ok': { label: '文件补拉成功', category: '拉取' },
  'file-pull-retry-failed': { label: '文件补拉失败', category: '拉取' },
  'file-received': { label: '收到成员文件', category: '拉取' },
  'file-rejected': { label: '文件落盘失败', category: '拉取' },
  replay: { label: '补拉远端变更', category: '拉取' },
  'pull-applied': { label: '应用中枢变更', category: '拉取' },
  // 成员端逐条记录：每条就是一个「哪个文件 + 什么增量」（手机端首次全量对账也走这几条）
  'pull-page': { label: '拉取页面', category: '拉取' },
  'pull-file': { label: '拉取文件', category: '拉取' },
  'pull-delete': { label: '应用远端删除', category: '拉取' },
  'pull-move': { label: '应用远端改名', category: '拉取' },
  'pull-local-newer': { label: '本机版本较新，未覆盖', category: '拉取' },
  'oplog-trimmed': { label: '落后过多，转全量对账', category: '拉取' },
  // 对账
  'reconcile-start': { label: '全量对账开始', category: '对账' },
  'reconcile-done': { label: '全量对账完成', category: '对账' },
  'changes-too-large': { label: '批次过大，已转全量对账', category: '对账' },
  'reconcile-item-failed': { label: '对账单项失败', category: '对账' },
  'reconcile-failed': { label: '全量对账失败', category: '对账' },
  'ledger-repair-failed': { label: '提炼账本补齐失败', category: '对账' },
  heal: { label: '周期自愈对账', category: '对账' },
  'snapshot-served': { label: '成员拉取全量清单', category: '对账' },
  // 冲突
  'push-conflict': { label: '冲突裁决', category: '冲突' },
  // 成员与配置
  'peer-online': { label: '成员上线', category: '成员' },
  'peer-offline': { label: '成员离线', category: '成员' },
  'peer-added': { label: '添加成员', category: '成员' },
  'peer-removed': { label: '移除成员', category: '成员' },
  'peer-token-reset': { label: '重置成员令牌', category: '成员' },
  'role-changed': { label: '角色变更', category: '配置' },
  'config-changed': { label: '同步配置变更', category: '配置' },
};

export function eventLabel(event: string): string {
  return SYNC_EVENT_META[event]?.label || event;
}

export function eventCategory(event: string): SyncEventCategory {
  return SYNC_EVENT_META[event]?.category || '其他';
}

export const SCOPE_LABELS: Record<SyncLogScope, string> = {
  hub: '中枢',
  member: '成员',
  app: '配置',
};

/** 结构化字段的中文名：抽屉展开详情时按「字段 / 值」两列渲染 */
const DATA_LABELS: Record<string, string> = {
  count: '条数',
  kinds: '类型分布',
  bytes: '字节数',
  pulledBytes: '拉取字节',
  ms: '耗时',
  path: '路径',
  paths: '路径列表',
  from: '原路径',
  to: '新路径',
  peerId: '成员 ID',
  device: '设备名',
  node: '节点 ID',
  nodeId: '节点 ID',
  hub: '中枢地址',
  previousHub: '原中枢地址',
  seq: '序号',
  revision: '版本号',
  merge: '写入方式',
  theirWins: '推送方胜出',
  copyPath: '副本路径',
  error: '错误',
  retryInMs: '重试间隔',
  queued: '队列长度',
  pending: '待补拉',
  pendingPulls: '待补拉文件',
  reason: '触发原因',
  label: '原因说明',
  role: '角色',
  enabled: '是否启用',
  tokenUpdated: '令牌已更新',
  entries: '中枢条目数',
  cursor: '水位',
  hubEntries: '中枢条目数',
  localEntries: '本端条目数',
  pulled: '拉取条数',
  failed: '失败条数',
  ledgerRepaired: '补齐账本数',
  ledgerTotal: '待补账本数',
  sessionMs: '在线时长',
  total: '总数',
  remaining: '剩余成员',
  kind: '类型',
  // 条目级字段（哪个文件、什么增量）
  items: '涉及的条目',
  verb: '动作',
  title: '页面标题',
  oldPath: '改名原路径',
  added: '新增行',
  removed: '删除行',
  beforeBytes: '原大小',
  afterBytes: '新大小',
  attempts: '重试次数',
  source: '恢复方式',
  downMs: '断开时长',
  online: '在线成员',
  pulledSamples: '拉取示例',
  queuedSamples: '补推示例',
  // 导出文件头部的筛选说明（与抽屉筛选栏同名）
  level: '级别',
  scope: '视角',
  event: '事件',
  q: '关键词',
};

export function dataLabel(key: string): string {
  return DATA_LABELS[key] || key;
}

/** 动作/类型的取值也翻成中文：抽屉展开详情时不至于冒出一个光秃秃的 add / page */
const VERB_LABELS: Record<string, string> = {
  add: '新增',
  update: '修改',
  delete: '删除',
  move: '改名',
  same: '内容无变化',
  push: '推送本机改动',
};

const KIND_LABELS: Record<string, string> = {
  page: '页面',
  file: '文件',
  delete: '删除条目',
  move: '改名条目',
  session: '会话',
  board: '任务看板',
};

export function formatDataValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'verb') return VERB_LABELS[String(value)] || String(value);
  if (key === 'kind') return KIND_LABELS[String(value)] || String(value);
  // 数组：字符串数组（条目清单 / 路径清单）逐行展示，用户一眼看完改了哪些文件
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === 'object') ? JSON.stringify(value) : value.map(String).join('\n');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (key === 'bytes' || key === 'pulledBytes' || key === 'beforeBytes' || key === 'afterBytes') {
    return `${formatBytes(Number(value))}（${value} B）`;
  }
  if (key === 'ms' || key === 'sessionMs' || key === 'downMs') return `${formatDuration(Number(value))}（${value} ms）`;
  if (key === 'retryInMs') return `${Math.round(Number(value) / 1000)} 秒`;
  return String(value);
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** 完整时间（含毫秒）：日志条目要能和服务端日志、其他设备的记录对上，秒级精度不够 */
export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 列表里的时间列：同一天的记录只需 时:分:秒.毫秒 */
export function formatLogClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 「多久以前」：抽屉顶部「最近同步」与条目时间用得上 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = now - time;
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

export function buildSyncLogJson(entries: SyncLogEntry[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: entries.length,
      ...extra,
      entries,
    },
    null,
    2,
  );
}

export function buildSyncLogMarkdown(entries: SyncLogEntry[], extra: Record<string, unknown> = {}): string {
  const lines: string[] = [];
  lines.push('# Engram 同步日志导出');
  lines.push('');
  lines.push(`- 导出时间：${formatLogTime(new Date().toISOString())}`);
  lines.push(`- 条目数：${entries.length}`);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`- ${dataLabel(key)}：${String(value)}`);
  }
  lines.push('');
  lines.push('| 时间 | 级别 | 视角 | 事件 | 成员 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of entries) {
    const scope = entry.scope ? SCOPE_LABELS[entry.scope] : '';
    const detail = (entry.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${formatLogTime(entry.ts)} | ${entry.level} | ${scope} | ${eventLabel(entry.event)} | ${entry.peer || ''} | ${detail} |`);
  }
  lines.push('');
  lines.push('## 结构化字段');
  lines.push('');
  for (const entry of entries) {
    if (!entry.data || !Object.keys(entry.data).length) continue;
    lines.push(`### ${formatLogTime(entry.ts)} · ${eventLabel(entry.event)}`);
    lines.push('');
    for (const [key, value] of Object.entries(entry.data)) {
      lines.push(`- ${dataLabel(key)}：${formatDataValue(key, value)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
