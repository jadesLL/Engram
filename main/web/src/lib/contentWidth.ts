/**
 * 正文列宽偏好：按「正文可用区」的百分比收敛（默认 70%）。
 *
 * 阅读视图与编辑视图共用同一份偏好（store 里的 readingPreferences.widthRatio），
 * 这样调一次两处都跟着变——用户视角只有一个「正文栏有多宽」的概念。
 */

/** 正文列占可用区的最小/最大比例：再窄会把每行压成几个字，再宽则失去可读行长 */
export const CONTENT_WIDTH_RATIO_MIN = 0.4;
export const CONTENT_WIDTH_RATIO_MAX = 1;
export const DEFAULT_CONTENT_WIDTH_RATIO = 0.7;

/** 菜单里的档位（与拖动/键盘微调共用同一套收敛逻辑） */
export const CONTENT_WIDTH_RATIO_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

export type ContentWidthRatio = number;

/** 任意来源的比例都收敛到安全区间并归整到 1%（0.4–1），缺失或非法值回落到 70% */
export function clampContentWidthRatio(value: unknown): ContentWidthRatio {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_CONTENT_WIDTH_RATIO;
  }
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return DEFAULT_CONTENT_WIDTH_RATIO;
  const clamped = Math.min(CONTENT_WIDTH_RATIO_MAX, Math.max(CONTENT_WIDTH_RATIO_MIN, ratio));
  return Math.round(clamped * 100) / 100;
}

/** 百分比显示：0.7 → 70% */
export function formatContentWidthRatio(ratio: ContentWidthRatio): string {
  return `${Math.round(clampContentWidthRatio(ratio) * 100)}%`;
}

/**
 * 把比例换算成实际列宽（px）。
 * available 是「正文可用区」宽度（已扣掉左侧图标栏/文件树等 chrome），
 * 非正数时返回 0，交由调用方回落到 100%。
 */
export function contentColumnWidth(ratio: ContentWidthRatio, available: number): number {
  if (!Number.isFinite(available) || available <= 0) return 0;
  return Math.round(available * clampContentWidthRatio(ratio));
}
