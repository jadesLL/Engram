<template>
  <Teleport to="body">
    <!-- 与内置 Agent 卡片、图片资产卡片同一形态：右侧悬浮玻璃卡片，无遮罩、正文照常可用；
         需要整屏看长日志时切「满窗」铺满窗口。v-if 挂在 transition 的子节点上，否则动画不播。 -->
    <transition name="sync-log-slide">
      <aside
        v-if="state.open"
        class="sync-log-drawer"
        :class="{ 'is-full': isFull }"
        :style="isFull ? undefined : { right: `${cardRight}px` }"
        role="dialog"
        aria-label="同步详情"
      >
        <header class="log-head">
          <div class="log-crumb">
            <span>设置</span>
            <span class="sep">›</span>
            <span>多端同步</span>
            <span class="sep">›</span>
            <span class="cur">同步详情</span>
          </div>
          <div class="log-title">
            <h3>同步详情</h3>
            <span class="state-pill" :class="stateTone">{{ stateText }}</span>
            <span class="spacer" />
            <button
              class="icon-btn"
              type="button"
              :title="isFull ? '收回右侧卡片' : '铺满窗口'"
              :aria-label="isFull ? '收回右侧卡片' : '铺满窗口'"
              @click="toggleSyncLogMode"
            >
              <Icon :name="isFull ? 'minimize' : 'maximize'" :size="15" />
            </button>
            <button class="icon-btn" type="button" title="关闭（Esc）" aria-label="关闭" @click="closeSyncLogDrawer">
              <Icon name="x" :size="16" />
            </button>
          </div>

          <!-- 概览：一眼看出「连没连上、还差多少、最近一次是什么时候」 -->
          <div class="log-stats">
            <div v-for="card in statCards" :key="card.label" class="stat" :class="card.tone">
              <span>{{ card.label }}</span>
              <strong :title="card.hint || ''">{{ card.value }}</strong>
              <em v-if="card.hint">{{ card.hint }}</em>
            </div>
          </div>

          <p v-if="state.status?.lastError" class="log-error">
            <Icon name="alert" :size="13" />
            <span>最近错误：{{ state.status.lastError }}</span>
          </p>

          <div class="log-filters">
            <div class="chip-row" role="group" aria-label="按级别筛选">
              <button
                v-for="chip in levelChips"
                :key="chip.key"
                class="chip"
                :class="{ on: state.level === chip.key, warn: chip.key === 'warn', error: chip.key === 'error' }"
                type="button"
                @click="setLevel(chip.key)"
              >
                {{ chip.label }}<span v-if="chip.count !== null" class="cnt">{{ chip.count }}</span>
              </button>
            </div>
            <div class="chip-row" role="group" aria-label="按视角筛选">
              <button
                v-for="chip in scopeChips"
                :key="chip.key"
                class="chip"
                :class="{ on: state.scope === chip.key }"
                type="button"
                @click="setScope(chip.key)"
              >
                {{ chip.label }}
              </button>
            </div>
            <div class="filter-row">
              <label class="select-host">
                <Icon name="activity" :size="13" />
                <select v-model="state.event" aria-label="按事件筛选" @change="reload">
                  <option value="">全部事件</option>
                  <optgroup v-for="group in eventGroups" :key="group.category" :label="group.category">
                    <option v-for="item in group.items" :key="item.event" :value="item.event">
                      {{ item.label }}<template v-if="item.count">（{{ item.count }}）</template>
                    </option>
                  </optgroup>
                </select>
              </label>
              <label class="search-host">
                <Icon name="search" :size="13" />
                <input
                  v-model="state.query"
                  type="search"
                  placeholder="搜索说明 / 路径 / 成员"
                  spellcheck="false"
                  @input="scheduleSyncLogReload()"
                />
              </label>
              <button class="chip action" type="button" :class="{ on: !state.autoRefresh }" @click="toggleSyncLogAutoRefresh">
                {{ state.autoRefresh ? '自动刷新：开' : '自动刷新：暂停' }}
              </button>
              <button class="chip action" type="button" :disabled="state.loading" @click="refreshSyncLog">
                <Icon name="refresh" :size="12" />{{ state.loading ? '刷新中' : '刷新' }}
              </button>
              <div class="menu-host">
                <button class="chip action" type="button">
                  <Icon name="download" :size="12" />导出
                </button>
                <div class="menu">
                  <button type="button" @click="exportSyncLog('json')">导出 JSON（含结构化字段）</button>
                  <button type="button" @click="exportSyncLog('md')">导出 Markdown（表格 + 字段）</button>
                </div>
              </div>
              <button class="chip action danger" type="button" @click="askClear">清空日志</button>
            </div>
            <p v-if="filterSummary" class="filter-hint">{{ filterSummary }}</p>
          </div>
        </header>

        <div class="log-body">
          <p v-if="syncingNow" class="log-hint live">
            同步进行中：{{ state.status?.syncProgress || '正在处理' }}；下面会逐条出现刚落地的改动。
          </p>
          <p v-if="state.status && state.status.role === 'none'" class="log-hint">
            本机还没有参与同步群组：先在设置里把它设为中枢，或绑定到已有的中枢，之后这里会记录每一次推送、拉取与对账。
          </p>
          <p v-else-if="state.loading && !state.entries.length" class="log-hint">正在读取同步日志…</p>
          <p v-else-if="state.error" class="log-hint error">{{ state.error }}</p>
          <AppEmptyState
            v-else-if="!state.entries.length"
            icon="activity"
            title="还没有同步记录"
            :hint="emptyHint"
          />
          <ul v-else class="log-list">
            <li v-for="entry in state.entries" :key="entry.id" class="log-item" :class="entry.level">
              <button class="log-row" type="button" :aria-expanded="isSyncLogExpanded(entry.id)" @click="toggleSyncLogEntry(entry.id)">
                <span class="ts" :title="formatLogTime(entry.ts)">{{ formatLogClock(entry.ts) }}</span>
                <span class="lvl">{{ levelText(entry.level) }}</span>
                <span v-if="entry.scope" class="scope" :class="entry.scope">{{ SCOPE_LABELS[entry.scope] }}</span>
                <span class="ev">{{ eventLabel(entry.event) }}</span>
                <span v-if="entry.peer" class="peer">{{ entry.peer }}</span>
                <span class="detail">{{ entry.detail || '—' }}</span>
                <Icon class="caret" :class="{ open: isSyncLogExpanded(entry.id) }" name="chevron-down" :size="13" />
              </button>
              <div v-if="isSyncLogExpanded(entry.id)" class="log-data">
                <div class="data-grid">
                  <template v-for="item in dataEntries(entry)" :key="item.key">
                    <span class="dk">{{ item.label }}</span>
                    <span class="dv">{{ item.value }}</span>
                  </template>
                  <span class="dk">完整时间</span>
                  <span class="dv">{{ formatLogTime(entry.ts) }}</span>
                  <span class="dk">事件 ID</span>
                  <span class="dv">{{ entry.event }}（#{{ entry.id }}）</span>
                </div>
                <button class="chip action" type="button" @click="copyEntry(entry)">
                  <Icon name="copy" :size="12" />复制这条记录
                </button>
              </div>
            </li>
          </ul>
          <div v-if="state.entries.length && state.hasMore" class="load-more">
            <button class="chip action" type="button" :disabled="state.loadingMore" @click="loadOlderSyncLog">
              {{ state.loadingMore ? '加载中…' : `加载更早的记录（已显示 ${state.entries.length} / ${state.total}）` }}
            </button>
          </div>
        </div>

        <footer class="log-foot">
          <Icon name="activity" :size="13" />
          <span>
            日志保存在数据目录的 <code>logs/sync.jsonl</code>，保留最近 {{ state.summary?.maxEntries || 2000 }} 条 /
            {{ state.summary?.retentionDays || 7 }} 天（重启后仍可回看）；{{ refreshHint }}
          </span>
        </footer>
      </aside>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import { useAppStore } from '../stores/app';
