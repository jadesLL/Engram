import { getSetting, setSetting } from '../lib/db.js';
import { emit } from '../lib/events.js';
import { PREFERENCE_KEYS, syncAllowed } from './categories.js';
import { currentNodeId } from './store.js';

export interface PreferenceValue { value: string; updatedAt: number; nodeId: string }

/**
 * 偏好合并成功后的监听器（key + 远端 updatedAt）。
 * 用途：模型配置这类「偏好值还要落到别的文件」的项，需要在所有合并路径（SSE 应用 /
 * 全量对账 / 中枢处理成员 push）之后做一次本机应用，又不让本模块反向依赖同步业务模块。
 * 监听器实现方必须自己吞异常、异步执行，不能拖慢同步轮。
 */
export type PreferenceMergeListener = (key: string, updatedAt: number) => void;
let mergeListener: PreferenceMergeListener | null = null;

export function setPreferenceMergeListener(listener: PreferenceMergeListener | null): void {
  mergeListener = listener;
}
export function preferenceValue(key: string): PreferenceValue | null {
  if (!PREFERENCE_KEYS.includes(key as typeof PREFERENCE_KEYS[number])) return null;
  let meta: Partial<PreferenceValue> = {};
  try { meta = JSON.parse(getSetting(`sync_preference:${key}`) || '{}'); } catch { /* legacy */ }
  const value = getSetting(key);
  if (value == null) return null;
  return { value, updatedAt: Number(meta.updatedAt) || 0, nodeId: String(meta.nodeId || currentNodeId()) };
}
export function stampPreference(key: string, nodeId: string): void {
  if (!PREFERENCE_KEYS.includes(key as typeof PREFERENCE_KEYS[number])) return;
  const previous = preferenceValue(key);
  setSetting(`sync_preference:${key}`, JSON.stringify({ updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1), nodeId }));
}
export function preferenceWins(a: PreferenceValue, b: PreferenceValue | null): boolean {
  return !b || a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.nodeId > b.nodeId);
}
export function mergePreference(key: string, input: unknown): boolean {
  if (!syncAllowed('preference', key) || !input || typeof input !== 'object') return false;
  const p = input as PreferenceValue;
  if (typeof p.value !== 'string' || p.value.length > 1_000_000 || !Number.isFinite(p.updatedAt) || p.updatedAt < 0 || typeof p.nodeId !== 'string') return false;
  if (!preferenceWins(p, preferenceValue(key))) return false;
  setSetting(key, p.value);
  setSetting(`sync_preference:${key}`, JSON.stringify({ updatedAt: p.updatedAt, nodeId: p.nodeId }));
  emit('settings-changed', { key });
  // 合并成功才通知：监听器故障不能影响偏好落库（同步轮会重试）
  try {
    mergeListener?.(key, p.updatedAt);
  } catch {
    /* 监听器自己负责吞异常，这里再兜一层 */
  }
  return true;
}
export function preferenceSnapshot(): Record<string, PreferenceValue> {
  return Object.fromEntries(PREFERENCE_KEYS.filter(key => syncAllowed('preference', key))
    .map(key => [key, preferenceValue(key)]).filter(([, value]) => value !== null));
}
