/**
 * 触觉反馈（安卓端）。
 *
 * 手机上的手势/入库/删除这类「没有按钮位移」的动作需要一下轻振作为确认；WebView 里
 * navigator.vibrate 在 Android 上可用（iOS 不支持，调用即被忽略），所以这里只做能力判断 +
 * 兜底 try/catch，不引入原生依赖。用户系统里关掉了触摸振动时由系统自己决定是否生效。
 *
 * 约定：只给离散动作（切底栏、打开面板、入库、删除、撤销）用，长度 8–18ms；
 * 连续滚动、输入和悬停不做振动——那些位置振动会变成噪声。
 */

const VIBRATE_PATTERNS = {
  /** 轻点确认：入库、保存、切换工作模式 */
  tap: 10,
  /** 成功：一次操作完成（比 tap 稍长一点，但不连续） */
  success: [12, 40, 12],
  /** 破坏性动作（移入回收站）：两下短促 */
  warning: [18, 30, 18],
} as const;

export type HapticKind = keyof typeof VIBRATE_PATTERNS;

/** 当前环境是否支持振动（仅用于测试/界面判断，调用方通常不需要先问） */
export function canHaptic(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** 触发一次触觉反馈；不支持或被系统拒绝时静默忽略，绝不影响业务流程 */
export function haptic(kind: HapticKind = 'tap'): void {
  if (!canHaptic()) return;
  try {
    navigator.vibrate(VIBRATE_PATTERNS[kind] as number | number[]);
  } catch {
    /* 振动失败不影响任何业务逻辑 */
  }
}
