/**
 * 瀑布流的纯计算（不 import vue，`node --test` 可直接跑）。
 * 组件侧的组合式函数在 lib/masonry.ts，它从这里取「宽 → 车道数」的口径。
 *
 * 车道（lane）模型：页宽按车道均分，每张卡按自己的格数跨几条车道。
 *  - 车道数由「页面上需要的最大格数」决定：默认布局里速记是 4 格（整行），就开 4 条车道，
 *    于是 1 格 = 1/4 页、2 格 = 1/2 页、4 格 = 整行，和用户选列数时的预期一致；
 *  - 中途格数（例 5 列页面的 3 格）会落进「最矮的那条车道」，不会强行按 3/4 宽 —— 瀑布流的本意。
 */

/** 一条车道的最小宽度：低于它就不开这条车道（窄屏宁可少开几条） */
export const MIN_LANE_WIDTH = 168;
/** 车道间距（列与列之间留的口子，比网格的 18px 窄一点，形更好看） */
export const GAP = 12;
/** 单列模式阈值：容器比这更窄就退回普通文档流 */
export const SINGLE_COLUMN_WIDTH = 360;
/** 一条车道的最大条数：与 MODULE_SPANS 的上限一致 */
export const MAX_LANES = 5;

/** 宽 W 的容器能开几条车道（不超过 wanted） */
export function laneCount(width: number, wanted: number): number {
  if (!Number.isFinite(width) || width < SINGLE_COLUMN_WIDTH) return 1;
  const fits = Math.floor((width + GAP) / (MIN_LANE_WIDTH + GAP));
  const want = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 1;
  return Math.max(1, Math.min(MAX_LANES, want, fits));
}

/** 页面上模块需要的最大格数（决定要开几条车道）：给一串 span，返回夹在 1..MAX_LANES 的值 */
export function maxSpan(spans: ArrayLike<number>): number {
  let top = 1;
  for (let i = 0; i < (spans?.length || 0); i++) {
    const value = Number(spans[i]);
    if (Number.isFinite(value)) top = Math.max(top, Math.min(MAX_LANES, Math.round(value)));
  }
  return top;
}
