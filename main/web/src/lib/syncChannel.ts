/**
 * 连接通道展示模型（纯逻辑，便于单测）。
 *
 * 「现在走的是哪条路」由 `/api/sync/status` 的 `link` 字段给出（局域网 / IPv6 / IPv4 / 已断开）；
 * 侧栏胶囊、首页状态条、设置页「局域网优先」三处都读这一份翻译结果，同一个状态不会三种说法。
 *
 * 两条纪律：
 *  - **颜色不在 TS 里写死**：这里只给 `key`，具体色值由 CSS 的 `.link-<key>` 决定
 *    （浅色/深色两套令牌在 styles/main.css）——深色主题、可访问性调整只改一处；
 *  - **缺 `link` 时不猜**：Android 本地端暂时没有这个字段，只能按中枢地址推断；
 *    推断不出来（域名可能走 AAAA 也可能走 A，公网地址也一样）就退回中性的「已连接」，
 *    宁可少说一句，也不把域名硬编成四色之一。
 */
// 带 .ts 后缀：这个模块要被 node --test 直接跑（与 lib/agentActivity.ts、lib/markdown.ts 同一写法）
import { formatSyncTime, type SyncStatusInput } from './syncStatus.ts';

export type SyncChannelKind = 'lan' | 'ipv6' | 'ipv4' | 'offline';

/** 候选探测明细里的一条（局域网地址 / 中枢主地址） */
export interface SyncLinkCandidate {
  /** lan=中枢通告的局域网候选；hub=中枢主地址（域名 / 隧道） */
  kind: 'lan' | 'hub';
  /** 展示用，如「局域网」「中枢域名」 */
  label: string;
  /** 基地址，无尾斜杠 */
  url: string;
  ok: boolean;
  latencyMs: number | null;
  /** 失败时一行原因 */
  error?: string;
}

/** 成员端当前通道（服务端探测结果；中枢端与未配置时为 null） */
export interface SyncLinkStatus {
  channel: SyncChannelKind;
  /** 当前通道基地址（offline 时为空串） */
  url: string;
  /** 展示用主机，如 192.168.x.x:18080 或 hub.xxx.com */
  host: string;
  latencyMs: number | null;
  /** 当前通道从何时开始在用（ISO） */
  since: string | null;
  probedAt: string | null;
  /** 「优先局域网」开关状态 */
  preferLan: boolean;
  /** 按优先级排序的候选探测明细 */
  candidates: SyncLinkCandidate[];
}

/** 胶囊颜色只认这个 key（`.link-<key>`）；hub/muted/connected 是四色之外的中性档 */
export type SyncChannelKey = SyncChannelKind | 'hub' | 'muted' | 'connected';

/** 状态输入：在首页状态模型的字段上补 link 与 hubUrl（后者用于没有 link 时推断通道） */
export interface SyncChannelInput extends SyncStatusInput {
  link?: SyncLinkStatus | null;
  hubUrl?: string;
}

export interface SyncChannelView {
  /** 颜色/样式类名的后半段 */
  key: SyncChannelKey;
  /** 胶囊上的短文案：局域网 / IPv6 / 已断开 / 中枢 2/3 … */
  label: string;
  /** 详情里的完整说法：局域网直连 / 连接中断 … */
  fullLabel: string;
  /** 提示第一行：通道名 · 主机 */
  title: string;
  /** 提示第二行：延迟 / 最近同步 / 队列 */
  detail: string;
  /** 提示第三行：这块能点出什么 */
  hint: string;
  /** 叠加态：同步进行中或还有排队改动。通道颜色与文案不变，只是转起来 + 挂角标 */
  busy: boolean;
  /** 角标数量（待推送项数；角标只在 >0 时出现） */
  pending: number;
  host: string;
  latencyMs: number | null;
  since: string | null;
}

export interface SyncChannelOptions {
  /** 注入当前时间便于单测 */
  now?: number;
}

const CHANNEL_LABEL: Record<SyncChannelKey, string> = {
  lan: '局域网',
  ipv6: 'IPv6',
  ipv4: 'IPv4',
  offline: '已断开',
  connected: '已连接',
  hub: '中枢',
  muted: '已停用',
};

const CHANNEL_FULL_LABEL: Record<SyncChannelKey, string> = {
  lan: '局域网直连',
  ipv6: 'IPv6 直连',
  ipv4: 'IPv4 直连',
  offline: '连接中断',
  connected: '已连接中枢',
  hub: '中枢运行中',
  muted: '同步已停用',
};

