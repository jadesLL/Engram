/**
 * 同步日志的展示层工具（纯函数，无 DOM / 无请求依赖，可直接单测）。
 *
 * 事件名 → 中文标签、结构化字段 → 中文名、时间/字节/耗时格式化、导出文本构建都在这里；
 * 状态与请求逻辑在 lib/syncLog.ts（抽屉用），两者拆开是为了让标签与导出格式能被测试钉住。
 */

export type SyncLogLevel = 'info' | 'warn' | 'error';
export type SyncLogScope = 'hub' | 'member' | 'app';

/**
 * 结果维度（服务端 sync/logClassify.ts 现算，随条目下发）：
 * 有改动 = 同步成功且内容真的变了；没改动 = 对账/检查/连接跑完两边一致；失败 = 警告与错误。
 */
export type SyncLogOutcome = 'changed' | 'none' | 'failed';
/** 内容维度：按改动的文件归属分（原始资料 / 概念 / 实体 / 内置 Agent / 其他） */
export type SyncLogContent = '原始资料' | '概念' | '实体' | '内置 Agent' | '其他';

export const SYNC_LOG_OUTCOMES: SyncLogOutcome[] = ['changed', 'none', 'failed'];
export const SYNC_LOG_CONTENTS: SyncLogContent[] = ['原始资料', '概念', '实体', '内置 Agent', '其他'];

export const OUTCOME_LABELS: Record<SyncLogOutcome, string> = {
  changed: '有改动',
  none: '没改动',
  failed: '失败',
};

export const OUTCOME_HINTS: Record<SyncLogOutcome, string> = {
  changed: '同步成功，而且内容真的变了',
  none: '对账 / 检查 / 连接这类，跑完了两边一致，什么都没动',
  failed: '警告与错误，需要处理',
};

export interface SyncLogEntry {
  id: number;
  ts: string;
  level: SyncLogLevel;
  event: string;
  scope?: SyncLogScope;
  peer?: string;
  detail?: string;
  data?: Record<string, unknown>;
  /** 结果分类（服务端算好下发；老服务端可能不给，界面按 info/warn/error 兜底） */
  outcome?: SyncLogOutcome;
  /** 内容分类（同上，一条记录可能同时属于多类） */
  contents?: SyncLogContent[];
}

/** 条目的结果分类：优先用服务端给的，缺了按级别兜底（失败=警告与错误） */
export function entryOutcome(entry: SyncLogEntry): SyncLogOutcome {
  if (entry.outcome) return entry.outcome;
  return classifyLogEntry(entry).outcome;
}

export function entryOutcomeLabel(entry: SyncLogEntry): string {
  return OUTCOME_LABELS[entryOutcome(entry)];
}

/** 条目的内容分类：服务端不给时（手机端本地日志）在前端按同一套目录口径现算 */
export function entryContents(entry: SyncLogEntry): SyncLogContent[] {
  if (Array.isArray(entry.contents)) return entry.contents;
  return classifyLogEntry(entry).contents;
}

/**
 * 与 server/sync/logClassify.ts 同口径的前端实现。
 *
 * 桌面 / Docker 端的日志接口直接把 outcome / contents 随条目下发，这里不会走到；
 * 手机端（Android 本地 /api/sync/log 由 Kotlin 实现）暂时还没有这两个字段，
 * 前端按同一套规则现算，保证两端看到的分类一致——安卓端补上后可只留服务端口径。
 */