import {
  SCOPE_LABELS,
  SYNC_EVENT_META,
  clearSyncLog,
  closeSyncLogDrawer,
  dataLabel,
  eventLabel,
  exportSyncLog,
  formatDataValue,
  formatLogClock,
  formatLogTime,
  formatRelative,
  isSyncLogExpanded,
  loadOlderSyncLog,
  refreshSyncLog,
  scheduleSyncLogReload,
  syncLogState as state,
  toggleSyncLogAutoRefresh,
  toggleSyncLogEntry,
  toggleSyncLogMode,
  type SyncEventCategory,
  type SyncLogEntry,
  type SyncLogLevel,
  type SyncLogScope,
} from '../lib/syncLog';

/**
 * 同步详情抽屉（独立窗口）：设置页的「查看同步详情」打开它。
 *
 * 旧版把运行状态网格 + 一个 260px 高的可展开日志塞在设置卡片里：
 * 日志只有最近 30 条、没有级别/成员/时间信息，设置页还被撑得很长。
 * 现在详情独立成一张卡片（可选满窗），支持按级别/视角/事件/关键词筛选、翻页、导出、清空。
 */

const app = useAppStore();
/** 空闲时 5 秒一跳；同步进行中收到 2 秒——用户正盯着「这轮又改了什么」，5 秒太钝 */
const AUTO_REFRESH_MS = 5000;
const AUTO_REFRESH_BUSY_MS = 2000;
let refreshTimer: number | null = null;