/** 提示的第三行：这块的两个热区各自做什么（断开时右侧那颗 ⟳ 换成重连） */
const HINT_READY = '点左侧看通道详情，点 ⟳ 立即同步';
const HINT_OFFLINE = '点左侧看通道详情，点 ⟳ 立即重连';

/** 私网 / 本机地址：命中就说明这条链路只在同一网段里通，与公网通道区分开 */
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const V4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 只有中枢地址、没有 link 时（Android 本地端）推断当前通道。
 * 只认**字面量**能定死的地址：IPv6 字面量、IPv4 字面量、本机/局域网地址；
 * 域名返回 null——它可能走 AAAA 也可能走 A，前端无从得知，别编。
 */
export function inferChannelFromUrl(url: string | null | undefined): SyncChannelKind | null {
  const raw = (url || '').trim();
  if (!raw) return null;
  // 只留 authority：去掉 scheme 与路径（http://host:port/xxx）
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  const hostPort = authority.split('@').pop() || authority;
  if (!hostPort) return null;
  // 带方括号的 IPv6 字面量：http://[fd00::1]:18080
  if (/^\[[^\]]+\]/.test(hostPort)) return 'ipv6';
  const hostname = hostPort.replace(/:\d+$/, '').toLowerCase();
  // 裸 IPv6 字面量（去掉端口后仍带冒号）
  if (hostname.includes(':')) return 'ipv6';
  if (!hostname) return null;
  if (hostname === 'localhost' || hostname.endsWith('.local')) return 'lan';
  if (V4.test(hostname)) return PRIVATE_V4.test(hostname) ? 'lan' : 'ipv4';
  return null;
}

/** 中枢地址 → 展示用主机（去 scheme / 路径，保留端口） */
function hubHost(url: string | null | undefined): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
}

/** 服务端给的 channel 取值认不认识；认不出就交给调用方退回中性档（不硬套四色之一） */
function knownChannel(value: unknown): SyncChannelKind | null {
  return value === 'lan' || value === 'ipv6' || value === 'ipv4' || value === 'offline' ? value : null;
}

/**
 * 底层网络错误（Node 的 `fetch failed`、`socket hang up`、`ECONNREFUSED`）对用户没有信息量：
 * 界面只给通用文案，原始错误留给「同步详情」的日志（与 lib/syncStatus.ts 的 displayError 同口径，
 * 那边没有导出，这里保留一份供浮层使用）。
 *
 * 2026-09-29 补上手机端的说法：Android 走 OkHttp，连不上时给的是
 * `failed to connect to /10.0.0.9 (port 18080): ...`、`connect timed out`、
 * `Unable to resolve host "…"` 这类整句英文。以前没过这一层，侧栏通道条上会直接挂一句英文报错
 * （用户报障的那个位置），现在回落到「未连接中枢，正在自动重连」。
 */
const OPAQUE_ERROR = /^(fetch failed|terminated|socket hang up|other side closed|failed to connect\b.*|connect(ion)? timed out\b.*|unable to resolve host\b.*|(connect )?econnrefused\b.*|(connect )?etimedout\b.*|network ?error.*)$/i;

