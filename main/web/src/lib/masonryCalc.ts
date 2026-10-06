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

/** 一张已放好的卡片（左上角坐标 + 尺寸，单位 px） */
export interface PackedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 两张卡片是否真的重叠（x 与 y 的区间同时交叠才算） */
export function overlaps(a: PackedRect, b: PackedRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 依次给每张卡找位置（瀑布流：往上补空档，同时保持前后视觉顺序）。
 *
 * 早先用的是「贪心放当前最矮的那条车道」，会在窄屏上留出肉眼可见的空档
 * （桌面 1/4 宽的小卡旁边空一大片 —— 2026-10-06 用户问「占位对不对」就是这个）：
 * 因为整行卡会把所有车道一起推下去，落单的小卡旁边那格就空着。这里改成碰撞检测：
 *  - 候选位只有 0 与其它卡的下沿，所以卡片一定紧贴已有卡片，不会悬在半空；
 *  - 候选位按「先矮后左」打分（y 优先、其次取 x 更小的），既补空档又不会往右乱飘；
 *  - 整行卡（span ≥ 车道数）的落点不允许早于 frontier（已经排到的位置）：
 *    否则它会「插到前面的卡上边」，视觉顺序会乱（1 号卡看起来排在 2 号卡后面）。
 */
export function placeCards(
  spans: ArrayLike<number>,
  heights: ArrayLike<number>,
  width: number,
  lanes: number,
  gap: number = GAP
): PackedRect[] {
  const laneWidth = (width - gap * (lanes - 1)) / lanes;
  const placed: PackedRect[] = [];
  /** 已经排到的纵向位置：整行卡的落点不能早于它 */
  let frontier = 0;

  for (let index = 0; index < (spans?.length || 0); index++) {
    const span = Math.max(1, Math.min(lanes, Math.round(Number(spans[index]) || 1)));
    const height = Math.max(0, Number(heights[index]) || 0);
    const cardWidth = span * laneWidth + (span - 1) * gap;

    // 候选落点：0 与其它卡的下沿
    const offsets = new Set<number>([0]);
    for (const rect of placed) offsets.add(rect.y + rect.height + gap);
    const sorted = [...offsets].sort((left, right) => left - right);

    let best: PackedRect | null = null;
    let bestScore = Infinity;
    let fallback: PackedRect | null = null;
    for (const y of sorted) {
      for (let lane = 0; lane + span <= lanes; lane++) {
        const rect: PackedRect = { x: lane * (laneWidth + gap), y, width: cardWidth, height };
        if (placed.some((other) => overlaps(rect, other))) continue;
        if (!fallback) fallback = rect;
        if (span >= lanes && y < frontier - 0.5) continue;
        // 打分：位置越靠上越好；同样高时取更左的那条 —— x 的权重远小于 y，只为打破并列
        const score = y * 1000 + rect.x;
        if (score < bestScore) {
          bestScore = score;
          best = rect;
        }
      }
    }

    const chosen = best || fallback || { x: 0, y: frontier, width: cardWidth, height };
    placed.push(chosen);
    frontier = Math.max(frontier, chosen.y + height + gap);
  }
  return placed;
}
