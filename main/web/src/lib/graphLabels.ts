export interface GraphLabelBox { x: number; y: number; w: number; h: number }

/** Keep planned positions; suppress collisions with priority labels instead of changing sides. */
export function acceptGraphLabel(box: GraphLabelBox, occupied: GraphLabelBox[]) {
  if (occupied.some((other) => box.x < other.x + other.w + 3 && box.x + box.w + 3 > other.x
    && box.y < other.y + other.h + 3 && box.y + box.h + 3 > other.y)) return false;
  occupied.push(box);
  return true;
}
