import { getSetting, setSetting } from '../lib/db.js';

export const CATEGORY_DEFAULTS = {
  knowledge: true, materials: true, assets: true, aiWorkspace: true,
  sessions: true, board: true, customerResearch: true, homeCards: false, settings: false,
};
export type SyncCategory = keyof typeof CATEGORY_DEFAULTS;
export const PREFERENCE_KEYS = ['home_layout', 'search_synonyms', 'name_fixes', 'show_ai_workspace', 'theme', 'editor_mode', 'customer_research_rules'] as const;

export function syncCategories(): Record<SyncCategory, boolean> {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(getSetting('sync_categories') || '{}'); } catch { /* defaults */ }
  return Object.fromEntries(Object.entries(CATEGORY_DEFAULTS).map(([key, value]) =>
    [key, typeof saved?.[key] === 'boolean' ? saved[key] : value])) as Record<SyncCategory, boolean>;
}

export function saveSyncCategories(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('同步分类配置无效');
  const next = syncCategories();
  for (const [key, value] of Object.entries(input)) {
    if (!(Object.hasOwn(CATEGORY_DEFAULTS, key)) || typeof value !== 'boolean') throw new Error('同步分类开关无效');
    next[key as SyncCategory] = value;
  }
  setSetting('sync_categories', JSON.stringify(next));
}

export function categoryFor(kind: string, target: string): SyncCategory | null {
  if (kind === 'preference') {
    // 客户调研流程模板是「客户洞察」板块的一部分：跟着客户洞察开关走，不混进「设置」分类，
    // 否则用户关掉客户洞察同步后，模板仍会跨端覆盖对端的调研流程。
    if (target === 'customer_research_rules') return 'customerResearch';
    return target === 'home_layout' ? 'homeCards'
      : PREFERENCE_KEYS.includes(target as typeof PREFERENCE_KEYS[number]) ? 'settings' : null;
  }
  // 客户调研是 wiki.db 里的记录，不是 brain 文件：必须先于 page/file/delete/move 的路径分类判断
  if (kind === 'research') return 'customerResearch';
  if (kind === 'session') return 'sessions';
  if (kind === 'board') return 'board';
  if (!['page', 'file', 'delete', 'move'].includes(kind)) return null;
  const root = target.replace(/\\/g, '/').split('/')[0];
  if (root === '原始资料') return 'materials';
  if (root === 'AIWorks') return 'aiWorkspace';
  if (root === 'assets') return 'assets';
  return 'knowledge';
}

export function syncAllowed(kind: string, target: string, oldPath = ''): boolean {
  const flags = syncCategories();
  const category = categoryFor(kind, target);
  if (!category || !flags[category]) return false;
  // 跨分类移动必须两侧都开启，避免关闭的内容被搬入/移除。
  const oldCategory = oldPath ? categoryFor(kind, oldPath) : category;
  return !!oldCategory && flags[oldCategory];
}