/** 同步正在跑（含等待补拉的文件）：抽屉与状态行都按「实时」口径展示 */
const syncingNow = computed(() => Boolean(state.status?.syncing || state.status?.reconciling || state.status?.pendingPulls));

const isFull = computed(() => state.mode === 'full');

/** 与图片资产卡片同一套避让：内置 Agent 悬浮在右侧时，本卡片让开它的宽度 */
const viewportWidth = ref(window.innerWidth);
const cardRight = computed(() => {
  const docked = app.chatDrawerOpen && app.chatDrawerMode === 'dock' && viewportWidth.value > 1024;
  if (!docked) return 8;
  const offset = app.chatDockWidth + 8;
  return viewportWidth.value - offset < 560 ? 8 : offset + 8;
});

function onViewportResize(): void {
  viewportWidth.value = window.innerWidth;
}

/** Esc：满窗先收回右侧卡片，再按一次才关闭（和 Agent 卡片同一手感） */
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  if (!state.open) return;
  if (isFull.value) toggleSyncLogMode();
  else closeSyncLogDrawer();
}

function startAutoRefresh(): void {
  stopAutoRefresh();
  if (!state.autoRefresh) return;
  scheduleAutoRefresh();
}

/** 自排下一拍：同步中比空闲跳得更勤（单一计时器，节奏随状态变） */
function scheduleAutoRefresh(): void {
  if (!state.autoRefresh || !state.open) return;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null;
    if (!state.open || !state.autoRefresh) return;
    if (!state.loading) await refreshSyncLog();
    scheduleAutoRefresh();
  }, syncingNow.value ? AUTO_REFRESH_BUSY_MS : AUTO_REFRESH_MS);
}

function stopAutoRefresh(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

watch(() => state.open, (open) => {
  if (open) {
    startAutoRefresh();
    void refreshSyncLog();
  } else {
    stopAutoRefresh();
  }
});

watch(() => state.autoRefresh, () => {
  if (state.open) startAutoRefresh();
});

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onViewportResize);
  if (state.open) {
    startAutoRefresh();
    void refreshSyncLog();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onViewportResize);
  stopAutoRefresh();
});

