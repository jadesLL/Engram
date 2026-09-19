/**
 * 双链/关联跳转的返回轨迹（纯函数，便于单测）。
 *
 * 语义：
 * - 从来源页 A 跳到目标页 B 时 `pushTrail`，A（含标题）入栈；
 * - 路由落到页面 id 时 `settleTrail`：是本次跳转的目标就保留轨迹，
 *   否则说明用户是从侧栏/搜索/图谱等处过来的，轨迹作废（返回入口随之隐藏）；
 * - `takeTrailBack` 弹出上一页并把它登记为本次导航目标，使返回后剩余轨迹继续可用；
 * - `takeTrailBackTo` 直接跳回栈中任意一层，丢弃它之上的记录（下拉直选某一层用）。
 */

export type PageTrailEntry = {
  /** 来源页 id */
  id: string;
  /** 来源页标题（下拉里显示的「文件名称」）；空标题由展示层兜底 */
  title: string;
};

/** 入栈来源页的最小形状：调用方直接传当前页即可 */
export type PageTrailSource = {
  id?: string | null;
  title?: string | null;
};

export type PageTrailState = {
  /** 来源页栈（栈底 → 栈顶，栈顶 = 上一页） */
  trail: PageTrailEntry[];
  /** 本次跳转的目标页 id；非空表示「正在等待路由落到该页」 */
  target: string | null;
};

/** 轨迹上限：足够逐级回退，又不会无限增长 */
export const PAGE_TRAIL_LIMIT = 20;

export const EMPTY_PAGE_TRAIL: PageTrailState = { trail: [], target: null };

export function pushTrail(
  state: PageTrailState,
  from: PageTrailSource | null | undefined,
  toId: string,
): PageTrailState {
  const fromId = from?.id;
  if (!fromId || !toId || fromId === toId) return state;
  const entry: PageTrailEntry = { id: fromId, title: String(from?.title ?? '') };
  // 同一来源页只保留最近一次（标题随之刷新），避免来回跳转把栈撑满
  const trail = [...state.trail.filter((item) => item.id !== fromId), entry].slice(-PAGE_TRAIL_LIMIT);
  return { trail, target: toId };
}

export function settleTrail(state: PageTrailState, id: string): PageTrailState {
  if (state.target && state.target === id) return { trail: state.trail, target: null };
  if (!state.target && state.trail.length === 0) return state;
  return EMPTY_PAGE_TRAIL;
}

/**
 * 跳回轨迹中的某一层：该层之上的记录（含该层本身）一并出栈，该层成为本次导航目标。
 * 传入栈顶 id 即等价于逐层返回；id 不在栈中时原样返回（from 为 null）。
 */
export function takeTrailBackTo(
  state: PageTrailState,
  id: string,
): { state: PageTrailState; from: string | null } {
  const index = state.trail.findIndex((item) => item.id === id);
  if (index < 0) return { state, from: null };
  return {
    state: { trail: state.trail.slice(0, index), target: id },
    from: id,
  };
}

export function takeTrailBack(state: PageTrailState): { state: PageTrailState; from: string | null } {
  const top = state.trail[state.trail.length - 1];
  if (!top) return { state, from: null };
  return takeTrailBackTo(state, top.id);
}

/** 下拉展示项：栈顶（上一页）排最前，逐层往上 */
export type TrailMenuItem = PageTrailEntry & {
  /** 距离当前页的层数：1 = 上一页 */
  depth: number;
  /** 层数文案 */
  label: string;
};

export function trailMenuItems(trail: PageTrailEntry[]): TrailMenuItem[] {
  return [...trail].reverse().map((entry, index) => ({
    ...entry,
    depth: index + 1,
    label: index === 0 ? '上一页' : `第 ${index + 1} 层`,
  }));
}
