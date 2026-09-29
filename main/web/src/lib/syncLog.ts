import { reactive } from 'vue';
import { api } from '../api';
import { notify } from './notify';
import { OUTCOME_LABELS, buildSyncLogJson, buildSyncLogMarkdown, entryContents, entryOutcome } from './syncLogFormat';
import type { SyncLogContent, SyncLogEntry, SyncLogOutcome, SyncLogPage, SyncLogStatus, SyncLogSummary } from './syncLogFormat';

/**
 * 同步详情（「多端同步」的独立窗口）状态与请求逻辑。
 *
 * 与图片资产抽屉同一套形态：状态放模块级 reactive，抽屉挂在 App.vue 上（Teleport 到 body），
 * 任何视图里都能打开——设置页只留一个「查看同步详情」按钮，不再被一坨可展开日志拉长。
 *
 * 条目来自 /api/sync/log（服务端落盘、保留最近 N 条 / M 天），筛选与分页都在服务端做：
 * 前端只维护「当前筛选条件 + 已加载页」，翻页用 before=最旧一条的 id 向前取。
 * 展示层工具（标签/格式化/导出文本）在 lib/syncLogFormat.ts，这里统一再导出，组件只认一个入口。
 */

export * from './syncLogFormat';

export type SyncLogMode = 'dock' | 'full';

const PAGE_SIZE = 200;
const AUTO_REFRESH_STORAGE_KEY = 'syncLogAutoRefresh';

function initialAutoRefresh(): boolean {
  // 隐私模式/测试环境下 localStorage 可能不可用，取不到就按默认「开」处理
  try {
    return localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function initialMode(): SyncLogMode {
  try {
    return localStorage.getItem('syncLogMode') === 'full' ? 'full' : 'dock';
  } catch {
    return 'dock';
  }
}

export const syncLogState = reactive({
  open: false,
  /** dock=右侧悬浮卡片，full=铺满窗口（与内置 Agent 卡片同一套形态语言） */
  mode: initialMode() as SyncLogMode,
  entries: [] as SyncLogEntry[],
  total: 0,
  hasMore: false,
  summary: null as SyncLogSummary | null,
  status: null as SyncLogStatus | null,
  loading: false,
  loadingMore: false,
  error: '',
  /** 筛选条件（改任一条件都重新从服务端第一页拉）：结果 + 内容类型 + 成员 + 关键词 */
  outcome: 'all' as SyncLogOutcome | 'all',
  content: 'all' as SyncLogContent | 'all',
  peer: '',
  query: '',
  /** 自动刷新：默认开——空闲 5 秒一跳、同步进行中 2 秒一跳（同步中的人正盯着看），可暂停慢慢读 */
  autoRefresh: initialAutoRefresh(),
  /** 展开详情的条目 id 集合 */
  expanded: [] as number[],
  lastLoadedAt: '',
});

let reloadTimer: number | null = null;

export function openSyncLogDrawer(): void {
  syncLogState.open = true;
  void refreshSyncLog();
}

export function closeSyncLogDrawer(): void {
  syncLogState.open = false;
}

export function setSyncLogMode(mode: SyncLogMode): void {
  syncLogState.mode = mode;
  try {
    localStorage.setItem('syncLogMode', mode);
  } catch { /* 存不了偏好不影响使用 */ }
}

export function toggleSyncLogMode(): void {
  setSyncLogMode(syncLogState.mode === 'full' ? 'dock' : 'full');
}

export function toggleSyncLogEntry(id: number): void {
  const index = syncLogState.expanded.indexOf(id);
  if (index >= 0) syncLogState.expanded.splice(index, 1);
  else syncLogState.expanded.push(id);
}

export function isSyncLogExpanded(id: number): boolean {
  return syncLogState.expanded.includes(id);
}

function queryParams(extra: Record<string, string | number> = {}): Record<string, string | number> {
  const params: Record<string, string | number> = { limit: PAGE_SIZE, ...extra };
  if (syncLogState.outcome !== 'all') params.outcome = syncLogState.outcome;
  if (syncLogState.content !== 'all') params.content = syncLogState.content;
  if (syncLogState.peer) params.peer = syncLogState.peer;
  if (syncLogState.query.trim()) params.q = syncLogState.query.trim();
  return params;
}

/**
 * 手机端兜底：Android 本地 /api/sync/log 由 Kotlin 实现，暂时没有 outcome / contents 字段，
 * 也不认「结果」「内容」两个筛选参数。检测到这种情况就把整段日志取回来，在前端按同一套口径
 * 分类、筛选与计数，保证抽屉在桌面 / Docker / 手机三端表现一致。桌面端走不到这里。
 */
async function withFallbackFilters(page: SyncLogPage): Promise<SyncLogPage> {
  if (page.summary?.byOutcome) return page;
  const wideLimit = Math.max(Number(page.summary?.maxEntries || 0), PAGE_SIZE);
  const params: Record<string, string | number> = { limit: wideLimit };
  if (syncLogState.query.trim()) params.q = syncLogState.query.trim();
  const { data } = await api.get('/api/sync/log', { params });
  const wide = data as SyncLogPage;
  const all = wide.entries || [];
  const matched = all.filter((entry) => {
    if (syncLogState.outcome !== 'all' && entryOutcome(entry) !== syncLogState.outcome) return false;
    if (syncLogState.content !== 'all' && !entryContents(entry).includes(syncLogState.content)) return false;
    if (syncLogState.peer && entry.peer !== syncLogState.peer) return false;
    return true;
  });
  const byOutcome: Record<SyncLogOutcome, number> = { changed: 0, none: 0, failed: 0 };
  const byContent: Partial<Record<SyncLogContent, number>> = {};
  for (const entry of all) {
    byOutcome[entryOutcome(entry)] += 1;
    for (const type of entryContents(entry)) byContent[type] = Number(byContent[type] || 0) + 1;
  }
  return {
    ...wide,
    entries: matched.slice(0, PAGE_SIZE),
    total: matched.length,
    hasMore: matched.length > PAGE_SIZE,
    summary: wide.summary ? { ...wide.summary, byOutcome, byContent } : wide.summary,
  };
}

/** 拉第一页（筛选变化、手动刷新、自动刷新、打开抽屉都走这里） */
export async function refreshSyncLog(): Promise<void> {
  if (syncLogState.loading) return;
  syncLogState.loading = true;
  try {
    const { data } = await api.get('/api/sync/log', { params: queryParams() });
    const page = await withFallbackFilters(data as SyncLogPage);
    syncLogState.entries = page.entries || [];
    syncLogState.total = Number(page.total || 0);
    syncLogState.hasMore = Boolean(page.hasMore);
    syncLogState.summary = page.summary || null;
    syncLogState.status = page.status || null;
    syncLogState.error = '';
    syncLogState.lastLoadedAt = new Date().toISOString();
    // 已被筛选/翻页挤出的条目不再保留展开状态，避免 expanded 无限增长
    const ids = new Set((page.entries || []).map((item) => item.id));
    syncLogState.expanded = syncLogState.expanded.filter((id) => ids.has(id));
  } catch (error: any) {
    syncLogState.error = error?.response?.data?.error || '同步日志读取失败';
  } finally {
    syncLogState.loading = false;
  }
}

/** 向前翻页：取比当前最旧一条更早的记录 */
export async function loadOlderSyncLog(): Promise<void> {
  const oldest = syncLogState.entries[syncLogState.entries.length - 1];
  if (!oldest || syncLogState.loadingMore || !syncLogState.hasMore) return;
  syncLogState.loadingMore = true;
  try {
    const { data } = await api.get('/api/sync/log', { params: queryParams({ before: oldest.id }) });
    const page = data as SyncLogPage;
    const known = new Set(syncLogState.entries.map((item) => item.id));
    syncLogState.entries.push(...(page.entries || []).filter((item) => !known.has(item.id)));
    syncLogState.hasMore = Boolean(page.hasMore);
    if (page.summary) syncLogState.summary = page.summary;
    if (page.status) syncLogState.status = page.status;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '加载更早的记录失败');
  } finally {
    syncLogState.loadingMore = false;
  }
}

/** 筛选条件变化：去抖后重拉（搜索框每敲一个字不该打一次接口） */
export function scheduleSyncLogReload(delay = 250): void {
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null;
    void refreshSyncLog();
  }, delay);
}

