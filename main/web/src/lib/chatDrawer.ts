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

/** 悬浮宽度上限 = 窗口宽度的 70%：越过即交棒给满窗 */
export function dockMaxWidth(viewport: number): number {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : MIN_DRAWER_WIDTH;
  return Math.max(MIN_DRAWER_WIDTH, Math.round(width * FULL_SNAP_RATIO));
}

/** 收敛到 [320, 窗口 70%]，并取整 */
export function clampDrawerWidth(width: number, viewport: number): number {
  const value = Number.isFinite(width) ? width : MIN_DRAWER_WIDTH;
  return Math.min(dockMaxWidth(viewport), Math.max(MIN_DRAWER_WIDTH, Math.round(value)));
}

/** 用户没拖过时跟随窗口宽度的默认值（与拖拽上线前的观感一致） */
export function defaultDrawerWidth(viewport: number): number {
  const width = Number.isFinite(viewport) && viewport > 0 ? viewport : 1440;
  return clampDrawerWidth(Math.min(520, Math.max(360, width * 0.32)), width);
}

/** 解析「当前该多宽」：有用户拖过的偏好就用它，否则跟随窗口 */
export function resolveDockWidth(viewport: number, stored: number | null | undefined): number {
  return stored === null || stored === undefined || !Number.isFinite(Number(stored))
    ? defaultDrawerWidth(viewport)
    : clampDrawerWidth(Number(stored), viewport);
}

/** 悬浮卡片打开时，正文右侧要让出的空间（卡片宽 + 贴边留白 + 呼吸） */
export function dockContentInset(width: number): number {
  const value = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  return value + DRAWER_INSET + DRAWER_GAP;
}
