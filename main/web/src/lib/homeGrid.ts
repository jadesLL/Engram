/**
 * 首页栅格排布（2026-10-07「手机桌面」模式）。
 *
 * 模型：页面是一张固定的**逻辑栅格**（GRID_COLS 列 × 若干行），每张卡占一块矩形
 * （col/row = 起点，w/h = 跨几列几行），拖动 = 改起点，缩放 = 改宽高。
 * 与上一版瀑布流的区别：位置是**用户明确指定**的、不再由算法推导，所以：
 *  - 拖动后卡片一定落在栅格上，不会「飞出」页面（越界会被夹进栅格）；
 *  - 缩放改的是同一套坐标，宽高都能拖；
 *  - 两张卡绝不重叠：占位冲突时当前卡片保持落点，其余卡片向下让位。
 *
 * 纯计算，不 import vue，`node --test` 直接跑。
 */

/**
 * 页面横向格数：手机桌面那种「一行 N 个格子」的 N。固定值——它就是「1 格」的定义。
 * 2026-10-08 由 6 列改成 12 列：板宽上限 1120px（内容约 1056px）时一格约 75px（手机图标大小），
 * 1×1 才真的只是「一个小格」；6 列时一格约 164px，1×1 画出来像 2×2。
 */
export const GRID_COLS = 12;
/** 默认查找范围；密集布局按实际底边扩展，不能截断造成重叠 */
export const GRID_MAX_ROWS = 96;
/** 旧版行高（兼容旧引用）；正式看板按可用宽度渲染正方形格子 */
export const GRID_ROW_HEIGHT = 76;
/** 默认渲染出来的行数（空看板的高度下限：别只剩一条缝） */
export const GRID_ROWS_VISIBLE = 6;

/** 卡片最小 / 最大格数（宽与高各自夹在这个区间） */
export const GRID_MIN_W = 1;
export const GRID_MIN_H = 1;
export const GRID_MAX_W = GRID_COLS;
/** 高上限跟着格数放宽：12 列下 24 行的物理高度 = 旧版 6 列下的 12 行 */
export const GRID_MAX_H = 24;

/** 卡片在栅格上占的位置（逻辑坐标，与像素无关） */
export interface GridPlace {
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * 浏览窗口变窄时减少显示列数：一格至少约 64px，所以板宽 958px 时仍能放下 12 列（一格约 67px），
 * 编辑态与浏览态看到的格子大小基本一致。逻辑布局仍保存 GRID_COLS 列，这里只是**只读**的显示列数。
 */
const VIEWPORT_COLUMN_LADDER = [GRID_COLS, 8, 6, 4, 2, 1] as const;
export function viewportColumns(width: number): number {
  const capacity = Math.floor((Math.max(0, width) + 14) / 78);
  return VIEWPORT_COLUMN_LADDER.find((columns) => columns <= capacity) ?? 1;
}

/** 窄窗口的只读排布，按原视觉顺序填空；不会修改保存的坐标、尺寸或顺序。 */
export function viewportPlaces(items: GridPlace[], columns: number): GridPlace[] {
  if (columns >= GRID_COLS) return items.map(item => ({ ...item }));
  const cols = Math.max(1, Math.floor(columns));
  const out = items.map(item => ({ ...item }));
  const occupied: GridPlace[] = [];
  const order = items.map((_, index) => index).sort((a, b) => items[a].row - items[b].row || items[a].col - items[b].col || a - b);
  for (const index of order) {
    const item = items[index];
    const w = Math.min(cols, item.w);
    let placed: GridPlace | undefined;
    for (let row = 0; !placed; row++) {
      for (let col = 0; col + w <= cols; col++) {
        const candidate = { col, row, w, h: item.h };
        if (occupied.some(other => intersects(candidate, other))) continue;
        placed = candidate;
        break;
      }
    }
    out[index] = placed;
    occupied.push(placed);
  }
  return out;
}

export function clampCol(value: number, w: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(GRID_COLS - w, Math.round(value)));
}

export function clampRow(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4096, Math.round(value)));
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
export function findFreeSpot(occupied: GridPlace[], w: number, h: number, maxRows = Math.max(GRID_MAX_ROWS, usedRows(occupied)), fromRow = 0): GridPlace | null {
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

/**
 * 把一张卡**放回栅格**：优先放在目标位置；那里被占了就把挡路的卡片下推。
 * 返回新的位置数组（与输入等长、顺序一致）。拖动 / 缩放 / 新增 / 尺寸变化都走这里，
 * 所以「卡片不会重叠、也不会飞出栅格」这条性质只需在这一处保证。
 */
export function placeItem(items: GridPlace[], index: number, wanted: GridPlace): GridPlace[] {
  if (index < 0 || index >= items.length) return items;
  const target = normalizePlace(wanted);
  const out = items.map(normalizePlace);
  out[index] = target;
  // 当前卡片固定在用户选择的落点。其余卡按原有视觉顺序向下让位；
  // 每张只与已经安置的矩形比较，最多 N² 次碰撞，不受 48 行截断影响。
  const placed = [target];
  const order = out.map((_, at) => at).filter((at) => at !== index)
    .sort((a, b) => items[a].row - items[b].row || items[a].col - items[b].col || a - b);
  for (const at of order) {
    const candidate = out[at];
    let hits = placed.filter((other) => intersects(candidate, other));
    while (hits.length) {
      candidate.row = Math.max(...hits.map((other) => other.row + other.h));
      hits = placed.filter((other) => intersects(candidate, other));
    }
    placed.push(candidate);
  }
  return out;
}

/**
 * 紧凑：所有卡片在**保持横向位置**的前提下往上收（只在用户明确点击「紧凑」时执行）。
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
    if (![a.col, a.row, a.w, a.h].every(Number.isInteger) || a.w > GRID_MAX_W || a.h > GRID_MAX_H) return false;
    if (a.col < 0 || a.row < 0 || a.w < GRID_MIN_W || a.h < GRID_MIN_H) return false;
    if (a.col + a.w > GRID_COLS) return false;
    for (let j = i + 1; j < items.length; j++) {
      if (intersects(a, items[j])) return false;
    }
  }
  return true;
}