function reload(): void {
  void refreshSyncLog();
}

function setLevel(level: SyncLogLevel | 'all'): void {
  state.level = level;
  reload();
}

function setScope(scope: SyncLogScope | 'all'): void {
  state.scope = scope;
  reload();
}

/** 顶部状态：与设置页摘要同一口径，避免两处说法不一致 */
const stateText = computed(() => {
  const status = state.status;
  if (!status) return '读取中…';
  if (status.role === 'none') return '未参与同步';
  const peers = status.peers || [];
  if (status.role === 'hub') {
    const online = peers.filter((peer) => peer.online).length;
    return `中枢运行中 · ${online}/${peers.length} 成员在线`;
  }
  // 把「正在做什么」写进状态行：首次全量对账可能跑上几分钟，只写「同步中」等于没说
  if (status.reconciling) return status.syncProgress ? `全量对账中 · ${status.syncProgress}` : '全量对账中';
  if (!status.connected) return '未连接中枢';
  if (status.syncing) return status.syncProgress ? `已连接 · 同步中：${status.syncProgress}` : '已连接 · 同步中';
  return '已连接';
});

const stateTone = computed<'ok' | 'warn' | 'bad'>(() => {
  const status = state.status;
  if (!status || status.role === 'none') return 'warn';
  if (status.role === 'hub') return 'ok';
  if (status.reconciling) return 'warn';
  return status.connected ? 'ok' : 'bad';
});

interface StatCard {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}

const statCards = computed<StatCard[]>(() => {
  const status = state.status;
  const summary = state.summary;
  if (!status) return [];
  const cards: StatCard[] = [];
  if (status.role === 'member') {
    cards.push({ label: '待推送', value: String(status.pending), hint: status.pending ? '本地改动排队中' : '已全部推送' });
    cards.push({ label: '待补拉文件', value: String(status.pendingPulls), hint: status.pendingPulls ? '每分钟自动重试' : '无' });
    cards.push({ label: '同步水位', value: String(status.cursor) });
    cards.push({ label: '中枢', value: status.hubUrl || '—' });
  } else if (status.role === 'hub') {
    const peers = status.peers || [];
    const online = peers.filter((peer) => peer.online).length;
    cards.push({ label: '成员', value: `${online} / ${peers.length}`, hint: '在线 / 总数' });
    // 中枢端 cursor 恒为 0（那是成员端的水位），权威发号看 revision
    cards.push({ label: '权威水位', value: String(status.revision ?? status.cursor), hint: '本机 revision 序号' });
    cards.push({ label: '成员绑定地址', value: status.hubUrl || window.location.origin });
  }
  cards.push(
    status.role === 'hub'
      // 中枢不主动连别人（成员连它），没有「最近同步」这种客户端概念：用最近一条记录的
      // 时间当「最近活动」，否则中枢上永远挂着一行「还没有成功同步过」，与在线成员矛盾
      ? {
        label: '最近活动',
        value: summary?.newest ? formatRelative(summary.newest) : '—',
        hint: summary?.newest ? formatLogTime(summary.newest) : '暂无同步记录',
      }
      : {
        label: '最近同步',
        value: status.lastSyncAt ? formatRelative(status.lastSyncAt) : '—',
        hint: status.lastSyncAt ? formatLogTime(status.lastSyncAt) : '还没有成功同步过',
        tone: status.lastSyncAt ? '' : 'warn',
      },
  );
  cards.push({
    label: '保留记录',
    value: `${summary?.total ?? 0} 条`,
    hint: summary?.oldest ? `最早 ${formatRelative(summary.oldest)}` : '暂无记录',
  });
  if (summary && (summary.byLevel.warn || summary.byLevel.error)) {
    cards.push({
      label: '待处理',
      value: `${summary.byLevel.warn} 警告 / ${summary.byLevel.error} 错误`,
      tone: summary.byLevel.error ? 'bad' : 'warn',
      hint: '点上方「警告 / 错误」筛选查看',
    });
  }
  return cards;
});

