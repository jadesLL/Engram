/**
 * 首页看板要用的纯展示助手（2026-10-05 从 EditorView 的欢迎页段落搬出来）：
 * 相对时间、类型徽章、待办元信息与到期胶囊——都是「给数据就能算出文案」的函数，
 * 放在 lib 里既能被多个模块组件复用，也能在 node --test 下直接单测（不碰 DOM）。
 */
import type { TaskCard } from './taskBoard.ts';
import { isOverdue } from './taskBoard.ts';

/** 相对时间：刚刚 / N 分钟前 / 今天 / N 天前 / N 个月前 */
export function fromNow(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return '今天';
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

/** 页面 / 资料的类型徽章：按路径分 概念 / 实体 / 灵感 / 资料 / 页面，meta 给去掉文件名的目录段 */
export function pageBadge(page: any): { cls: string; label: string; meta: string } {
  const path = String(page?.path || '');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').join(' / ') : path;
  if (path.startsWith('原始资料/灵感碎片/')) return { cls: 'tb-idea', label: '灵感', meta: dir };
  if (path.startsWith('Wiki/概念/')) return { cls: 'tb-concept', label: '概念', meta: dir };
  if (path.startsWith('Wiki/实体/')) return { cls: 'tb-entity', label: '实体', meta: dir };
  return { cls: 'tb-note', label: path.startsWith('原始资料/') ? '资料' : '页面', meta: dir };
}

/** 待办 meta：责任人 · 客户（内部工作落端组） */
export function taskMeta(card: TaskCard): string {
  return [card.owner, card.customer || card.team].filter(Boolean).join(' · ');
}

/** 到期胶囊：有日期给 M/D，否则给周期或时间原文 */
export function dueLabel(card: TaskCard): string {
  if (card.date) {
    const [, month, day] = card.date.split('-');
    return `${Number(month)}/${Number(day)}`;
  }
  return card.repeat || card.when || '待定';
}

/** 逾期高亮（今天不算逾期，口径与任务看板一致） */
export function isOverdueCard(card: TaskCard): boolean {
  return isOverdue(card);
}

/** 首页日期行（如「2026年10月5日 · 周一」） */
export function homeDateLine(now: Date = new Date()): string {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${week}`;
}

/** 大数字压缩：1234 → 1.2k、1234567 → 1.2M（首页卡片里的字数统计用） */
export function formatCount(value: number, unit = ''): string {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return `${n}${unit}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k${unit}`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M${unit}`;
}

/** 短版相对时间：卡片里位置窄，只说「今天 / N 小时前 / N 天前」 */
export function sinceShort(iso: string, now: number = Date.now()): string {
  if (!iso) return '';
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}


/** 问候语：按小时分档（深夜 / 早上 / 下午 / 晚上） */
export function homeGreeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return '夜深了，适合沉淀想法';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
