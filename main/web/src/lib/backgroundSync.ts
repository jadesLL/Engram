/**
 * 安卓端「退到后台后还能再同步 10 分钟」的界面模型（纯逻辑，单测覆盖）。
 *
 * 原生侧（mobile/android/.../SyncEngine + SyncGraceService）在退到后台时给一轮同步一个有上限的
 * 宽限窗口，用前台服务（dataSync 类型）+ 唤醒锁保活；一轮收敛、到点或回到前台立即停止。
 * 窗口内要两枚运行时权限——通知（前台服务通知，Android 13+）与电池优化豁免（Doze / 厂商省电会
 * 冻结后台进程）。两枚都由原生在每次回到前台时主动申请，这里只把 `/api/sync/status` 的
 * `background` 字段翻译成可读文案。
 *
 * 桌面 / Docker 端没有这个字段（也没有后台同步这个概念）：`backgroundSyncView` 返回 null，
 * 界面整块隐藏（与 biometric / systemInsets 同一套降级口径）。
 */

/** 与原生 `BackgroundSyncPolicy.GRACE_MS` 同口径：退到后台后最多再同步 10 分钟 */
export const BACKGROUND_SYNC_MINUTES = 10;

export interface BackgroundSyncPermissionsState {
  /** 通知权限（Android 13+ 才是运行时权限；更低版本声明即授予，恒 true） */
  notifications?: boolean;
  /** 已加入电池优化白名单（Doze / 厂商省电不会冻结后台进程） */
  battery?: boolean;
}

export interface BackgroundSyncState {
  /** 只有 Android 本地端会报 true；桌面 / Docker 无此字段 */
  supported?: boolean;
  /** 已绑定中枢且同步开着（没绑定时窗口不会开，卡片只作说明） */
  enabled?: boolean;
  /** 宽限分钟数（原生按 GRACE_MS 派生，界面不要写死） */
  graceMinutes?: number;
  /** 现在是否正处在宽限窗口里 */
  active?: boolean;
  remainingMs?: number;
  permissions?: BackgroundSyncPermissionsState;
  /** 还缺的权限键（notifications / battery），顺序由原生给 */
  missing?: string[];
}

export interface BackgroundSyncView {
  minutes: number;
  active: boolean;
  /** 「后台同步中 · 还剩 8 分钟」/「已就绪 · 最多 10 分钟」/「绑定中枢后生效」 */
  statusLabel: string;
  hint: string;
  /** 缺的权限中文名（空数组 = 都齐了） */
  missingLabels: string[];
  allGranted: boolean;
}

const PERMISSION_LABELS: Record<string, string> = {
  notifications: '通知',
  battery: '电池优化',
};

export function permissionLabel(key: string): string {
  return PERMISSION_LABELS[key] || key;
}

/** 剩余分钟数：向上取整（还剩 30 秒也显示 1 分钟，不显示 0） */
export function remainingMinutes(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 60_000);
}

/**
 * 还缺哪些权限。
 *
 * 以原生给的 `missing` 为准（它按系统版本判断通知权限是否适用）；旧服务端没有 `missing` 时
 * 按 `permissions` 里的 false 推导，保证界面不会因为字段缺失而误报「都齐了」。
 */
export function missingPermissionLabels(state: BackgroundSyncState | null | undefined): string[] {
  const missing = Array.isArray(state?.missing) ? state!.missing! : [];
  if (missing.length) return missing.map((key) => permissionLabel(key));
  const permissions = state?.permissions || {};
  const derived: string[] = [];
  if (permissions.notifications === false) derived.push(permissionLabel('notifications'));
  if (permissions.battery === false) derived.push(permissionLabel('battery'));
  return derived;
}

/** 把 `/api/sync/status` 的 background 字段翻译成卡片文案；非 Android 端返回 null（整块隐藏） */
export function backgroundSyncView(state: BackgroundSyncState | null | undefined): BackgroundSyncView | null {
  if (!state || state.supported === false) return null;
  const minutes =
    typeof state.graceMinutes === 'number' && state.graceMinutes > 0
      ? state.graceMinutes
      : BACKGROUND_SYNC_MINUTES;
  const enabled = state.enabled !== false;
  const active = Boolean(state.active);
  const remaining = remainingMinutes(Number(state.remainingMs || 0));
  const missingLabels = missingPermissionLabels(state);
  const allGranted = missingLabels.length === 0;

  let statusLabel = `已就绪 · 最多 ${minutes} 分钟`;
  if (!enabled) statusLabel = '绑定中枢后生效';
  else if (active) statusLabel = remaining > 0 ? `后台同步中 · 还剩 ${remaining} 分钟` : '后台同步中';

  let hint = `退到后台会继续同步最多 ${minutes} 分钟，完成或到点自动停止；回到前台会立即再对一次账。`;
  if (!enabled) {
    hint = `绑定中枢并开启同步后，退到后台还会继续同步最多 ${minutes} 分钟。`;
  } else if (!allGranted) {
    hint = `退到后台会继续同步最多 ${minutes} 分钟；还缺 ${missingLabels.join('、')}，授权后才能完整跑满。`;
  }

  return { minutes, active, statusLabel, hint, missingLabels, allGranted };
}