const levelChips = computed(() => {
  const byLevel = state.summary?.byLevel;
  return [
    { key: 'all' as const, label: '全部', count: state.summary ? state.summary.total : null },
    { key: 'info' as const, label: '信息', count: byLevel ? byLevel.info : null },
    { key: 'warn' as const, label: '警告', count: byLevel ? byLevel.warn : null },
    { key: 'error' as const, label: '错误', count: byLevel ? byLevel.error : null },
  ];
});

const scopeChips = computed(() => {
  const byScope = state.summary?.byScope;
  return [
    { key: 'all' as const, label: '全部视角' },
    { key: 'hub' as const, label: `中枢${byScope ? ` ${byScope.hub}` : ''}` },
    { key: 'member' as const, label: `成员${byScope ? ` ${byScope.member}` : ''}` },
    { key: 'app' as const, label: `配置${byScope ? ` ${byScope.app}` : ''}` },
  ];
});

/** 事件下拉按分类分组：先按「我想看哪类事」缩小范围，再挑具体事件 */
const eventGroups = computed(() => {
  const counts = new Map((state.summary?.byEvent || []).map((item) => [item.event, item.count]));
  const groups = new Map<SyncEventCategory, { event: string; label: string; count: number }[]>();
  for (const [event, meta] of Object.entries(SYNC_EVENT_META)) {
    const list = groups.get(meta.category) || [];
    list.push({ event, label: meta.label, count: counts.get(event) || 0 });
    groups.set(meta.category, list);
  }
  return [...groups.entries()].map(([category, items]) => ({
    category,
    items: items.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN')),
  }));
});

const filterSummary = computed(() => {
  const parts: string[] = [];
  if (state.level !== 'all') parts.push(`级别=${levelText(state.level)}`);
  if (state.scope !== 'all') parts.push(`视角=${SCOPE_LABELS[state.scope]}`);
  if (state.event) parts.push(`事件=${eventLabel(state.event)}`);
  if (state.query.trim()) parts.push(`关键词=“${state.query.trim()}”`);
  if (!parts.length) return '';
  return `当前筛选：${parts.join(' · ')}，命中 ${state.total} 条${state.hasMore ? '（可继续加载更早的记录）' : ''}`;
});

const emptyHint = computed(() => {
  if (state.summary && state.summary.total > 0) return '换个筛选条件或清空关键词再看看。';
  return '同步有动作时（推送、拉取、对账、成员上下线）这里会逐条记下来。';
});

const refreshHint = computed(() => {
  const base = state.lastLoadedAt ? `上次读取 ${formatRelative(state.lastLoadedAt)}` : '';
  const mode = state.autoRefresh
    ? (syncingNow.value ? '同步中每 2 秒自动刷新' : '每 5 秒自动刷新')
    : '自动刷新已暂停';
  return [base, mode].filter(Boolean).join(' · ');
});

function levelText(level: SyncLogLevel): string {
  return level === 'error' ? '错误' : level === 'warn' ? '警告' : '信息';
}

function dataEntries(entry: SyncLogEntry): { key: string; label: string; value: string }[] {
  if (!entry.data) return [];
  return Object.entries(entry.data)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({ key, label: dataLabel(key), value: formatDataValue(key, value) }));
}

async function copyEntry(entry: SyncLogEntry): Promise<void> {
  const lines = [
    `[${formatLogTime(entry.ts)}] ${entry.level.toUpperCase()} ${entry.event}${entry.scope ? ` (${entry.scope})` : ''}${entry.peer ? ` @${entry.peer}` : ''}`,
    entry.detail || '',
    entry.data ? JSON.stringify(entry.data, null, 2) : '',
  ].filter(Boolean);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    notify.success('已复制这条记录');
  } catch {
    notify.error('复制失败，请手动选择复制');
  }
}

