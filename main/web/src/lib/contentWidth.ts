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

/**
 * 阅读视图的正文列下限。
 *
 * 比例偏好解决的是「宽屏别把正文拉太长」，不是「窄容器也要按比例留白」：
 * 主列不足这个宽度时再乘 70%，一行只剩十来个字，标题与表格都会被压成竖排。
 * 容器不够就让正文取满——与手机档「412px 上 70% 只剩 258px → 一律 100%」同一条道理，
 * 只是判据从视口换成了阅读容器（2026-11-22 修标题竖排）。
 */
export const READING_ARTICLE_MIN_WIDTH = 460;

/**
 * 阅读视图目录列（220px 纸卡 + 34px 间距）能常驻所需的最小阅读容器宽度。
 *
 * 低于它就把目录收进顶栏「目录」浮层：再常驻下去正文列会被压到 390px 以下，
 * 标题、表格与代码块都开始折得难看。700px 是实测边界——1120px 窗口（左栏 322px）
 * 里关掉 Agent 抽屉时阅读容器约 768px，目录与本条固定 460px 正文仍能共存；
 * 打开 Agent 抽屉后容器掉到三百多像素，才必须让目录先走。
 * 与编辑视图的 1020 分开取值：阅读视图没有工具栏与页头元信息。
 */
export const READING_OUTLINE_RAIL_MIN_WIDTH = 700;

/**
 * 阅读视图正文列宽：`min(可用区, max(下限, 可用区 × 比例))`。
 * 可用区非法时返回 0，调用方照旧回落到 100%。
 */
export function readingColumnWidth(ratio: ContentWidthRatio, available: number): number {
  const column = contentColumnWidth(ratio, available);
  if (column <= 0) return 0;
  return Math.min(Math.round(available), Math.max(READING_ARTICLE_MIN_WIDTH, column));
}

/**
 * 文档标题字号：跟正文列宽走，22–38px。
 *
 * 旧写法 `clamp(28px, 4vw, 38px)` 用的是视口单位：Agent 抽屉把正文列压窄时视口没变，
 * 字号仍停在 38px，标题就变成一列一个字。按列宽的 7.6% 收敛后，宽屏仍是 38px，
 * 460px 列约 35px，318px 列约 24px，240px 列落到 22px 下限。
 */
export function readingTitleSize(column: number): number {
  if (!Number.isFinite(column) || column <= 0) return 38;
  return Math.round(Math.min(38, Math.max(22, column * 0.076)));
}
