/**
 * 首页栅格排布（2026-10-07「手机桌面」模式）。
 *
 * 模型：页面是一张固定的**逻辑栅格**（GRID_COLS 列 × 若干行），每张卡占一块矩形
 * （col/row = 起点，w/h = 跨几列几行），拖动 = 改起点，缩放 = 改宽高。
 * 与上一版瀑布流的区别：位置是**用户明确指定**的、不再由算法推导，所以：
 *  - 拖动后卡片一定落在栅格上，不会「飞出」页面（越界会被夹进栅格）；
 *  - 缩放改的是同一套坐标，宽高都能拖；
 *  - 两张卡绝不重叠：占位冲突时后来者让位（findFreeSpot / 拖动后重排）。
 *
 * 纯计算，不 import vue，`node --test` 直接跑。
 */

/** 页面横向格数：手机桌面那种「一行 N 个格子」的 N。固定值——它就是「1 格」的定义 */
export const GRID_COLS = 6;
/** 最大行数：够摆 40 张卡，同时给「防止无限往下堆」一个边界 */
export const GRID_MAX_ROWS = 48;
/** 行高（px）：一格的高度；与 .board-grid 的 --grid-row-h 必须一致 */
export const GRID_ROW_HEIGHT = 76;
/** 默认渲染出来的行数（空看板的高度下限：别只剩一条缝） */
export const GRID_ROWS_VISIBLE = 6;

/** 卡片最小 / 最大格数（宽与高各自夹在这个区间） */
export const GRID_MIN_W = 1;
export const GRID_MIN_H = 1;
export const GRID_MAX_W = GRID_COLS;
export const GRID_MAX_H = 12;

/** 卡片在栅格上占的位置（逻辑坐标，与像素无关） */
export interface GridPlace {
  col: number;
  row: number;
  w: number;
  h: number;
}

export function clampCol(value: number, w: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(GRID_COLS - w, Math.round(value)));
}

export function clampRow(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(GRID_MAX_ROWS, Math.round(value)));
}

export function clampW(value: number): number {
  if (!Number.isFinite(value)) return GRID_MIN_W;
  return Math.max(GRID_MIN_W, Math.min(GRID_MAX_W, Math.round(value)));
}

export function clampH(value: number): number {
  if (!Number.isFinite(value)) return GRID_MIN_H;
  return Math.max(GRID_MIN_H, Math.min(GRID_MAX_H, Math.round(value)));
}

/** 把任意输入收敛成合法位置（宽高先夹，再按夹后的宽算 col 上限） */
export function normalizePlace(input: Partial<GridPlace> | null | undefined): GridPlace {
  const w = clampW(Number(input?.w));
  const h = clampH(Number(input?.h));
  return { col: clampCol(Number(input?.col), w), row: clampRow(Number(input?.row)), w, h };
}

/** 两张卡是否重叠（同一栅格上有交集） */
export function intersects(a: GridPlace, b: GridPlace): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** 在已有占位里找第一个能放下 w×h 的空位（按行优先 = 从上到下、从左到右） */
export function findFreeSpot(occupied: GridPlace[], w: number, h: number, maxRows = GRID_MAX_ROWS, fromRow = 0): GridPlace | null {
  const startRow = Math.max(0, Math.round(fromRow) || 0);
  const width = clampW(w);
  const height = clampH(h);
  for (let row = startRow; row <= maxRows; row++) {
    for (let col = 0; col + width <= GRID_COLS; col++) {
      const candidate: GridPlace = { col, row, w: width, h: height };
      if (!occupied.some((other) => intersects(candidate, other))) return candidate;
    }
  }
  return null;
}

/** 整体下移量：把 row ≥ from 的卡片往下推 delta 行（给「插入」腾地方） */
function shiftDown(items: GridPlace[], from: number, delta: number): GridPlace[] {
  return items.map((item) => (item.row >= from ? { ...item, row: item.row + delta } : item));
}

/**
 * 把一张卡**放回栅格**：优先放在目标位置；那里被占了就试附近（先右后下，再整体下推）。
 * 返回新的位置数组（与输入等长、顺序一致）。拖动 / 缩放 / 新增 / 尺寸变化都走这里，
 * 所以「卡片不会重叠、也不会飞出栅格」这条性质只需在这一处保证。
 */
