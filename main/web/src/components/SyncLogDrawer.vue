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

          <!-- 概览：一眼看出「改了多少、对账多少次、有没有要处理的」 -->
          <div class="log-stats">
            <div v-for="card in statCards" :key="card.label" class="stat" :class="card.tone">
              <span>{{ card.label }}</span>
              <strong :title="card.value">{{ card.value }}</strong>
              <em v-if="card.hint">{{ card.hint }}</em>
            </div>
          </div>

          <p v-if="state.status?.lastError" class="log-error">
            <Icon name="alert" :size="13" />
            <span>最近错误：{{ state.status.lastError }}</span>
          </p>

          <div class="log-filters">
            <!-- 第一排：这条记录到底干了什么（用户唯一必须先看懂的一层） -->
            <div class="chip-row" role="group" aria-label="按结果筛选">
              <span class="chip-label">结果</span>
              <button
                v-for="chip in outcomeChips"
                :key="chip.key"
                class="chip"
                :class="[{ on: state.outcome === chip.key }, `out-${chip.key}`]"
                type="button"
                :title="chip.hint"
                @click="setOutcome(chip.key)"
              >
                {{ chip.label }}<span v-if="chip.count !== null" class="cnt">{{ chip.count }}</span>
              </button>
            </div>
            <!-- 第二排：有改动的那几条，动的是哪类内容（没改动/失败没有内容可筛，置灰） -->
            <div class="chip-row" role="group" aria-label="按内容类型筛选">
              <span class="chip-label">改了哪类</span>
              <button
                v-for="chip in contentChips"
                :key="chip.key"
                class="chip"
                :class="[{ on: state.content === chip.key, dim: contentDisabled }, `type-${chip.tone}`]"
                type="button"
                :disabled="contentDisabled"
                @click="setContent(chip.key)"
              >
                {{ chip.label }}<span v-if="chip.count !== null" class="cnt">{{ chip.count }}</span>
              </button>
            </div>
            <div class="filter-row">
              <label class="search-host">
                <Icon name="search" :size="13" />
                <input
                  v-model="state.query"
                  type="search"
                  placeholder="搜索标题 / 路径 / 成员 / 摘要"
                  spellcheck="false"
                  @input="scheduleSyncLogReload()"
                />
              </label>
              <label class="select-host">
                <Icon name="activity" :size="13" />
                <select v-model="state.peer" aria-label="按成员筛选" @change="reload">
                  <option value="">成员：全部</option>
                  <option v-for="name in peerOptions" :key="name" :value="name">{{ name }}</option>
                </select>
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
                  <button type="button" @click="exportSyncLog('md')">导出 Markdown（表格 + 改动）</button>
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
            <!-- 一条记录一行：时间 · 结果 · 事件 · 成员 · 一句话摘要 …… 内容类型 · N 处改动。
                 改动的正文一律收起来，点开这一行才铺开（带上下文的行级 diff + 全部字段）。 -->
            <li v-for="entry in state.entries" :key="entry.id" class="log-item" :class="entryOutcome(entry)">
              <button class="log-row" type="button" :aria-expanded="isSyncLogExpanded(entry.id)" @click="toggleSyncLogEntry(entry.id)">
                <span class="ts" :title="formatLogTime(entry.ts)">{{ formatLogClock(entry.ts) }}</span>
                <span class="badge" :class="entryOutcome(entry)">{{ entryOutcomeLabel(entry) }}</span>
                <span class="sum">
                  <span class="ev">{{ eventLabel(entry.event) }}</span>
                  <span v-if="entry.peer" class="peer">{{ entry.peer }}</span>
                  <span class="detail">{{ entry.detail || '—' }}</span>
                </span>
                <span v-if="entryContents(entry).length" class="tags">
                  <span v-for="type in entryContents(entry)" :key="type" class="tag" :data-type="type">
                    <i class="dot" />{{ type }}
                  </span>
                </span>
                <span v-if="changeCount(entry)" class="count">{{ changeCount(entry) }} 处改动</span>
                <Icon class="caret" :class="{ open: isSyncLogExpanded(entry.id) }" name="chevron-down" :size="13" />
              </button>

              <div v-if="isSyncLogExpanded(entry.id)" class="log-data">
                <template v-if="changeFiles(entry).length">
                  <div class="sec-title">
                    <span>这次改了什么（{{ changeFiles(entry).length }} 个文件{{ changeTypeSummary(entry) ? `：${changeTypeSummary(entry)}` : '' }}）</span>
                    <span class="rule" />
                  </div>
                  <div v-for="group in changeGroups(entry)" :key="group.type" class="group">
                    <div class="group-head">
                      <i class="dot" :data-type="group.type" />{{ group.type }}
                      <span class="n">{{ group.files.length }} 个文件</span>
                    </div>
                    <div v-for="(file, index) in group.files" :key="`${group.type}-${index}`" class="file">
                      <div class="file-path">{{ file.path || entry.detail || '（未标注文件）' }}</div>
                      <div class="diff">
                        <template v-for="(line, lineIndex) in file.lines" :key="lineIndex">
                          <div v-if="line.kind === 'hunk'" class="hunk-head">
                            <span class="hh">{{ hunkTitle(line) }}</span>
                            <span class="raw-head">{{ line.text }}</span>
                          </div>
                          <div v-else-if="line.kind === 'note'" class="dl note">
                            <span class="ln" /><span class="sign" /><span class="text">{{ line.text }}</span>
                          </div>
                          <div v-else class="dl" :class="line.kind">
                            <span class="ln">{{ line.lineNo ?? '' }}</span>
                            <span class="sign">{{ line.sign }}</span>
                            <span class="text">{{ line.text }}</span>
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                </template>

                <div class="sec-title"><span>全部同步信息</span><span class="rule" /></div>
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
                <div class="expand-actions">
                  <button class="chip action" type="button" @click="copyEntry(entry)">
                    <Icon name="copy" :size="12" />复制这条记录
                  </button>
                  <button class="chip action" type="button" @click="toggleRaw(entry.id)">
                    {{ rawOpen(entry.id) ? '收起原始记录' : '查看原始记录（JSON）' }}
                  </button>
                </div>
                <pre v-if="rawOpen(entry.id)" class="raw">{{ rawJson(entry) }}</pre>
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
  OUTCOME_HINTS,
  OUTCOME_LABELS,
  SYNC_LOG_CONTENTS,
  clearSyncLog,
  closeSyncLogDrawer,
  contentTypeOfPath,
  dataLabel,
  entryChangeLines,
  entryContents,
  entryOutcome,
  entryOutcomeLabel,
  eventLabel,
  exportSyncLog,
  formatDataValue,
  formatLogClock,
  formatLogTime,
  formatRelative,
  groupChangeFiles,
  hunkTitle,
  isSyncLogExpanded,
  loadOlderSyncLog,
  refreshSyncLog,
  scheduleSyncLogReload,
  syncLogState as state,
  toggleSyncLogAutoRefresh,
  toggleSyncLogEntry,
  toggleSyncLogMode,
  type SyncChangeFile,
  type SyncLogContent,
  type SyncLogEntry,
  type SyncLogOutcome,
} from '../lib/syncLog';