async function askClear(): Promise<void> {
  const ok = await confirmDialog({
    title: '清空同步日志',
    message: `将删除本机保存的全部同步记录（共 ${state.summary?.total ?? 0} 条，含磁盘上的 logs/sync.jsonl）。同步本身不受影响，但之后无法回看历史。继续？`,
    confirmText: '清空',
  });
  if (!ok) return;
  await clearSyncLog();
}
</script>

<style scoped>
/*
 * 悬浮玻璃卡片（UI 2.0 语言）：四周留 8px 露出窗口底色，与 Agent 卡片、图片资产卡片同材质。
 * 没有遮罩：卡片浮在正文之上，用户边看日志边操作页面。
 * 顶部避开桌面壳的原生标题栏（--win-titlebar-h 只在 desktop-frame 下有值）。
 */
.sync-log-drawer {
  position: fixed;
  top: calc(8px + var(--win-titlebar-h, 0px));
  bottom: 8px;
  right: 8px;
  z-index: var(--z-chrome);
  width: min(760px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sidebar-glass-border);
  border-radius: 8px;
  background: var(--sidebar-material);
  box-shadow: var(--sidebar-glass-shadow);
  backdrop-filter: saturate(150%) blur(28px);
  -webkit-backdrop-filter: saturate(150%) blur(28px);
}

/* 满窗：铺满窗口（仅保留一圈 8px 边与桌面壳标题栏让位） */
.sync-log-drawer.is-full {
  left: 8px;
  width: auto;
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .sync-log-drawer { background: var(--sidebar-material-solid); }
}

/* 开合动画：与 Agent / 图片资产卡片同一套节奏（右缘滑入 + 轻微缩放 + 淡入，160ms） */
.sync-log-slide-enter-active,
.sync-log-slide-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}
.sync-log-slide-enter-from,
.sync-log-slide-leave-to {
  opacity: 0;
  transform: translateX(14px) scale(0.985);
}
@media (prefers-reduced-motion: reduce) {
  .sync-log-slide-enter-active,
  .sync-log-slide-leave-active { transition-duration: 0.01ms; }
}

.log-head {
  flex-shrink: 0;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--border);
}

.log-crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  min-width: 0;
}
.log-crumb .sep { opacity: 0.6; }
.log-crumb .cur { color: var(--text-secondary); }

.log-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-title h3 { margin: 0; font-size: 14px; font-weight: 650; }
.log-title .spacer { flex: 1; }

