/**
 * 「服务器更新」的跨刷新反馈（纯逻辑 + 可注入存储，便于 node --test 直接跑）。
 *
 * 一次 Docker 服务端更新会停掉旧容器、换新容器，页面在服务恢复后自动刷新；
 * 「刚才那次更新到底成没成」只能靠刷新前落一条标记、刷新后再比对版本来回答，
 * 否则用户回到新版页面时看不到任何证据。
 *
 * 三条纪律：
 *  - 只认**版本号或提交号真的变了**才算成功：switcher 回滚后版本原样，不能谎报成功；
 *  - 标记带有效期（默认 30 分钟）：过期自动丢弃，避免几天后打开应用突然弹一条旧提示；
 *  - 拿不到服务端状态时返回 unresolved 并保留标记，下次加载还有机会补上，不猜。
 */

export const SERVER_UPDATE_PENDING_KEY = 'engram:server-update-pending';
/** 标记有效期：超过它就不再提示（一次更新最多几分钟，30 分钟足够覆盖等待 + 手动刷新） */
export const SERVER_UPDATE_PENDING_TTL_MS = 30 * 60_000;

/** 更新入口：设置页卡片 / 右上角更新入口 / 桌面端远程更新同步中枢 */
export type ServerUpdateSource = 'settings' | 'notice' | 'hub';

export interface ServerUpdatePending {
  /** 标记写入时间（毫秒时间戳） */
  at: number;
  /** 更新前的版本号与提交号：刷新后拿它们对比，判断这次更新有没有真的落地 */
  fromVersion: string;
  fromCommit: string;
  source: ServerUpdateSource;
  /** 远程更新同步中枢时记下中枢主机名，提示里说清是哪台服务器 */
  hubHost?: string;
}

export interface ServerUpdateOutcome {
  /** none=没有待确认的更新；success=版本/提交号已变化；unchanged=服务恢复但版本没变（可能回滚）；unresolved=拿不到服务端状态 */
  status: 'none' | 'success' | 'unchanged' | 'unresolved';
  /** 更新后的版本号 / 提交号（拿得到才有） */
  version: string;
  commit: string;
}

/** 只用到这三件事的存储子集：localStorage 在隐私模式/禁用时可能直接抛错，调用方要能退化 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

interface StorageDeps {
  /** 注入存储便于单测；传 null 表示「没有存储」 */
  storage?: StorageLike | null;
  now?: number;
  ttl?: number;
}

/** 点「立即更新」时落一条标记（存储不可用时静默跳过，绝不阻塞更新本身） */
export function markServerUpdatePending(
  input: Omit<ServerUpdatePending, 'at'> & { at?: number },
  deps: StorageDeps = {},
): void {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  if (!storage) return;
  const pending: ServerUpdatePending = {
    at: input.at ?? (deps.now ?? Date.now()),
    fromVersion: String(input.fromVersion || ''),
    fromCommit: String(input.fromCommit || ''),
    source: input.source,
    hubHost: input.hubHost || undefined,
  };
  try {
    storage.setItem(SERVER_UPDATE_PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* 存储满/被禁用：提示少一条，更新照常执行 */
  }
}

export function clearServerUpdatePending(deps: StorageDeps = {}): void {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  if (!storage) return;
  try {
    storage.removeItem(SERVER_UPDATE_PENDING_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 读标记：过期、损坏、时钟明显回拨（本端时间比标记还早）都按「没有标记」处理并清掉 */
export function readServerUpdatePending(deps: StorageDeps = {}): ServerUpdatePending | null {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  if (!storage) return null;
  let raw = '';
  try {
    raw = storage.getItem(SERVER_UPDATE_PENDING_KEY) || '';
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    parsed = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const at = Number(parsed?.at || 0);
  const now = deps.now ?? Date.now();
  const ttl = deps.ttl ?? SERVER_UPDATE_PENDING_TTL_MS;
  if (!parsed || !Number.isFinite(at) || at <= 0 || now - at > ttl || now < at) {
    clearServerUpdatePending({ storage });
    return null;
  }
  const source = parsed.source === 'hub' || parsed.source === 'notice' ? parsed.source : 'settings';
  return {
    at,
    fromVersion: String(parsed.fromVersion || ''),
    fromCommit: String(parsed.fromCommit || ''),
    source,
    hubHost: parsed.hubHost ? String(parsed.hubHost) : undefined,
  };
}

/**
 * 拿刷新后的服务端状态回答「这次更新成没成」。
 * 版本号或提交号任一变化即成功；两者都拿不到基线（入口没读到 state）时按成功处理，
 * 因为更新流程本身已经跑完并等到服务恢复；版本没变则提示「可能已回滚」，不报成功。
 */
export function evaluateServerUpdateOutcome(
  pending: ServerUpdatePending | null,
  current: { currentVersion?: string; commit?: string } | null | undefined,
): ServerUpdateOutcome {
  if (!pending) return { status: 'none', version: '', commit: '' };
  if (!current) return { status: 'unresolved', version: '', commit: '' };
  const version = String(current.currentVersion || '');
  const commit = String(current.commit || '');
  const versionChanged = Boolean(pending.fromVersion && version && version !== pending.fromVersion);
  const commitChanged = Boolean(pending.fromCommit && commit && commit !== pending.fromCommit);
  const noBaseline = !pending.fromVersion && !pending.fromCommit;
  return {
    status: versionChanged || commitChanged || noBaseline ? 'success' : 'unchanged',
    version,
    commit,
  };
}

/** 提交号只显示前 7 位（与界面其它地方的提交号口径一致） */
export function shortCommit(commit: string | null | undefined): string {
  const text = String(commit || '').trim();
  return text.length > 7 ? text.slice(0, 7) : text;
}

/** 结果 → 一句提示文案（来源决定说「服务器」还是「同步服务器」，不含 HTML） */
export function serverUpdateOutcomeText(outcome: ServerUpdateOutcome, source: ServerUpdateSource = 'settings', hubHost = ''): string {
  const who = source === 'hub' ? (hubHost ? `同步服务器（${hubHost}）` : '同步服务器') : '服务器';
  const versionPart = outcome.version
    ? `（v${outcome.version}${outcome.commit ? ` · ${shortCommit(outcome.commit)}` : ''}）`
    : '';
  if (outcome.status === 'success') return `${who}更新成功${versionPart}`;
  if (outcome.status === 'unchanged') {
    return `${who}已重新启动，版本未变化——可能已自动回滚，或远端镜像与本地一致；可点「检查更新」复核`;
  }
  return '';
}
