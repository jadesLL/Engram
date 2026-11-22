/**
 * 内置 Agent 悬浮档的尺寸规则。
 *
 * 卡片宽度有两个用处：卡片自己有多宽、正文右侧要让它多少。首页（给正文留白）与抽屉
 * （自己算宽度）共用这一份算法，避免两处走样；宽度也只在抽屉里算一次，再同步给 store。
 */

/** 悬浮档最小宽度（再窄就装不下输入框与工具卡） */
export const MIN_DRAWER_WIDTH = 320;
/** 拖过窗口宽度这条比例线就不再是「悬浮卡片」，自动转满窗 */
export const FULL_SNAP_RATIO = 0.7;
/** 卡片贴窗口右缘的留白（与左侧文件树同一档 8px） */
export const DRAWER_INSET = 8;
/** 卡片与正文之间再留的呼吸 */
export const DRAWER_GAP = 12;
/** 只有图标栏时，正文左侧让位（Home 的 .content padding-left） */
export const CONTENT_RAIL_INSET = 64;
/** 知识库栏展开时，正文左侧让位 = 侧栏宽 + 72（Home 的 .sidebar-open .content） */
export const CONTENT_SIDEBAR_INSET = 72;
/**
 * 并排卡片必须给正文留下的最小可读宽度。
 * 知识库栏 + 正文 + 卡片同时打开时窗口放不下，就由知识库栏让位——不能把正文压成一条缝
 * （2026-11-22 报障：860 窗口下正文只剩 ~73px，标题竖排、阅读工具栏压成一列）。
 */
export const MIN_CONTENT_WITH_DOCK = 420;

/**
 * 悬浮宽度上限 = min(窗口 70%, 窗口留给正文至少 MIN_CONTENT_WITH_DOCK 后的余量)。
 * 只按 70% 算的话，窄窗口里卡片自己就能把正文挤没；reservedLeft 让首页把
 * 图标栏 / 知识库栏的占位一并算进来。
 */
export function dockMaxWidth(viewport: number, reservedLeft = 0): number {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : MIN_DRAWER_WIDTH;
  const reserved = Number.isFinite(reservedLeft) ? Math.max(0, Math.round(reservedLeft)) : 0;
  const contentCap = width - reserved - MIN_CONTENT_WITH_DOCK - DRAWER_INSET - DRAWER_GAP;
  return Math.max(
    MIN_DRAWER_WIDTH,
    Math.min(Math.round(width * FULL_SNAP_RATIO), Math.floor(contentCap)),
  );
}

/** 收敛到 [320, 上限]，并取整 */
export function clampDrawerWidth(width: number, viewport: number, reservedLeft = 0): number {
  const value = Number.isFinite(width) ? width : MIN_DRAWER_WIDTH;
  return Math.min(dockMaxWidth(viewport, reservedLeft), Math.max(MIN_DRAWER_WIDTH, Math.round(value)));
}

/** 用户没拖过时跟随窗口宽度的默认值（与拖拽上线前的观感一致） */
export function defaultDrawerWidth(viewport: number, reservedLeft = 0): number {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : 1440;
  return clampDrawerWidth(Math.min(520, Math.max(360, width * 0.32)), width, reservedLeft);
}

/**
 * 用户偏好（或默认）宽度，只受「不小于 320、不超过窗口 70%」约束。
 * 与 dockMaxWidth 的区别：不含「给正文留 MIN_CONTENT_WITH_DOCK」的上限——
 * 首页用它判断「按用户习惯的宽度，三栏还放不放得下」，避免上限把自己算窄后
 * 得出「放得下」的假结论。
 */
export function preferredDrawerWidth(viewport: number, stored: number | null | undefined): number {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : 1440;
  const value = stored === null || stored === undefined || !Number.isFinite(Number(stored))
    ? Math.min(520, Math.max(360, width * 0.32))
    : Number(stored);
  return Math.max(
    MIN_DRAWER_WIDTH,
    Math.min(Math.round(width * FULL_SNAP_RATIO), Math.max(MIN_DRAWER_WIDTH, Math.round(value))),
  );
}

/** 解析「当前该多宽」：有用户拖过的偏好就用它，否则跟随窗口 */
export function resolveDockWidth(viewport: number, stored: number | null | undefined, reservedLeft = 0): number {
  return stored === null || stored === undefined || !Number.isFinite(Number(stored))
    ? defaultDrawerWidth(viewport, reservedLeft)
    : clampDrawerWidth(Number(stored), viewport, reservedLeft);
}

/** 悬浮卡片打开时，正文右侧要让出的空间（卡片宽 + 贴边留白 + 呼吸） */
export function dockContentInset(width: number): number {
  const value = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  return value + DRAWER_INSET + DRAWER_GAP;
}

/** 卡片打开后正文还剩多宽（用于判断三栏是否放得下） */
export function dockContentRoom(viewport: number, reservedLeft: number, drawerWidth: number): number {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : 0;
  const reserved = Number.isFinite(reservedLeft) ? Math.max(0, Math.round(reservedLeft)) : 0;
  return Math.max(0, Math.round(width - reserved - dockContentInset(drawerWidth)));
}

/**
 * 知识库栏与并排卡片能否和平共处：扣掉侧栏与卡片后正文是否还够 MIN_CONTENT_WITH_DOCK。
 * 不够时窄窗口应让侧栏临时收起（见 Home.vue 的 sidebarYieldedToDock）。
 */
export function dockShouldYieldSidebar(
  viewport: number,
  sidebarWidth: number,
  drawerWidth: number,
): boolean {
  return dockContentRoom(viewport, sidebarWidth + CONTENT_SIDEBAR_INSET, drawerWidth) < MIN_CONTENT_WITH_DOCK;
}