export function resetSyncLogFilters(): void {
  syncLogState.outcome = 'all';
  syncLogState.content = 'all';
  syncLogState.peer = '';
  syncLogState.query = '';
  void refreshSyncLog();
}

export function toggleSyncLogAutoRefresh(): void {
  syncLogState.autoRefresh = !syncLogState.autoRefresh;
  try {
    localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, syncLogState.autoRefresh ? '1' : '0');
  } catch { /* 存不了偏好不影响使用 */ }
}

function downloadTextFile(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出当前筛选下的全部记录（上限 = 服务端保留条数，默认 2000） */
export async function exportSyncLog(format: 'json' | 'md'): Promise<void> {
  try {
    const limit = Math.max(syncLogState.summary?.maxEntries || 2000, PAGE_SIZE);
    const { data } = await api.get('/api/sync/log', { params: queryParams({ limit }) });
    const page = data as SyncLogPage;
    const entries = page.entries || [];
    if (!entries.length) {
      notify.info('当前筛选条件下没有记录可导出');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filters = {
      outcome: syncLogState.outcome === 'all' ? '全部' : OUTCOME_LABELS[syncLogState.outcome],
      content: syncLogState.content === 'all' ? '全部' : syncLogState.content,
      peer: syncLogState.peer || '全部',
      q: syncLogState.query.trim() || '',
    };
    if (format === 'json') {
      downloadTextFile(`engram-sync-log-${stamp}.json`, buildSyncLogJson(entries, { filters }), 'application/json');
    } else {
      downloadTextFile(`engram-sync-log-${stamp}.md`, buildSyncLogMarkdown(entries, { ...filters }), 'text/markdown;charset=utf-8');
    }
    notify.success(`已导出 ${entries.length} 条记录`);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '导出失败');
  }
}

/** 清空日志（内存与磁盘一起清）；调用方负责先确认 */
export async function clearSyncLog(): Promise<boolean> {
  try {
    const { data } = await api.delete('/api/sync/log');
    notify.success(data?.cleared ? `已清空 ${data.cleared} 条同步日志` : '同步日志已清空');
    await refreshSyncLog();
    return true;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '清空失败');
    return false;
  }
}
