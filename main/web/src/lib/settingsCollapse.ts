import { reactive } from 'vue';

/**
 * 设置分组卡片的折叠状态（2026-09-24）：按分组锚点 id 记录「谁被收起」，
 * 持久化到 localStorage，跨面板共享——SettingsGroup 组件与 SyncPanel /
 * UpdatePanel 手写的分组色带都读这份状态；设置页二级锚点跳转时会先
 * 展开目标分组（expandGroup）再滚动，避免「点了锚点但目标是收起的」。
 */

const STORAGE_KEY = 'engram:settings-collapsed-groups';

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const collapsed = reactive(new Set<string>(loadCollapsed()));

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* 隐私模式等写不进去时静默放弃，折叠只在当前会话生效 */
  }
}

/** 模板里直接调用即可被 Vue 跟踪（reactive Set） */
export function isGroupCollapsed(anchor?: string): boolean {
  return anchor ? collapsed.has(anchor) : false;
}

export function toggleGroupCollapsed(anchor?: string) {
  if (!anchor) return;
  if (collapsed.has(anchor)) collapsed.delete(anchor);
  else collapsed.add(anchor);
  persist();
}

/** 锚点定位前调用：目标分组若被收起则展开 */
export function expandGroup(anchor?: string) {
  if (anchor && collapsed.delete(anchor)) persist();
}
