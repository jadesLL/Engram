/**
 * 内置 Agent 聊天抽屉的滚动判定。
 *
 * 组件只负责把 DOM 上的三个数（scrollTop / scrollHeight / clientHeight）摘出来传进来，
 * 「算不算贴底」「要不要显示回到底部按钮」都在这里做纯函数，便于单测、也不让组件里散落魔法数字。
 *
 * 阈值分两档（64 / 96）是为了滞回（hysteresis），避免在边界上抖动：
 * - 离底 < 64px 算贴底，继续自动跟随最新消息（与 ChatDrawer 原有的自动跟随阈值完全一致）；
 * - 离底 >= 96px 才显示「回到底部」按钮。
 * 中间 64–95px 是滞回带：一旦上翻越过 96px 线，按钮出现后要往回滚进 64px 才消失，
 * 不会因为用户停在 64px 附近、滚动条一两个像素的抖动就让按钮反复闪现（自动跟随的开关同理）。
 *
 * 短内容（可滚动区间不超过 JUMP_BUTTON_PX）本来就能一眼看全，不该出现按钮。
 */

export interface ScrollMetrics {
  /** 已滚过的距离（px）；触控板 / iOS 回弹时会短暂大于最大值 */
  scrollTop: number;
  /** 内容总高度（px） */
  scrollHeight: number;
  /** 可视区高度（px） */
  clientHeight: number;
}

/** 离底小于这个值算「贴底」，恢复自动跟随（与 ChatDrawer 原有的 64px 阈值一致） */
export const STICK_TO_BOTTOM_PX = 64;
/** 离底达到这个值才显示「回到底部」按钮；与贴底阈值差 32px，形成滞回带 */
export const JUMP_BUTTON_PX = 96;

/**
 * 离底还有多远（px）：max(0, scrollHeight - scrollTop - clientHeight)。
 * 越过底部（回弹 / 越界）算出的负数归零；NaN、Infinity 这类异常值也按 0 处理，
 * 调用方不需要再兜底。
 */
export function distanceToBottom(m: ScrollMetrics): number {
  const distance = m.scrollHeight - m.scrollTop - m.clientHeight;
  return Number.isFinite(distance) ? Math.max(0, distance) : 0;
}

/** 是否贴底：贴底才继续自动跟随最新消息 */
export function isStuckToBottom(m: ScrollMetrics): boolean {
  return distanceToBottom(m) < STICK_TO_BOTTOM_PX;
}

/**
 * 是否显示「回到底部」按钮：内容确实可滚动（可滚动区间大于 JUMP_BUTTON_PX，短内容不显示），
 * 且离底已经达到 JUMP_BUTTON_PX。两个条件同时成立才显示。
 */
export function shouldShowJumpToBottom(m: ScrollMetrics): boolean {
  const scrollRange = m.scrollHeight - m.clientHeight;
  return scrollRange > JUMP_BUTTON_PX && distanceToBottom(m) >= JUMP_BUTTON_PX;
}