export function channelErrorText(message: string | null | undefined): string {
  const text = (message || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (OPAQUE_ERROR.test(text)) return '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 「当前通道已经用了多久」：比 formatSyncTime 更强调时长，
 * 因为这句话回答的是「这条路稳不稳」，而不是「上次同步是什么时候」。
 */
export function formatChannelSince(iso: string | null | undefined, now: number = Date.now()): string {
  const raw = (iso || '').trim();
  if (!raw) return '';
  const at = new Date(raw).getTime();
  if (!Number.isFinite(at)) return '';
  // 时钟漂移（本端比中枢慢）时不显示负时长
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }
  return `${Math.floor(hours / 24)} 天`;
}

/** 连接正常时的第二行：延迟 / 最近同步 / 队列，有哪段说哪段 */
function channelDetail(parts: {
  latencyMs?: number | null;
  lastSync?: string;
  pending?: number;
  pendingPulls?: number;
}): string {
  const bits: string[] = [];
  if (typeof parts.latencyMs === 'number') bits.push(`延迟 ${parts.latencyMs}ms`);
  if (parts.lastSync) bits.push(`最近同步 ${parts.lastSync}`);
  if (Number(parts.pending) > 0) bits.push(`待推送 ${parts.pending} 项`);
  if (Number(parts.pendingPulls) > 0) bits.push(`待补拉 ${parts.pendingPulls} 个文件`);
  return bits.join(' · ');
}

export function syncChannelView(
  status: SyncChannelInput | null | undefined,
  options: SyncChannelOptions = {},
): SyncChannelView | null {
  if (!status) return null;
  const role = status.role || 'none';
  // 未配置同步：整块不渲染（与今天、与首页状态条一致）
  if (role === 'none') return null;

  const now = options.now ?? Date.now();
  const pending = Math.max(0, Number(status.pending || 0));
  const pendingPulls = Math.max(0, Number(status.pendingPulls || 0));
  // 叠加态：同步进行中或还有排队改动。通道颜色与文案都不变，只是转起来 + 挂角标
  const busy = Boolean(status.syncing || status.reconciling || status.running)
    || pending > 0
    || pendingPulls > 0;

  // 中枢端没有「连出去」的通道：改看成员在线数，颜色用中性（不占四色语义）
  if (role === 'hub') {
    const peers = status.peers || [];
    const online = peers.filter((peer) => peer?.online).length;
    return {
      key: 'hub',
      label: peers.length ? `${CHANNEL_LABEL.hub} ${online}/${peers.length}` : CHANNEL_LABEL.hub,
      fullLabel: CHANNEL_FULL_LABEL.hub,
      title: peers.length ? `${CHANNEL_FULL_LABEL.hub} · ${online}/${peers.length} 个成员在线` : CHANNEL_FULL_LABEL.hub,
      detail: peers.length ? `${online}/${peers.length} 个成员在线` : '还没有成员设备绑定',
      hint: '本设备是同步群组的中枢，成员设备从这里取数据',
      busy,
      pending,
      host: '',
      latencyMs: null,
      since: null,
    };
  }

  const lastSync = formatSyncTime(status.lastSyncAt, now);

  if (!status.enabled) {
    return {
      key: 'muted',
      label: CHANNEL_LABEL.muted,
      fullLabel: CHANNEL_FULL_LABEL.muted,
      title: CHANNEL_FULL_LABEL.muted,
      detail: '本机改动照常保存，重新启用后自动补齐',
      hint: '可在 设置 → 多端同步 重新启用',
      busy,
      pending,
      host: '',
      latencyMs: null,
      since: null,
    };
  }

  /** 四色里的红档：所有候选地址都不可达（或还没连上） */
  const offlineView = (): SyncChannelView => ({
    key: 'offline',
    label: CHANNEL_LABEL.offline,
    fullLabel: CHANNEL_FULL_LABEL.offline,
    title: '连接中断 · 所有通道不可达',
    detail: channelErrorText(status.lastError)
      || (pending > 0 ? `改动已排队 ${pending} 项，恢复后自动补齐` : '未连接中枢，正在自动重连'),
    hint: HINT_OFFLINE,
    busy,
    pending,
    host: '',
    latencyMs: null,
    since: null,
  });

  if (!status.connected) return offlineView();

  const link = status.link || null;
  // link 是权威来源。但「link 说全都不可达、数据面却刚刚通信成功」是可能出现的：中枢刚重启时
  // 数据面已经通了，探测记账还没追上（服务端在通信成功后补一轮探测，20 秒节流）。
  // 这时以**实际通信**为准，落到中性「已连接」，而不是拿红色「已断开」去吓一个正在正常同步的用户。
  // 认不出的取值（旧客户端 / 服务端将来加了新档）同样退回中性档，不硬套四色之一。
  const declared: SyncChannelKind | null = link
    ? (link.channel === 'offline' ? null : knownChannel(link.channel))
    : inferChannelFromUrl(status.hubUrl);

  const key: SyncChannelKey = declared || 'connected';
  const host = ((link ? link.host : hubHost(status.hubUrl)) || '').trim();
  const latencyMs = link && typeof link.latencyMs === 'number' ? link.latencyMs : null;
  return {
    key,
    label: CHANNEL_LABEL[key],
    fullLabel: CHANNEL_FULL_LABEL[key],
    title: host ? `${CHANNEL_FULL_LABEL[key]} · ${host}` : CHANNEL_FULL_LABEL[key],
    detail: channelDetail({ latencyMs, lastSync, pending, pendingPulls }),
    hint: HINT_READY,
    busy,
    pending,
    host,
    latencyMs,
    since: link?.since || null,
  };
}
