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
 * 这里只放「和渲染无关、但错了就会走偏」的计算：列顺序、筛选 chips、可见数量、最新更新时间，
 * 以及原始资料行的状态标（已提炼等）。
 */

import { humanError } from './ingestError.ts';

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

/* ===================== 原始资料行的状态标 ===================== */

/** 色调直接对着 FileRow 的行尾状态位取名，颜色在 Sidebar.vue 里映射到同一批令牌 */
export type SidebarFullMarkTone = 'running' | 'failed' | 'success' | 'warning' | 'extracted' | 'muted';

export interface SidebarFullFileMark {
  label: string;
  tone: SidebarFullMarkTone;
  tip: string;
}

/** 入参只取用到的字段，形状与 `/api/files/list` 的一行、`app.fileJob()`、`ideaDistillStatus()` 对齐 */
export interface SidebarFullFileLike {
  path?: string | null;
  distilled?: boolean | null;
  extractionStatus?: string | null;
  extractionError?: string | null;
}

export interface SidebarFullJobLike {
  stage?: string | null;
  progress?: number | string | null;
  detail?: string | null;
}

export interface SidebarFullDistillLike {
  label: string;
  kind: 'running' | 'failed';
}

/**
 * 满窗原始资料列里那一行的状态标：**优先级与窄栏 FileRow 完全一致**
 * （提炼中/提炼失败 → 提取进度 → 已提炼 → 提取失败 → 部分提取 → 已提取 → 待提取）。
 *
 * 用户报障「原始资料也要能显示已提炼」（2026-10-03）：满窗列里原先只有标题和时间，
 * 窄栏里那颗绿色「已提炼」到了满窗就没了。两处口径必须同源，否则同一份文件在两种排布下
 * 说法不一样；判断放在这里，组件只负责画。
 *
 * 不做「只在满窗显示 + 窄栏不显示」这类分叉：同一个纯函数喂两个视图，改口径只改一处。
 */
export function sidebarFullFileMark(
  file: SidebarFullFileLike | null | undefined,
  job?: SidebarFullJobLike | null,
  distill?: SidebarFullDistillLike | null
): SidebarFullFileMark | null {
  if (distill) {
    return {
      label: distill.label,
      tone: distill.kind,
      tip: distill.kind === 'running'
        ? '正在后台提炼这条灵感'
        : '提炼失败：原文已保存，进灵感页可重新提炼',
    };
  }
  if (job) {
    const stage = String(job.stage || '').trim();
    const percent = Number(job.progress);
    return {
      label: `${stage} ${Number.isFinite(percent) ? Math.round(percent) : 0}%`.trim(),
      tone: 'running',
      tip: String(job.detail || job.stage || ''),
    };
  }
  if (file?.distilled) {
    return { label: '已提炼', tone: 'success', tip: '已由外部 Agent 提炼入库（来源证据抽屉可复核）' };
  }
  const status = String(file?.extractionStatus || '');
  if (status === 'failed') {
    return {
      label: '提取失败',
      tone: 'failed',
      tip: file?.extractionError ? `提取失败：${humanError(file.extractionError)}` : '提取失败，可重试',
    };
  }
  if (status === 'partial') {
    return {
      label: '部分提取',
      tone: 'warning',
      tip: String(file?.extractionError || '部分页面无文字层，识别交由外部 Agent'),
    };
  }
  if (status === 'completed') {
    return { label: '已提取', tone: 'extracted', tip: '文字已提取，可被检索；提炼由外部 Agent 处理' };
  }
  if (status) {
    return { label: '待提取', tone: 'muted', tip: '待提取' };
  }
  return null;
}
