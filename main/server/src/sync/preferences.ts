import { getSetting, setSetting } from '../lib/db.js';
import { emit } from '../lib/events.js';
import { PREFERENCE_KEYS, syncAllowed } from './categories.js';
import { currentNodeId } from './store.js';

export interface PreferenceValue { value: string; updatedAt: number; nodeId: string }
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
  return true;
}
export function preferenceSnapshot(): Record<string, PreferenceValue> {
  return Object.fromEntries(PREFERENCE_KEYS.filter(key => syncAllowed('preference', key))
    .map(key => [key, preferenceValue(key)]).filter(([, value]) => value !== null));
}