export function placeItem(items: GridPlace[], index: number, wanted: GridPlace): GridPlace[] {
  if (index < 0 || index >= items.length) return items;
  const target = normalizePlace(wanted);
  const out = items.map((item) => ({ ...item }));
  const others = out.filter((_item, at) => at !== index);
  if (!others.some((other) => intersects(target, other))) {
    out[index] = target;
    return out;
  }

  // 先算「最低可放行」minRow：
  //  - 与目标直接相撞的卡，其下沿是硬底线（不能压在它身上）；
  //  - 从目标前面开始、在竖直方向与目标相交的卡，也必须整体让开
  //    （否则「整行卡插到前一张窄卡上边」——视觉顺序会乱）。
  let minRow = 0;
  for (const other of others) {
    if (intersects(target, other)) minRow = Math.max(minRow, other.row + other.h);
    else if (other.row <= target.row && other.row + other.h > target.row) minRow = Math.max(minRow, other.row + other.h);
  }

  // 1) 先试正下方：这是手机上拖动卡片后最符合直觉的落位
  const direct = normalizePlace({ ...target, row: minRow });
  if (!others.some((other) => intersects(direct, other))) {
    out[index] = direct;
    return out;
  }

  // 2) 再找栅格上任意一个空位（放在最低可放行的位置之后）
  const spot = findFreeSpot(others, direct.w, direct.h, GRID_MAX_ROWS, minRow);
  if (spot) {
    out[index] = { ...spot, w: direct.w, h: direct.h };
    return out;
  }

  // 3) 页面被塞满：把挡路的整体下推，再把这张放进目标位置
  const pushed = shiftDown(
    out.filter((_item, at) => at !== index),
    minRow,
    1
  );
  const merged: GridPlace[] = [];
  let cursor = 0;
  for (let at = 0; at < out.length; at++) {
    merged.push(at === index ? direct : pushed[cursor++]);
  }
  return merged;
}

/**
 * 紧凑：所有卡片在**保持横向位置**的前提下往上收（手机桌面上长按拖动后自动补洞的行为）。
 * 不改变先后顺序，也不改变宽高，只消掉竖直方向的空洞。
 */
export function compact(items: GridPlace[]): GridPlace[] {
  const out: GridPlace[] = [];
  for (const item of items) {
    const width = clampW(item.w);
    const height = clampH(item.h);
    let row = 0;
    // 逐行往下试，直到与已放置的卡片都不重叠
    for (;;) {
      const candidate: GridPlace = { col: clampCol(item.col, width), row, w: width, h: height };
      const hit = out.find((other) => intersects(candidate, other));
      if (!hit) {
        out.push(candidate);
        break;
      }
      row = hit.row + hit.h;
      if (row > GRID_MAX_ROWS) {
        out.push({ col: clampCol(item.col, width), row: GRID_MAX_ROWS, w: width, h: height });
        break;
      }
    }
  }
  return out;
}

/** 自动排列：按给定顺序**顺次铺满**（先左到右再换行），用于「一键排整齐」 */
export function autoArrange(sizes: Array<{ w: number; h: number }>): GridPlace[] {
  const out: GridPlace[] = [];
  let row = 0;
  let col = 0;
  let rowHeight = 0;
  for (const size of sizes) {
    const w = clampW(size.w);
    const h = clampH(size.h);
    if (col + w > GRID_COLS) {
      row += rowHeight;
      col = 0;
      rowHeight = 0;
    }
    out.push({ col, row, w, h });
    col += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return out;
}

/** 用了多少行（渲染时按它算容器高度，别留一大片空白） */
export function usedRows(items: GridPlace[]): number {
  return items.reduce((bottom, item) => Math.max(bottom, item.row + item.h), 0);
}

/** 位置数组是否合法：不越界、不重叠（写入前与测试都用它兜底） */
export function isSane(items: GridPlace[]): boolean {
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.col < 0 || a.row < 0 || a.w < GRID_MIN_W || a.h < GRID_MIN_H) return false;
    if (a.col + a.w > GRID_COLS) return false;
    for (let j = i + 1; j < items.length; j++) {
      if (intersects(a, items[j])) return false;
    }
  }
  return true;
}
