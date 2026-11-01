/**
 * Android WindowSizeClass 的网页侧对应（2026-11 · 安卓改版）。
 *
 * 现有 640 / 768 / 1024 三档是「桌面窗口宽度」口径（见 lib/layoutBreakpoints.ts），
 * 安卓改版按 Android 官方窗口尺寸等级再补一档：
 *   - compact  < 600dp   手机竖屏、折叠屏合上、分屏窄窗
 *   - medium   600–839dp 折叠屏展开、小平板竖屏、手机横屏
 *   - expanded ≥ 840dp   平板横屏、桌面网页
 *
 * 两套断点并存：桌面与网页端行为不变，安卓端用这里判断「要不要换成导航栏 / 双栏」。
 * 600 / 840 与 CSS 里的媒体查询必须一致（mobileLayout.test 里会校验）。
 */

export const WINDOW_SIZE_MEDIUM = 600;
export const WINDOW_SIZE_EXPANDED = 840;

export type WindowSizeClass = 'compact' | 'medium' | 'expanded';

/** 纯函数，便于单测与 SSR 兜底 */
export function windowSizeClassFor(width: number): WindowSizeClass {
  if (width >= WINDOW_SIZE_EXPANDED) return 'expanded';
  if (width >= WINDOW_SIZE_MEDIUM) return 'medium';
  return 'compact';
}

export interface WindowSizeQueries {
  medium: string;
  expanded: string;
}

export const WINDOW_SIZE_QUERIES: WindowSizeQueries = {
  medium: `(min-width: ${WINDOW_SIZE_MEDIUM}px)`,
  expanded: `(min-width: ${WINDOW_SIZE_EXPANDED}px)`,
};

export function windowSizeClassFromMatches(medium: boolean, expanded: boolean): WindowSizeClass {
  if (expanded) return 'expanded';
  if (medium) return 'medium';
  return 'compact';
}
