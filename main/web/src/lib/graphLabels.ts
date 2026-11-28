export interface GraphLabelBox { x: number; y: number; w: number; h: number }

export interface GraphBounds {
  x0: number; y0: number; x1: number; y1: number; trimmed: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 对标 Obsidian 的「文字淡出阈值」：
 * 远景优先显示高关联度 Hub 节点，随着画布放大，普通节点名称按阈值连续渐显；
 * 焦点/悬停/搜索命中的高优标签恒定不透明。
 */
export function computeLabelOpacity(
  scale: number,
  fadeThreshold: number,
  degRatio: number,
  isPriority: boolean,
): number {
  if (isPriority) return 1;
  const t = clamp(fadeThreshold, 0, 100) / 100;
  const baseStart = 0.15 + t * 1.35;
  const hubBoost = Math.sqrt(clamp(degRatio, 0, 1)) * (0.25 + t * 0.55);
  const start = Math.max(0.08, baseStart - hubBoost);
  const span = 0.35 + t * 0.25;
  return clamp((scale - start) / span, 0, 1);
}

/**
 * 计算自适应视图包围盒：当存在极少数飞远的离群点把全量包围盒拉大超过 1.45 倍时，
 * 优先按 3%–97% 分位对焦主网络，避免一两个孤点把核心知识星团缩成一粒芝麻。
 */
export function computeFitBounds(
  points: ReadonlyArray<{ x: number; y: number; r: number }>,
  preferMainCluster = true,
): GraphBounds {
  if (!points.length) return { x0: -100, y0: -100, x1: 100, y1: 100, trimmed: false };
  let fullX0 = Infinity; let fullY0 = Infinity; let fullX1 = -Infinity; let fullY1 = -Infinity;
  for (const p of points) {
    fullX0 = Math.min(fullX0, p.x - p.r);
    fullY0 = Math.min(fullY0, p.y - p.r);
    fullX1 = Math.max(fullX1, p.x + p.r);
    fullY1 = Math.max(fullY1, p.y + p.r);
  }
  if (!preferMainCluster || points.length < 16) {
    return { x0: fullX0, y0: fullY0, x1: fullX1, y1: fullY1, trimmed: false };
  }
  const xs = points.map((p) => p.x).sort((a, b) => a - b);
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  const loIdx = Math.floor((points.length - 1) * 0.03);
  const hiIdx = Math.ceil((points.length - 1) * 0.97);
  const trimX0 = xs[loIdx] - 24;
  const trimX1 = xs[hiIdx] + 24;
  const trimY0 = ys[loIdx] - 24;
  const trimY1 = ys[hiIdx] + 24;
  const fullSpanX = Math.max(1, fullX1 - fullX0);
  const fullSpanY = Math.max(1, fullY1 - fullY0);
  const trimSpanX = Math.max(1, trimX1 - trimX0);
  const trimSpanY = Math.max(1, trimY1 - trimY0);
  if (fullSpanX > trimSpanX * 1.45 || fullSpanY > trimSpanY * 1.45) {
    return { x0: trimX0, y0: trimY0, x1: trimX1, y1: trimY1, trimmed: true };
  }
  return { x0: fullX0, y0: fullY0, x1: fullX1, y1: fullY1, trimmed: false };
}

/** Keep planned positions; suppress collisions with priority labels instead of changing sides. */
export function acceptGraphLabel(box: GraphLabelBox, occupied: GraphLabelBox[]) {
  if (occupied.some((other) => box.x < other.x + other.w + 3 && box.x + box.w + 3 > other.x
    && box.y < other.y + other.h + 3 && box.y + box.h + 3 > other.y)) return false;
  occupied.push(box);
  return true;
}

/**
 * 节点/标签盒子的均匀网格：标签排布只需检查候选附近的几个格子，而不是逐个扫全部盒子。
 */
export function createLabelGrid(cell: number) {
  const cells = new Map<string, GraphLabelBox[]>();
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  const span = (b: GraphLabelBox) => ({
    x0: Math.floor(b.x / cell), x1: Math.floor((b.x + b.w) / cell),
    y0: Math.floor(b.y / cell), y1: Math.floor((b.y + b.h) / cell),
  });
  return {
    add(box: GraphLabelBox) {
      const s = span(box);
      for (let cx = s.x0; cx <= s.x1; cx++) for (let cy = s.y0; cy <= s.y1; cy++) {
        const k = key(cx, cy);
        const bucket = cells.get(k);
        if (bucket) bucket.push(box); else cells.set(k, [box]);
      }
    },
    intersects(box: GraphLabelBox) {
      const s = span(box);
      for (let cx = s.x0; cx <= s.x1; cx++) for (let cy = s.y0; cy <= s.y1; cy++) {
        const bucket = cells.get(key(cx, cy));
        if (!bucket) continue;
        for (const other of bucket) {
          if (box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y) return true;
        }
      }
      return false;
    },
  };
}
