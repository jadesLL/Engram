export interface GraphLabelBox { x: number; y: number; w: number; h: number }

/** Keep planned positions; suppress collisions with priority labels instead of changing sides. */
export function acceptGraphLabel(box: GraphLabelBox, occupied: GraphLabelBox[]) {
  if (occupied.some((other) => box.x < other.x + other.w + 3 && box.x + box.w + 3 > other.x
    && box.y < other.y + other.h + 3 && box.y + box.h + 3 > other.y)) return false;
  occupied.push(box);
  return true;
}

/**
 * 节点盒子的均匀网格：标签排布只需检查候选附近的几个格子，而不是逐个扫全部节点。
 * 原实现每个候选位置都 `.some()` 一遍所有可见节点，节点一多排布标签就 O(n²)。
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