const CHANGED_EVENTS = new Set([
  'local-broadcast', 'push-ok', 'push-received', 'push-page', 'push-file', 'push-delete', 'push-move',
  'push-merged', 'move-superseded', 'pull-applied', 'pull-page', 'pull-file', 'pull-delete', 'pull-move',
  'file-pull-ok', 'file-received', 'file-pull-retry-ok', 'session-pull-retry-ok', 'replay', 'reconcile-done',
  // 手机端只补「已提炼」标记的那一步（条目只在标记真的变了时才写）
  'ledger-marks',
]);

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function classifyLogEntry(entry: SyncLogEntry): { outcome: SyncLogOutcome; contents: SyncLogContent[] } {
  const data = entry.data || {};
  const contents: SyncLogContent[] = [];
  const push = (type: SyncLogContent) => { if (!contents.includes(type)) contents.push(type); };
  const paths = [
    ...(Array.isArray(data.paths) ? data.paths.filter((item): item is string => typeof item === 'string') : []),
    ...(typeof data.path === 'string' ? [data.path] : []),
  ];
  let unclassified = false;
  for (const path of paths) {
    if (!(path.startsWith('原始资料/') || path.startsWith('Wiki/') || path.startsWith('AIWorks/'))) { unclassified = true; continue; }
    push(contentTypeOfPath(path));
  }
  const kinds = [
    ...(typeof data.kind === 'string' ? [data.kind] : []),
    ...(data.kinds && typeof data.kinds === 'object' ? Object.keys(data.kinds as Record<string, unknown>) : []),
  ];
  if (kinds.some((kind) => kind === 'session' || kind === 'board')) push('内置 Agent');
  if (!contents.length && (unclassified || CHANGED_EVENTS.has(entry.event))) push('其他');
  contents.sort((a, b) => SYNC_LOG_CONTENTS.indexOf(a) - SYNC_LOG_CONTENTS.indexOf(b));

  if (entry.level === 'warn' || entry.level === 'error') return { outcome: 'failed', contents };
  if (!CHANGED_EVENTS.has(entry.event)) return { outcome: 'none', contents };
  if (entry.event === 'pull-applied') {
    return { outcome: arrayLength(data.items) + arrayLength(data.paths) + arrayLength(data.changes) > 0 ? 'changed' : 'none', contents };
  }
  if (entry.event === 'reconcile-done') {
    return { outcome: Number(data.pulled) > 0 || Number(data.ledgerRepaired) > 0 ? 'changed' : 'none', contents };
  }
  if (entry.event === 'replay') {
    return { outcome: Number(data.count) > 0 && arrayLength(data.items) + arrayLength(data.changes) > 0 ? 'changed' : 'none', contents };
  }
  return { outcome: 'changed', contents };
}

