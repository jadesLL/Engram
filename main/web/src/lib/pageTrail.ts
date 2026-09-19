/**
 * 双链/关联跳转的返回轨迹（纯函数，便于单测）。
 *
 * 语义：
 * - 从来源页 A 跳到目标页 B 时 `pushTrail`，A 入栈；
 * - 路由落到页面 id 时 `settleTrail`：是本次跳转的目标就保留轨迹，
 *   否则说明用户是从侧栏/搜索/图谱等处过来的，轨迹作废（返回入口随之隐藏）；
 * - `takeTrailBack` 弹出上一页并把它登记为本次导航目标，使返回后剩余轨迹继续可用。
 */

export type PageTrailState = {
  /** 来源页 id 栈（栈顶 = 上一页） */
  trail: string[];
  /** 本次跳转的目标页 id；非空表示「正在等待路由落到该页」 */
  target: string | null;
};

/** 轨迹上限：足够逐级回退，又不会无限增长 */
export const PAGE_TRAIL_LIMIT = 20;

export const EMPTY_PAGE_TRAIL: PageTrailState = { trail: [], target: null };

export function pushTrail(
  state: PageTrailState,
  fromId: string | null | undefined,
  toId: string,
): PageTrailState {
  if (!fromId || !toId || fromId === toId) return state;
  // 同一来源页只保留最近一次，避免来回跳转把栈撑满
  const trail = [...state.trail.filter((id) => id !== fromId), fromId].slice(-PAGE_TRAIL_LIMIT);
  return { trail, target: toId };
}

export function settleTrail(state: PageTrailState, id: string): PageTrailState {
  if (state.target && state.target === id) return { trail: state.trail, target: null };
  if (!state.target && state.trail.length === 0) return state;
  return EMPTY_PAGE_TRAIL;
}

export function takeTrailBack(state: PageTrailState): { state: PageTrailState; from: string | null } {
  const from = state.trail[state.trail.length - 1] ?? null;
  if (!from) return { state, from: null };
  return {
    state: { trail: state.trail.slice(0, -1), target: from },
    from,
  };
}
