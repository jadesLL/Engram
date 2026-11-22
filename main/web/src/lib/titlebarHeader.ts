/**
 * 桌面融合标题栏（46px 铭牌页眉）的纯逻辑。
 *
 * 标题栏只做「上下文 + 入口」，数据全部复用既有来源，不新增接口：
 *  - 当前页名称：路由 → 分区名（与 rail / 侧栏的导航口径一致）；
 *  - 日期：本地时区，形如 `2026.11.22 周日`；
 *  - 同步胶囊：/api/sync/status → `已同步 / 同步中 / 同步中断 / 同步停用 / 中枢运行中`，
 *    未配置同步（role = none）返回 null，标题栏不出现该胶囊。
 *
 * 单独成模块是为了能在 node --test 里锁住文案与降级口径（App.vue 本身挂不起来）。
 */
import { syncStatusView, type SyncStatusInput, type SyncStatusOptions, type SyncTone } from './syncStatus.ts';

export interface TitlebarSyncChip {
  label: string;
  tone: SyncTone;
  /** 悬停提示：沿用 syncStatus 的排查说明 */
  tip: string;
  /** 读屏文案：把 detail 与「点开设置」一起说出来 */
  aria: string;
}

/**
 * 路由 → 当前分区名。`/page/:id` 是「页面」，`/page` 是「首页」——两者共用同一个路由前缀，
 * 必须先判带 id 的那一档。未知路径返回空串（标题栏不显示页名，日期照常）。
 */
export function titlebarSection(path: string): string {
  const clean = (path || '').split('?')[0].split('#')[0];
  if (!clean || clean === '/login') return '';
  if (clean === '/') return '首页';
  if (clean.startsWith('/page/')) return '页面';
  if (clean === '/page') return '首页';
  if (clean.startsWith('/search')) return '搜索';
  if (clean.startsWith('/graph')) return '知识图谱';
  if (clean.startsWith('/inbox')) return '收集箱';
  if (clean.startsWith('/tasks')) return '任务看板';
  if (clean.startsWith('/customer-research')) return '客户调研';
  /* 控制台整页挂在 /settings 下，必须排在设置之前 */
  if (clean.startsWith('/settings/agent-console')) return 'Agent 控制台';
  if (clean.startsWith('/settings')) return '设置';
  if (clean.startsWith('/agent')) return 'Agent';
  return '';
}

/** 标题栏日期（本地时区）：2026.11.22 周日 */
export function titlebarDate(now: Date = new Date()): string {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${week}`;
}

/** 状态档 → 标题栏短文案：比首页状态条更短，一块 24px 高的胶囊里只说一件事 */
const SHORT_LABEL: Record<'done' | 'syncing' | 'offline' | 'disabled' | 'hub', string> = {
  done: '已同步',
  syncing: '同步中',
  offline: '同步中断',
  disabled: '同步停用',
  hub: '中枢运行中',
};

export function titlebarSyncChip(
  status: SyncStatusInput | null | undefined,
  options: SyncStatusOptions = {},
): TitlebarSyncChip | null {
  const view = syncStatusView(status, options);
  if (!view) return null;
  const label = options.updating ? '更新中' : SHORT_LABEL[view.phase];
  return {
    label,
    tone: view.tone,
    tip: view.hint,
    aria: `${label}：${view.detail}（打开多端同步设置）`,
  };
}
