/**
 * 首页同步状态展示模型（纯逻辑，便于单测）。
 *
 * 把 `/api/sync/status` 的原始状态翻译成「同步中 / 同步已完成 / 同步中断」一类的一句话状态：
 *  - 未配置同步（role = none）返回 null，首页据此整块隐藏；
 *  - 成员端区分「首次接入引导（全量对账 + 补拉）」「有排队改动」「断线重连」与「已完成」；
 *  - 中枢端没有客户端同步，展示的是「中枢运行中 + 成员在线数」；
 *  - Android 本地端是轮询模型（无常驻 SSE），按「最近一轮是否跑完」判定。
 */

export type SyncRole = 'hub' | 'member' | 'none';

/** 状态色调：ok=绿（已完成）/ busy=强调色（进行中）/ warn=琥珀（异常）/ muted=灰（已停用） */
export type SyncTone = 'ok' | 'busy' | 'warn' | 'muted';

export interface SyncStatusInput {
  role?: SyncRole;
  enabled?: boolean;
  connected?: boolean;
  /** 首次接入引导（全量对账 + 补拉重放）仍在进行 */
  syncing?: boolean;
  /** 全量对账正在执行（首次接入 / 手动触发 / 周期自愈） */
  reconciling?: boolean;
  /** Android 本地端：一轮同步是否仍在跑 */
  running?: boolean;
  pending?: number;
  pendingPulls?: number;
  lastSyncAt?: string | null;
  lastError?: string | null;
  peers?: Array<{ online?: boolean }>;
}

export interface SyncStatusView {
  phase: 'disabled' | 'syncing' | 'done' | 'offline' | 'hub';
  tone: SyncTone;
  /** Icon.vue 中的图标名 */
  icon: string;
  label: string;
  detail: string;
  /** 悬停提示：中枢地址、最近错误等排查信息 */
  hint: string;
}

export interface SyncStatusOptions {
  /** 注入当前时间便于单测 */
  now?: number;
  /** Android 本地端（Capacitor）：同步是「手动/定时跑一轮」而不是常驻长连接 */
  androidLocal?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 最近同步时间的相对描述：刚刚 / N 分钟前 / 今天 HH:MM / N 天前 / YYYY-MM-DD */
export function formatSyncTime(iso: string | null | undefined, now: number = Date.now()): string {
  const raw = (iso || '').trim();
  if (!raw) return '';
  const at = new Date(raw).getTime();
  if (!Number.isFinite(at)) return '';
  const diff = now - at;
  // 时钟漂移（本端比中枢慢）时不显示负数时间
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(at);
  if (new Date(now).toDateString() === date.toDateString()) {
    return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} 天前`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 错误信息一行内展示：过长时截断（完整内容仍可在 设置 → 多端同步 的日志里看） */
function shortError(message: string | null | undefined): string {
  const text = (message || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 底层网络错误（Node 的 `fetch failed`、`socket hang up`、`ECONNREFUSED`）对用户没有信息量，
 * 首页只给通用文案，原始错误留给悬停提示与设置页日志。
 */
const OPAQUE_ERROR = /^(fetch failed|terminated|socket hang up|other side closed|(connect )?econnrefused\b.*|(connect )?etimedout\b.*|network ?error.*)$/i;

function displayError(message: string | null | undefined): string {
  const text = shortError(message);
  return OPAQUE_ERROR.test(text) ? '' : text;
}

function withError(hint: string, error: string | null | undefined): string {
  const detail = shortError(error);
  return detail ? `${hint}；最近错误：${detail}` : hint;
}

export function syncStatusView(
  status: SyncStatusInput | null | undefined,
  options: SyncStatusOptions = {},
): SyncStatusView | null {
  if (!status) return null;
  const role: SyncRole = status.role || 'none';
  // 未配置同步：首页不出现任何同步相关元素
  if (role === 'none') return null;

  const now = options.now ?? Date.now();
  const lastSync = formatSyncTime(status.lastSyncAt, now);

  if (role === 'hub') {
    const peers = status.peers || [];
    const online = peers.filter((p) => p?.online).length;
    return {
      phase: 'hub',
      tone: 'ok',
      icon: 'server',
      label: '中枢运行中',
      detail: peers.length ? `${online}/${peers.length} 个成员在线` : '还没有成员设备绑定',
      hint: peers.length
        ? `本设备是同步群组的中枢，${online}/${peers.length} 个成员在线`
        : '本设备是同步群组的中枢，可在 设置 → 多端同步 添加成员设备',
    };
  }

  if (!status.enabled) {
    return {
      phase: 'disabled',
      tone: 'muted',
      icon: 'cloud-off',
      label: '同步已停用',
      detail: '本机改动照常保存，重新启用后自动补齐',
      hint: '多端同步已停用，可在 设置 → 多端同步 重新启用',
    };
  }

  const pending = Number(status.pending || 0);
  const pendingPulls = Number(status.pendingPulls || 0);

  // Android 本地端没有常驻事件流：状态是「最近一轮是否跑完」，与桌面/服务端口径不同
  if (options.androidLocal) {
    if (status.running || status.reconciling) {
      return {
        phase: 'syncing',
        tone: 'busy',
        icon: 'rotate-right',
        label: '同步中…',
        detail: '正在与中枢交换改动',
        hint: '正在与中枢同步，可继续使用本机知识库',
      };
    }
    if (!status.connected) {
      return {
        phase: 'offline',
        tone: 'warn',
        icon: 'cloud-off',
        label: '尚未同步',
        detail: displayError(status.lastError) || '联网后自动重试',
        hint: withError('最近一轮同步没有完成，联网后会自动重试', status.lastError),
      };
    }
    return {
      phase: 'done',
      tone: 'ok',
      icon: 'cloud-check',
      label: '同步已完成',
      detail: lastSync ? `最近同步 ${lastSync}` : '已与中枢同步',
      hint: withError('本机与中枢内容一致，离线期间照常可用', status.lastError),
    };
  }

  if (status.syncing || status.reconciling) {
    return {
      phase: 'syncing',
      tone: 'busy',
      icon: 'rotate-right',
      label: '同步中…',
      detail: status.syncing ? '首次同步，正在拉取知识库' : '正在全量对账',
      hint: status.syncing
        ? '首次接入要先整库对账再补齐历史改动，页面多时可能持续几分钟'
        : '正在与中枢逐项核对全库内容，完成后自动变为「同步已完成」',
    };
  }

  if (!status.connected) {
    return {
      phase: 'offline',
      tone: 'warn',
      icon: 'cloud-off',
      label: '同步中断',
      detail: displayError(status.lastError) || '未连接中枢，正在自动重连',
      hint: withError('与中枢的连接已断开，正在自动重连；本机改动会在恢复后补推', status.lastError),
    };
  }

  if (pending > 0 || pendingPulls > 0) {
    const parts: string[] = [];
    if (pending > 0) parts.push(`待推送 ${pending} 项`);
    if (pendingPulls > 0) parts.push(`待补拉 ${pendingPulls} 个文件`);
    return {
      phase: 'syncing',
      tone: 'busy',
      icon: 'rotate-right',
      label: '同步中…',
      detail: parts.join(' · '),
      hint: '本机改动正在推送到中枢，完成后自动变为「同步已完成」',
    };
  }

  return {
    phase: 'done',
    tone: 'ok',
    icon: 'cloud-check',
    label: '同步已完成',
    detail: lastSync ? `最近同步 ${lastSync}` : '已连接中枢',
    hint: withError('本机与中枢内容一致，改动会自动推送', status.lastError),
  };
}