/**
 * 同步详情抽屉（独立窗口）：设置页的「查看同步详情」打开它。
 *
 * UI 2.0 的两层分类（用户反馈旧版「信息 / 警告 / 错误 + 全部视角 + 事件下拉」看不懂）：
 *  - 结果：有改动（同步成功且内容真的变了）/ 没改动（对账、检查、连接，跑完两边一致）/ 失败（警告 + 错误）；
 *  - 内容：有改动的那几条动的是哪类内容——原始资料 / 概念 / 实体 / 内置 Agent / 其他。
 * 列表一条记录一行，改动正文默认收起，点开才铺开「带上下各 5 行上下文的行级 diff」与全部结构化字段。
 * 筛选与分页都在服务端（分类由 server/sync/logClassify.ts 现算），前端只维护条件与已加载页。
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

function setOutcome(outcome: SyncLogOutcome | 'all'): void {
  state.outcome = outcome;
  // 没改动 / 失败这一类本来就没有内容类型，切过去时把内容筛选一起清掉，免得出现「筛了却一条都没有」
  if (outcome !== 'all' && outcome !== 'changed' && state.content !== 'all') state.content = 'all';
  reload();
}

function setContent(content: SyncLogContent | 'all'): void {
  if (contentDisabled.value) return;
  state.content = content;
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

/** 概览卡片：按新口径给数，不再摆「信息 / 警告 / 错误」 */
const statCards = computed<StatCard[]>(() => {
  const status = state.status;
  const summary = state.summary;
  if (!status) return [];
  const byOutcome = summary?.byOutcome;
  const byContent = summary?.byContent || {};
  const contentLine = SYNC_LOG_CONTENTS
    .map((type) => [type, Number(byContent[type] || 0)] as const)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count}`)
    .join(' · ');
  const cards: StatCard[] = [
    { label: '有改动', value: `${byOutcome?.changed ?? 0} 条`, hint: OUTCOME_HINTS.changed, tone: 'ok' },
    { label: '没改动（对账 / 检查）', value: `${byOutcome?.none ?? 0} 条`, hint: OUTCOME_HINTS.none },
    {
      label: '失败',
      value: `${byOutcome?.failed ?? 0} 条`,
      hint: OUTCOME_HINTS.failed,
      tone: (byOutcome?.failed ?? 0) > 0 ? 'bad' : '',
    },
    { label: '改了哪类内容', value: contentLine || '—', hint: '按文件归类，一条记录可能算多类' },
  ];
  if (status.role === 'member') {
    cards.push({ label: '待推送', value: String(status.pending), hint: status.pending ? '本地改动排队中' : '已全部推送' });
    cards.push({ label: '待补拉文件', value: String(status.pendingPulls), hint: status.pendingPulls ? '每分钟自动重试' : '无' });
  } else if (status.role === 'hub') {
    const peers = status.peers || [];
    const online = peers.filter((peer) => peer.online).length;
    cards.push({ label: '成员', value: `${online} / ${peers.length}`, hint: '在线 / 总数' });
  }
  cards.push({
    label: '最近活动',
    value: summary?.newest ? formatRelative(summary.newest) : '—',
    hint: summary?.newest ? formatLogTime(summary.newest) : '暂无同步记录',
  });
  return cards;
});

const outcomeChips = computed(() => {
  const byOutcome = state.summary?.byOutcome;
  return ([
    { key: 'all' as const, label: '全部', count: state.summary ? state.summary.total : null, hint: '所有记录' },
    { key: 'changed' as const, label: OUTCOME_LABELS.changed, count: byOutcome ? byOutcome.changed : null, hint: OUTCOME_HINTS.changed },
    { key: 'none' as const, label: OUTCOME_LABELS.none, count: byOutcome ? byOutcome.none : null, hint: OUTCOME_HINTS.none },
    { key: 'failed' as const, label: OUTCOME_LABELS.failed, count: byOutcome ? byOutcome.failed : null, hint: OUTCOME_HINTS.failed },
  ]);
});

const contentChips = computed(() => {
  const byContent = state.summary?.byContent || {};
  const total = SYNC_LOG_CONTENTS.reduce((sum, type) => sum + Number(byContent[type] || 0), 0);
  return [
    { key: 'all' as const, label: '全部内容', count: state.summary ? total : null, tone: 'all' },
    ...SYNC_LOG_CONTENTS.map((type) => ({ key: type, label: type, count: state.summary ? Number(byContent[type] || 0) : null, tone: contentTone(type) })),
  ];
});

/** 没改动 / 失败这两类记录不含内容改动，内容筛选对它们没意义 */
const contentDisabled = computed(() => state.outcome === 'none' || state.outcome === 'failed');

function contentTone(type: SyncLogContent): string {
  return ({ '原始资料': 'raw', '概念': 'concept', '实体': 'entity', '内置 Agent': 'agent', '其他': 'other' })[type] || 'other';
}

/** 成员下拉：中枢配置里的成员 + 已加载记录里出现过的名字（改过名/已移除的成员也要能筛） */
const peerOptions = computed(() => {
  const names = new Set<string>();
  for (const peer of state.status?.peers || []) if (peer.name) names.add(peer.name);
  for (const entry of state.entries) if (entry.peer) names.add(entry.peer);
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
});

const filterSummary = computed(() => {
  const parts: string[] = [];
  if (state.outcome !== 'all') parts.push(`结果=${OUTCOME_LABELS[state.outcome]}`);
  if (state.content !== 'all') parts.push(`内容=${state.content}`);
  if (state.peer) parts.push(`成员=${state.peer}`);
  if (state.query.trim()) parts.push(`关键词=“${state.query.trim()}”`);
  if (!parts.length) {
    return `共 ${state.total} 条记录；默认一条一行，点开才铺开改动正文（带上下文）与全部字段。`;
  }
  const suffix = contentDisabled.value ? '；这一类没有内容改动，内容分类不参与筛选' : '';
  return `当前筛选：${parts.join(' · ')}，命中 ${state.total} 条${state.hasMore ? '（可继续加载更早的记录）' : ''}${suffix}`;
});

const emptyHint = computed(() => {
  if (state.summary && state.summary.total > 0) return '换个结果 / 内容分类或清空关键词再看看。';
  return '同步有动作时（推送、拉取、对账、成员上下线）这里会逐条记下来。';
});

const refreshHint = computed(() => {
  const base = state.lastLoadedAt ? `上次读取 ${formatRelative(state.lastLoadedAt)}` : '';
  const mode = state.autoRefresh
    ? (syncingNow.value ? '同步中每 2 秒自动刷新' : '每 5 秒自动刷新')
    : '自动刷新已暂停';
  return [base, mode].filter(Boolean).join(' · ');
});

function dataEntries(entry: SyncLogEntry): { key: string; label: string; value: string }[] {
  if (!entry.data) return [];
  const rows: { key: string; label: string; value: string }[] = [
    // 结果 / 内容分类写在最前面：用户展开时先看到「这是什么、动了哪类东西」
    { key: 'outcome', label: '结果', value: `${entryOutcomeLabel(entry)}（${OUTCOME_HINTS[entryOutcome(entry)]}）` },
    { key: 'contents', label: '内容类型', value: entryContents(entry).join(' · ') || '—' },
  ];
  for (const [key, value] of Object.entries(entry.data)) {
    // 改动正文由上方按文件 + 改动块渲染（带 + / − 配色与上下文），不再在字段表里重复一遍
    if (key === 'changes') continue;
    if (value === null || value === undefined || value === '') continue;
    rows.push({ key, label: dataLabel(key), value: formatDataValue(key, value) });
  }
  return rows;
}

/** 这条记录改了哪些文件（从改动正文里按文件路径行切开） */
function changeFiles(entry: SyncLogEntry): SyncChangeFile[] {
  return groupChangeFiles(entryChangeLines(entry)).filter((file) => file.lines.length > 0);
}

/** 改了哪些文件 → 按内容类型分组（原始资料 / 概念 / 实体 / 内置 Agent / 其他） */
function changeGroups(entry: SyncLogEntry): { type: SyncLogContent; files: SyncChangeFile[] }[] {
  const groups = new Map<SyncLogContent, SyncChangeFile[]>();
  for (const file of changeFiles(entry)) {
    const type = contentTypeOfPath(file.path);
    const list = groups.get(type) || [];
    list.push(file);
    groups.set(type, list);
  }
  return SYNC_LOG_CONTENTS
    .filter((type) => groups.has(type))
    .map((type) => ({ type, files: groups.get(type) as SyncChangeFile[] }));
}

/** 「概念 1 · 实体 1」：展开标题里说明这条记录的改动分布（用条目自带的内容类型，最准） */
function changeTypeSummary(entry: SyncLogEntry): string {
  const types = entryContents(entry);
  if (types.length <= 1) return '';
  return types.map((type) => `${type}`).join(' · ');
}

/** 折叠态右侧的「N 处改动」：按文件数算，没有路径信息时退回 paths 数组长度 */
function changeCount(entry: SyncLogEntry): number {
  if (entryOutcome(entry) !== 'changed') return 0;
  const files = changeFiles(entry);
  if (files.length) return files.length;
  const paths = entry.data?.paths;
  return Array.isArray(paths) ? paths.length : 0;
}

const rawOpenIds = ref<number[]>([]);
function toggleRaw(id: number): void {
  const index = rawOpenIds.value.indexOf(id);
  if (index >= 0) rawOpenIds.value.splice(index, 1);
  else rawOpenIds.value.push(id);
}
function rawOpen(id: number): boolean {
  return rawOpenIds.value.includes(id);
}
function rawJson(entry: SyncLogEntry): string {
  return JSON.stringify(entry, null, 2);
}

async function copyEntry(entry: SyncLogEntry): Promise<void> {
  const changeLines = entryChangeLines(entry).map((line) => {
    if (line.kind === 'add' || line.kind === 'del') return `${line.sign}${line.lineNo ?? ''} ${line.text}`;
    if (line.kind === 'ctx') return ` ${line.lineNo ?? ''} ${line.text}`;
    return line.text;
  });
  const lines = [
    `[${formatLogTime(entry.ts)}] ${entryOutcomeLabel(entry)} ${entry.event}${entry.scope ? ` (${entry.scope})` : ''}${entry.peer ? ` @${entry.peer}` : ''}`,
    entryContents(entry).length ? `涉及内容：${entryContents(entry).join(' · ')}` : '',
    entry.detail || '',
    changeLines.length ? `改动内容：\n${changeLines.join('\n')}` : '',
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
  width: min(880px, calc(100vw - 16px));
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
.stat.ok strong { color: var(--success, #2e9e5b); }
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
  align-items: center;
}
.chip-label {
  flex-shrink: 0;
  min-width: 52px;
  color: var(--text-faint);
  font-size: 10.5px;
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
/* 结果三档各自上色：有改动=强调色、没改动=中性、失败=危险色（颜色永远配文字） */
.chip.on.out-changed { color: var(--accent); background: var(--accent-soft); }
.chip.on.out-none { color: var(--text-secondary); background: var(--bg-tertiary); }
.chip.on.out-failed { color: var(--danger, #d64545); background: var(--danger-soft, rgba(214, 69, 69, 0.12)); }
/* 内容类型：与列表里的标签同一套色，点到哪一类一眼看得出来 */
.chip.on.type-raw { color: var(--t-raw, #a86800); background: var(--t-raw-soft, rgba(168, 104, 0, 0.12)); }
.chip.on.type-concept { color: var(--t-concept, #6b4fa8); background: var(--t-concept-soft, rgba(107, 79, 168, 0.12)); }
.chip.on.type-entity { color: var(--t-entity, #0f6cbd); background: var(--t-entity-soft, rgba(15, 108, 189, 0.12)); }
.chip.on.type-agent { color: var(--t-agent, #0f7b0f); background: var(--t-agent-soft, rgba(15, 123, 15, 0.12)); }
.chip.on.type-other { color: var(--text-secondary); background: var(--bg-tertiary); }
.chip .cnt { opacity: 0.75; font-size: 10.5px; }
.chip.dim { opacity: 0.45; cursor: not-allowed; }
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
.select-host select { max-width: 200px; }

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
  gap: 3px;
}

.log-item {
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-secondary);
}
/* 失败那一档整行带一条红底渐晕：扫一眼列表就知道哪几条要处理 */
.log-item.failed {
  border-color: rgba(214, 69, 69, 0.28);
  background: linear-gradient(90deg, var(--danger-soft, rgba(214, 69, 69, 0.1)), var(--bg-secondary) 60%);
}

/*
 * 一条记录一行：时间 · 结果 · 事件+成员+摘要 …… 内容类型 · N 处改动 · 展开箭头。
 * 全部格子垂直居中放在同一 grid 行里——用 baseline 会把摘要推到下一行（行高翻倍）。
 * 老内核不支持 grid 时退回单行 flex，也不会散成几行。
 */
.log-row {
  width: 100%;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  text-align: left;
  font-size: 11.5px;
  color: var(--text-secondary);
  border-radius: 6px;
}
.log-row { display: grid; grid-template-columns: 96px auto minmax(0, 1fr) auto auto auto; }
.log-row > * { grid-row: 1; }
/* 每格显式定位：没有内容类型标签 / 没有「N 处改动」时，箭头仍要留在最右边 */
.log-row .ts { grid-column: 1; }
.log-row .badge { grid-column: 2; }
.log-row .sum { grid-column: 3; }
.log-row .tags { grid-column: 4; }
.log-row .count { grid-column: 5; }
.log-row .caret { grid-column: 6; }
.log-row:hover { background: var(--bg-hover); }
.log-row .ts {
  font-family: var(--font-mono, Consolas, monospace);
  color: var(--text-faint);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.log-row .badge {
  flex-shrink: 0;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.log-row .badge.changed { background: var(--accent-soft); color: var(--accent); }
.log-row .badge.none { background: var(--bg-tertiary); color: var(--text-faint); }
.log-row .badge.failed { background: var(--danger-soft, rgba(214, 69, 69, 0.12)); color: var(--danger, #d64545); }

.log-row .sum {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 7px;
}
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
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-row .tags {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  flex-wrap: nowrap;
}
.log-row .tag {
  min-width: 52px;
  justify-content: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10.5px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.log-row .tag .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.log-row .tag[data-type="原始资料"] { color: var(--t-raw, #a86800); background: var(--t-raw-soft, rgba(168, 104, 0, 0.12)); }
.log-row .tag[data-type="原始资料"] .dot { background: var(--t-raw, #a86800); }
.log-row .tag[data-type="概念"] { color: var(--t-concept, #6b4fa8); background: var(--t-concept-soft, rgba(107, 79, 168, 0.12)); }
.log-row .tag[data-type="概念"] .dot { background: var(--t-concept, #6b4fa8); }
.log-row .tag[data-type="实体"] { color: var(--t-entity, #0f6cbd); background: var(--t-entity-soft, rgba(15, 108, 189, 0.12)); }
.log-row .tag[data-type="实体"] .dot { background: var(--t-entity, #0f6cbd); }
.log-row .tag[data-type="内置 Agent"] { color: var(--t-agent, #0f7b0f); background: var(--t-agent-soft, rgba(15, 123, 15, 0.12)); }
.log-row .tag[data-type="内置 Agent"] .dot { background: var(--t-agent, #0f7b0f); }
.log-row .tag[data-type="其他"] { color: var(--text-secondary); background: var(--bg-tertiary); }
.log-row .tag[data-type="其他"] .dot { background: var(--text-faint); }

.log-row .count {
  flex-shrink: 0;
  padding: 0 8px;
  border-radius: 20px;
  font-size: 10.5px;
  color: var(--accent);
  background: var(--accent-soft);
  white-space: nowrap;
}
.log-row .caret {
  flex-shrink: 0;
  align-self: center;
  color: var(--text-faint);
  transition: transform 140ms ease;
}
.log-row .caret.open { transform: rotate(180deg); }

.log-data {
  padding: 8px 9px 10px 9px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 10.5px;
}
.sec-title .rule { flex: 1; height: 1px; background: var(--border); }

/* 改动清单：按内容类型分组 → 文件 → 改动块（带上下文的行级 diff） */
.group { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 9px;
  background: var(--bg-secondary);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.group-head .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--text-faint); }
.group-head .dot[data-type="原始资料"] { background: var(--t-raw, #a86800); }
.group-head .dot[data-type="概念"] { background: var(--t-concept, #6b4fa8); }
.group-head .dot[data-type="实体"] { background: var(--t-entity, #0f6cbd); }
.group-head .dot[data-type="内置 Agent"] { background: var(--t-agent, #0f7b0f); }
.group-head .n { margin-left: auto; font-weight: 400; color: var(--text-faint); font-size: 10.5px; }

.file { padding: 5px 9px 7px; border-top: 1px solid var(--border); }
.file-path {
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
}

.diff {
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 11px;
}
.diff .dl {
  display: flex;
  gap: 8px;
  padding: 1px 8px;
  line-height: 1.62;
}
.diff .dl .ln {
  flex: none;
  width: 34px;
  text-align: right;
  color: var(--text-faint);
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
}
.diff .dl .sign { flex: none; width: 9px; opacity: 0.85; }
.diff .dl .text { min-width: 0; white-space: pre-wrap; word-break: break-word; }
/* 上下文行：灰底/灰字，让「改在哪一行」有参照；新增绿、删除红（和 git diff 读法一致） */
.diff .dl.ctx .text { color: var(--text-secondary); }
.diff .dl.add { background: var(--diff-add-bg, rgba(15, 123, 15, 0.07)); }
.diff .dl.add .sign { color: var(--success, #0f7b0f); font-weight: 600; }
.diff .dl.add .text { color: var(--success, #0f7b0f); }
.diff .dl.del { background: var(--diff-del-bg, rgba(196, 43, 28, 0.06)); }
.diff .dl.del .sign { color: var(--danger, #c42b1c); font-weight: 600; }
.diff .dl.del .text { color: var(--danger, #c42b1c); }
.diff .dl.note .text { color: var(--text-faint); font-style: italic; }
.diff .hunk-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 8px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 10.5px;
  border-top: 1px solid var(--border);
}
.diff .hunk-head:first-child { border-top: 0; }
.diff .hunk-head .hh { color: var(--text-secondary); }
.diff .hunk-head .raw-head { margin-left: auto; opacity: 0.7; }

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

.expand-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.raw {
  margin: 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 10.5px;
  line-height: 1.6;
  white-space: pre;
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
  .sync-log-drawer { bottom: calc(64px + var(--safe-bottom)); }
  .log-stats { grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); }
  /* 窄屏放不下「时间 | 结果 | 摘要 | 标签 | 处数 | 箭头」六列：改成两行，仍是一条记录一块 */
  .log-row { grid-template-columns: 84px auto minmax(0, 1fr) auto; row-gap: 2px; }
  .log-row .ts { grid-column: 1; }
  .log-row .badge { grid-column: 2; }
  .log-row .count { grid-column: 3; justify-self: end; }
  .log-row .caret { grid-column: 4; }
  .log-row .sum { grid-column: 1 / -1; grid-row: 2; flex-wrap: wrap; }
  .log-row .detail { flex-basis: 100%; white-space: normal; }
  .log-row .tags { grid-column: 1 / -1; grid-row: 3; }
  .diff .dl .ln { width: 26px; }
}
</style>
