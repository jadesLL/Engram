/**
 * 知识库侧栏「满窗」的纯计算（V2 分栏扫描）。2026-10-03 新增。
 *
 * 满窗态：点一下把目录铺满正文区，四个分区各占一列（概念 / 实体 / 原始资料 / 归档），
 * 列内自己滚、子类吸顶，长标题折到两行读完——窄栏 232–420px 里标题一律省略号，
 * 「一排页面看着一模一样，选不出要开哪一篇」。
 *
 * 落位与内置 Agent 满窗同款（components/ChatDrawer.vue 的 .full）：贴边铺满正文区、
 * 保留左侧图标栏、Esc 收回、满窗里导航就自动收回。
 *
 * 这里只放「和渲染无关、但错了就会走偏」的计算：列顺序、筛选 chips、可见数量与最新更新时间。
 */

export type SidebarFullColumnKey = 'concept' | 'entity' | 'raw' | 'archived';

/**
 * 列顺序：概念 → 实体 → 原始资料 → 归档。
 * 与窄栏的分区顺序同源（概念/实体/归档 + 原始资料），只是归档这个低流量分区放到最后一列，
 * 前面三列留给日常真正在看的库。
 */
export const SIDEBAR_FULL_COLUMNS: readonly SidebarFullColumnKey[] = ['concept', 'entity', 'raw', 'archived'];

export const SIDEBAR_FULL_LABELS: Record<SidebarFullColumnKey, string> = {
  concept: '概念',
  entity: '实体',
  raw: '原始资料',
  archived: '归档',
};

/** 列头标题的类型色（与首页「最近更新」的类型徽章同一套令牌） */
export const SIDEBAR_FULL_BADGES: Record<SidebarFullColumnKey, string> = {
  concept: 'concept',
  entity: 'entity',
  raw: 'note',
  archived: 'archived',
};

export interface SidebarFullChip {
  key: SidebarFullColumnKey | 'all';
  label: string;
  count: number;
}

/** 顶部筛选 chips：全部 + 四个分区，各带当前可见数量 */
export function sidebarFullChips(
  counts: Partial<Record<SidebarFullColumnKey, number>>
): SidebarFullChip[] {
  const body = SIDEBAR_FULL_COLUMNS.map((key) => ({
    key,
    label: SIDEBAR_FULL_LABELS[key],
    count: Math.max(0, counts[key] || 0),
  }));
  const total = body.reduce((sum, chip) => sum + chip.count, 0);
  return [{ key: 'all' as const, label: '全部', count: total }, ...body];
}

/** 当前筛选下真正显示出来的条目总数（chips 与「共 N 篇」共用同一个口径） */
export function sidebarFullVisibleTotal(
  counts: Partial<Record<SidebarFullColumnKey, number>>,
  active: SidebarFullColumnKey | 'all'
): number {
  if (active !== 'all') return Math.max(0, counts[active] || 0);
  return SIDEBAR_FULL_COLUMNS.reduce((sum, key) => sum + Math.max(0, counts[key] || 0), 0);
}