.state-pill {
  height: 20px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.state-pill.ok { background: var(--success-soft, rgba(46, 158, 91, 0.14)); color: var(--success, #2e9e5b); }
.state-pill.warn { background: var(--warn-soft, rgba(216, 160, 18, 0.16)); color: var(--warn, #b8860b); }
.state-pill.bad { background: var(--danger-soft, rgba(214, 69, 69, 0.14)); color: var(--danger, #d64545); }

.icon-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-secondary);
}
.icon-btn:hover { color: var(--text); background: var(--bg-hover); }

.log-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  min-width: 0;
}
.stat span { color: var(--text-faint); font-size: 10.5px; }
.stat strong {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat em {
  color: var(--text-faint);
  font-size: 10.5px;
  font-style: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat.warn strong { color: var(--warn, #b8860b); }
.stat.bad strong { color: var(--danger, #d64545); }

.log-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 10px 0 0;
  padding: 7px 9px;
  border-radius: var(--radius);
  border-left: 3px solid var(--danger, #d64545);
  background: var(--danger-soft, rgba(214, 69, 69, 0.1));
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.55;
  word-break: break-all;
}
.log-error > svg { flex-shrink: 0; margin-top: 2px; color: var(--danger, #d64545); }

.log-filters {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.chip-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  height: 25px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 20px;
  font-size: 11.5px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
}
.chip:hover { background: var(--bg-tertiary); }
.chip.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
  font-weight: 600;
}
.chip .cnt { opacity: 0.75; font-size: 10.5px; }
.chip.action { height: 26px; }
.chip.action:disabled { opacity: 0.6; cursor: default; }
.chip.danger:hover { background: var(--danger-soft); color: var(--danger); border-color: transparent; }

.filter-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.select-host,
.search-host {
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-faint);
  background: var(--card-bg);
}
.select-host select,
.search-host input {
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 11.5px;
  outline: none;
  min-width: 0;
}
.search-host { flex: 1; min-width: 150px; }
.search-host input { width: 100%; }

/* 导出菜单：默认收起，hover / 聚焦时展开（不引入额外的浮层组件） */
.menu-host { position: relative; }
.menu-host .menu {
  position: absolute;
  right: 0;
  top: 30px;
  z-index: 2;
  display: none;
  flex-direction: column;
  min-width: 214px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
}
.menu-host:hover .menu,
.menu-host:focus-within .menu { display: flex; }
.menu button {
  text-align: left;
  padding: 7px 9px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.menu button:hover { background: var(--bg-tertiary); color: var(--text); }

.filter-hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.log-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 16px;
}

.log-hint { margin: 8px 0; color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }
.log-hint.error { color: var(--danger); }
/* 同步进行中的实时提示：不是错误也不是空状态，用品牌色点一下存在感 */
.log-hint.live { color: var(--accent, var(--brand, var(--text-faint))); }

.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-item {
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-secondary);
}
.log-item.warn { border-color: rgba(216, 160, 18, 0.35); }
.log-item.error { border-color: rgba(214, 69, 69, 0.35); }

.log-row {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 9px;
  text-align: left;
  font-size: 11.5px;
  color: var(--text-secondary);
  border-radius: 6px;
  flex-wrap: wrap;
}
.log-row:hover { background: var(--bg-hover); }
.log-row .ts {
  font-family: var(--font-mono, Consolas, monospace);
  color: var(--text-faint);
  white-space: nowrap;
}
.log-row .lvl {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10.5px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.log-item.warn .lvl { background: rgba(216, 160, 18, 0.16); color: var(--warn, #b8860b); }
.log-item.error .lvl { background: rgba(214, 69, 69, 0.14); color: var(--danger, #d64545); }
.log-row .scope {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10.5px;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
}
.log-row .scope.hub { color: var(--accent); border-color: var(--accent-soft); }
.log-row .ev {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.log-row .peer {
  flex-shrink: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
.log-row .detail {
  flex: 1;
  min-width: 160px;
  word-break: break-word;
  line-height: 1.6;
}
.log-row .caret {
  flex-shrink: 0;
  align-self: center;
  color: var(--text-faint);
  transition: transform 140ms ease;
}
.log-row .caret.open { transform: rotate(180deg); }

.log-data {
  padding: 4px 9px 10px 9px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.data-grid {
  display: grid;
  grid-template-columns: minmax(90px, max-content) 1fr;
  gap: 3px 10px;
  font-size: 11.5px;
}
.data-grid .dk { color: var(--text-faint); }
.data-grid .dv {
  color: var(--text-secondary);
  word-break: break-all;
  font-family: var(--font-mono, Consolas, monospace);
  /* 条目清单 / 路径清单按行展示（结构化字段里是多行文本） */
  white-space: pre-wrap;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 12px 0 2px;
}

.log-foot {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 9px 16px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
.log-foot code {
  font-family: var(--font-mono, Consolas, monospace);
  color: var(--text-secondary);
}
.log-foot > svg { flex-shrink: 0; margin-top: 2px; }

/* 手机端：卡片仍是浮层，底部导航是 48px 常驻胶囊，卡片要抬到它上面 */
@media (max-width: 768px) {
  .sync-log-drawer { bottom: calc(64px + env(safe-area-inset-bottom)); }
  .log-stats { grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); }
}
</style>