/** 路径 → 内容类型（与 server/sync/logClassify.ts 同一套目录口径） */
export function contentTypeOfPath(relPath: string): SyncLogContent {
  const path = String(relPath || '').replace(/^\.\//, '');
  if (path.startsWith('原始资料/')) return '原始资料';
  if (path.startsWith('Wiki/概念/')) return '概念';
  if (path.startsWith('Wiki/实体/')) return '实体';
  if (path.startsWith('AIWorks/')) return '内置 Agent';
  return '其他';
}

export interface SyncLogSummary {
  total: number;
  byLevel: Record<SyncLogLevel, number>;
  byScope: Record<SyncLogScope, number>;
  /** 结果维度统计（筛选栏数字） */
  byOutcome?: Record<SyncLogOutcome, number>;
  /** 内容维度统计（一条记录可能同时计入多类） */
  byContent?: Partial<Record<SyncLogContent, number>>;
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
  // 本机已改名/改分类/删除但还没推给中枢：中枢清单里的旧路径不拉回来（否则手机上新旧两份并存）
  'pull-pending-local': { label: '本机待推送，旧路径未拉回', category: '拉取' },
  // 中枢已经没有这份（清单/oplog 滞后于改名或删除）：跳过这一项并推进水位，不让整轮同步卡死
  'pull-missing': { label: '中枢已无此内容，已跳过', category: '拉取' },
  'oplog-trimmed': { label: '落后过多，转全量对账', category: '拉取' },
  // 对账
  'reconcile-start': { label: '全量对账开始', category: '对账' },
  'reconcile-done': { label: '全量对账完成', category: '对账' },
  'changes-too-large': { label: '批次过大，已转全量对账', category: '对账' },
  'reconcile-item-failed': { label: '对账单项失败', category: '对账' },
  'reconcile-failed': { label: '全量对账失败', category: '对账' },
  'ledger-repair-failed': { label: '提炼账本补齐失败', category: '对账' },
  // 手机端补「已提炼」标记（标记没有同步 op，只能靠这一趟对齐；见 Android SyncEngine.refreshLedgerMarks）
  'ledger-marks': { label: '对齐已提炼标记', category: '对账' },
  'ledger-marks-failed': { label: '已提炼标记对齐失败', category: '对账' },
  'ledger-marks-unsupported': { label: '中枢暂无已提炼标记接口', category: '对账' },
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
  // 本机名称：对账时从「中枢配置的成员名」学回来（不再用电脑主机名当设备名）
  'device-named': { label: '本机名称（按中枢配置）', category: '配置' },
  // 双栈连接（IPv6 优先 → 失败切 IPv4 → IPv4 期间定期回探）
  'dualstack-ipv4-fallback': { label: 'IPv6 连不上，改用 IPv4', category: '连接' },
  'dualstack-probe-failed': { label: '回探 IPv6 未成功', category: '连接' },
  'dualstack-ipv6-recovered': { label: 'IPv6 已恢复，切回优先', category: '连接' },
  'dualstack-config': { label: '双栈连接设置变更', category: '配置' },
  // 连接通道择优（局域网 → IPv6 → IPv4 → 已断开）：桌面 / Docker 与安卓端共用同一套事件名
  'link-changed': { label: '连接通道切换', category: '连接' },
  'link-config': { label: '「优先局域网」变更', category: '配置' },
  'link-probe-failed': { label: '连接通道探测失败', category: '连接' },
  'link-announce-unavailable': { label: '中枢未提供连接通告', category: '连接' },
  // 手机端事件名：本机名称从快照学回（与 server 的 device-named 同义，名字不同）
  'device-label': { label: '本机名称（按中枢配置）', category: '配置' },
  // 中枢下发了本端不认识的同步类型（协议比本端新）：跳过并留痕，升级后自动补齐
  'sync-unknown-kind': { label: '不认识的同步类型，已跳过', category: '拉取' },
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
  host: '域名',
  family: '使用的协议族',
  failures: '连续失败次数',
  wastedMs: 'IPv6 卡住耗时',
  probeAfterSuccesses: '回探间隔（次）',
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
  // 改动正文：条目的「改了什么」（+ 新增行 / − 删除行），抽屉直接列在条目下方
  changes: '改动内容',
  changesOmitted: '未记录的改动行',
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

/**
 * 改动正文的一行：
 *  add/del = 新增 / 删除（带行号）；
 *  ctx     = 未改动的上下文行（灰底，让用户看出改在哪儿）；
 *  hunk    = 改动块头（`@@ -18,11 +18,12 @@`）；
 *  file    = 文件路径行；note = 「还有 N 行改动未记录」这类提示。
 */
export type SyncChangeKind = 'add' | 'del' | 'ctx' | 'hunk' | 'file' | 'note';

export interface SyncChangeLine {
  kind: SyncChangeKind;
  /** 行首符号（新增 + / 删除 − / 上下文一个空格）；其余为空 */
  sign: string;
  text: string;
  /** 行号（改动行与上下文行有；老的日志格式没有） */
  lineNo?: number;
}

/** 新格式：`@@ -18,11 +18,12 @@`（原文件/新文件的起始行与行数） */
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** 新格式：` 21 上下文` / `+23 新增` / `-23 删除`（符号/空格 + 行号 + 空格 + 原文） */
const NUMBERED_LINE = /^([ +-])(\d+) (.*)$/;

/**
 * data.changes → 可渲染的行。
 *
 * 认两种写法：
 *  ① 新版（桌面 / Docker / 安卓新包）：`@@ 块头` + ` 上下文` + `+新增` / `-删除`，都带行号，界面画行级 diff；
 *  ② 老版：只有 `+ 行` / `- 行` 与文件路径行——直接照原样渲染，不做转换。
 * 老记录没有这个字段时返回空数组，界面照旧只显示那一行摘要。
 */
export function parseChangeLines(value: unknown): SyncChangeLine[] {
  const raw = Array.isArray(value) ? value.map((item) => String(item ?? '')) : typeof value === 'string' ? value.split('\n') : [];
  const lines: SyncChangeLine[] = [];
  for (const line of raw) {
    if (!line) continue;
    if (HUNK_HEAD.test(line)) {
      lines.push({ kind: 'hunk', sign: '', text: line });
      continue;
    }
    const numbered = NUMBERED_LINE.exec(line);
    if (numbered) {
      const [, marker, lineNo, text] = numbered;
      const kind: SyncChangeKind = marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx';
      lines.push({ kind, sign: marker === '+' ? '+' : marker === '-' ? '−' : ' ', text, lineNo: Number(lineNo) });
      continue;
    }
    if (line.startsWith('+ ')) lines.push({ kind: 'add', sign: '+', text: line.slice(2) });
    else if (line.startsWith('- ')) lines.push({ kind: 'del', sign: '−', text: line.slice(2) });
    else if (line.startsWith('…')) lines.push({ kind: 'note', sign: '', text: line });
    else lines.push({ kind: 'file', sign: '', text: line });
  }
  return lines;
}

/** 改动块头 `@@ -18,11 +18,12 @@` → 中文标题「第 18～28 行」（给界面上的块头用） */
export function hunkTitle(line: SyncChangeLine): string {
  const match = HUNK_HEAD.exec(line.text);
  if (!match) return line.text;
  const newStart = Number(match[3]);
  const newCount = Number(match[4] || 1);
  if (newCount > 1) return `第 ${newStart}～${newStart + newCount - 1} 行`;
  // 整块都是删除时新文件侧没有行数（`+18,0`）：写成「第 N 行起」，不显示「第 N～N−1 行」
  if (newCount === 0) return `第 ${newStart} 行起`;
  return `第 ${newStart} 行`;
}

/** 改动清单里的一个文件小节：文件路径 + 它的改动块（界面上按内容类型分组渲染） */
export interface SyncChangeFile {
  path: string;
  lines: SyncChangeLine[];
}

/**
 * 按文件切开改动正文：新格式每批开头都会写文件路径行；老记录只在多于一个文件时才写。
 * 没有路径行时（单文件老记录）整段归到一个「未标注文件」小节，由调用方用条目摘要补标题。
 */
export function groupChangeFiles(lines: SyncChangeLine[]): SyncChangeFile[] {
  const files: SyncChangeFile[] = [];
  for (const line of lines) {
    if (line.kind === 'file') {
      files.push({ path: line.text, lines: [] });
      continue;
    }
    if (!files.length) files.push({ path: '', lines: [] });
    files[files.length - 1].lines.push(line);
  }
  return files;
}

/** 这条记录里的「改了什么」；列表里一条一行，展开后按文件分组渲染 */
export function entryChangeLines(entry: SyncLogEntry): SyncChangeLine[] {
  return parseChangeLines(entry.data?.changes);
}

/** 条目改了几个文件（折叠态右侧的「N 处改动」） */
export function entryChangeCount(entry: SyncLogEntry): number {
  const lines = entryChangeLines(entry);
  if (!lines.length) return 0;
  const files = groupChangeFiles(lines).filter((file) => file.lines.some((line) => line.kind === 'add' || line.kind === 'del'));
  if (files.length) return files.length;
  const paths = entry.data?.paths;
  return Array.isArray(paths) ? paths.length : 1;
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
  lines.push('| 时间 | 结果 | 内容类型 | 事件 | 成员 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of entries) {
    const outcome = OUTCOME_LABELS[entryOutcome(entry)];
    const contents = entryContents(entry).join(' · ') || '—';
    const detail = (entry.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${formatLogTime(entry.ts)} | ${outcome} | ${contents} | ${eventLabel(entry.event)} | ${entry.peer || ''} | ${detail} |`);
  }
  lines.push('');
  lines.push('## 结构化字段');
  lines.push('');
  for (const entry of entries) {
    if (!entry.data || !Object.keys(entry.data).length) continue;
    lines.push(`### ${formatLogTime(entry.ts)} · ${eventLabel(entry.event)}`);
    lines.push('');
    for (const [key, value] of Object.entries(entry.data)) {
      // 改动正文按 diff 代码块导出：别人拿到导出文件也能看清「这一页改了什么」
      if (key === 'changes') {
        const changeLines = parseChangeLines(value);
        if (!changeLines.length) continue;
        lines.push(`- ${dataLabel(key)}：`);
        lines.push('');
        lines.push('```diff');
        for (const line of changeLines) {
          lines.push(line.kind === 'add' ? `+ ${line.text}` : line.kind === 'del' ? `- ${line.text}` : line.kind === 'ctx' ? `  ${line.text}` : line.text);
        }
        lines.push('```');
        lines.push('');
        continue;
      }
      lines.push(`- ${dataLabel(key)}：${formatDataValue(key, value)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
