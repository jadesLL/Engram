<template>
  <div class="tasks-view">
    <div class="page-head">
      <h1>任务看板</h1>
      <span class="sub">{{ headSub }}</span>
      <div class="spacer" />
      <div class="head-actions">
        <button v-if="board" class="btn ghost" type="button" @click="copyBoard">
          <Icon name="clipboard" :size="14" />复制清单
        </button>
        <button class="btn primary" type="button" :disabled="tasks.running" @click="refresh">
          <AppSpinner v-if="tasks.running" :size="14" />
          <Icon v-else name="refresh" :size="14" />
          {{ tasks.running ? '正在提炼…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 正在提炼：不挡旧看板，只在顶部挂一条状态（动作文案来自服务端 status 事件） -->
    <div v-if="tasks.running" class="running-bar">
      <AppSpinner :size="14" />
      <b>{{ tasks.activity || '正在从知识库提炼…' }}</b>
      <span class="elapsed">{{ elapsed }}</span>
      <span class="hint">Agent 在后台跑，不用停在这一页；跑完再回来就能看到</span>
    </div>

    <div v-if="notice" class="notice" :class="notice.tone">
      <Icon :name="notice.tone === 'danger' ? 'alert' : 'activity'" :size="14" />
      <span>{{ notice.text }}</span>
      <button v-if="notice.action" class="notice-action" type="button" @click="notice.action.run()">
        {{ notice.action.label }}
      </button>
    </div>

    <p v-if="board?.summary" class="summary">{{ board.summary }}</p>

    <div v-if="tasks.loading && !tasks.loaded" class="loading-hint">
      <AppSpinner :size="14" /> 正在读看板…
    </div>

    <template v-else-if="board">
      <!-- 工具条：视图切换（按天 / 分列）＋ 三档筛选（同一档内是「或」，档之间是「且」） -->
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="看板视图">
          <button
            v-for="item in VIEWS"
            :key="item.key"
            class="seg-btn"
            type="button"
            role="tab"
            :aria-selected="view === item.key"
            :class="{ on: view === item.key }"
            @click="setView(item.key)"
          >{{ item.label }}</button>
        </div>
        <span class="toolbar-count">
          共 {{ totalCards }} 条<template v-if="hasFilter"> · 筛后 {{ filteredCards.length }} 条</template>
        </span>
        <div class="spacer" />
        <button class="btn ghost" type="button" @click="toggleAllCollapsed">
          <Icon :name="allCollapsed ? 'unfold' : 'fold'" :size="13" />{{ allCollapsed ? '全部展开' : '全部收起' }}
        </button>
        <button v-if="hasFilter" class="btn ghost" type="button" @click="clearFilter">
          <Icon name="x" :size="13" />清除筛选
        </button>
      </div>

      <div class="filters">
        <div v-for="facet in FACET_ROWS" :key="facet.key" class="filter-row">
          <span class="filter-label">{{ facet.label }}</span>
          <div class="filter-chips">
            <button
              v-for="option in facets[facet.key]"
              :key="option.value"
              class="fchip"
              type="button"
              :class="{ on: filter[facet.key].includes(option.value) }"
              :aria-pressed="filter[facet.key].includes(option.value)"
              @click="toggleFacet(facet.key, option.value)"
            >{{ option.value }}<span class="fchip-count">{{ option.count }}</span></button>
          </div>
        </div>
      </div>

      <div class="board" :class="`view-${view}`">
        <section
          v-for="section in sections"
          :key="section.key"
          class="column"
          :class="[`bucket-${section.bucket}`, { 'is-empty': !section.cards.length, collapsed: isCollapsed(section.collapseKey) }]"
        >
          <!-- 整条标题就是收放开关：收起后只留标题与条数，10 多块也能一眼扫完 -->
          <button
            class="column-head"
            type="button"
            :aria-expanded="!isCollapsed(section.collapseKey)"
            :aria-label="`${isCollapsed(section.collapseKey) ? '展开' : '收起'}${section.title}`"
            @click="toggleSection(section.collapseKey)"
          >
            <Icon class="column-caret" name="chevron-right" :size="13" />
            <span class="column-title">{{ section.title }}</span>
            <span class="column-count">{{ section.cards.length }}</span>
            <span v-if="section.bucket === 'overdue' && section.cards.length" class="column-alert">先补</span>
          </button>
          <div v-show="!isCollapsed(section.collapseKey)" class="cards">
            <article v-for="card in section.cards" :key="card.key" class="card" :class="{ overdue: card.overdue }">
              <p class="card-text">{{ card.card.text }}</p>
              <div class="meta">
                <span v-if="card.card.owner" class="chip owner" v-tooltip="'责任人'">{{ card.card.owner }}</span>
                <span
                  v-if="card.card.when || card.card.repeat"
                  class="chip when"
                  v-tooltip="card.card.repeat ? `周期：${card.card.repeat}` : '材料里的时间写法'"
                >{{ card.card.when || card.card.repeat }}</span>
                <span
                  class="chip customer"
                  v-tooltip="card.card.customer ? '客户' : '没有客户，按端组归到内部工作'"
                >{{ customerOf(card.card) }}</span>
                <!-- 有客户时才单列端组：内部工作的客户胶囊已经写着「X 组内部工作」，再来一个端组就是重复 -->
                <span v-if="card.card.customer" class="chip team" v-tooltip="'端组'">{{ card.card.team }}</span>
                <span v-if="card.overdue" class="chip overdue-days">逾期 {{ card.overdueDays }} 天</span>
              </div>
              <button
                v-if="targetOf(card.card).kind !== 'none'"
                class="source"
                type="button"
                v-tooltip="'跳到依据的原文'"
                @click="openSource(card.card)"
              >
                <Icon name="link" :size="12" />{{ targetOf(card.card).label }}
              </button>
              <span v-else-if="card.card.source" class="source plain">{{ card.card.source }}</span>
            </article>
            <p v-if="!section.cards.length" class="column-empty">
              {{ section.bucket === 'day' ? '本日暂无' : '本列暂无' }}
            </p>
          </div>
        </section>
      </div>

      <p v-if="hasFilter && !filteredCards.length" class="filter-empty">
        当前筛选下没有任务——点「清除筛选」看全部。
      </p>

      <section v-if="board.gaps.length" class="gaps">
        <h2><Icon name="alert" :size="14" />资料缺口</h2>
        <ul>
          <li v-for="(gap, index) in board.gaps" :key="index">{{ gap }}</li>
        </ul>
        <p class="gaps-hint">这些是库里没记录、要你自己补的：补进日课复盘或专题纪要，下次看板就准了。</p>
      </section>
    </template>

    <AppEmptyState
      v-else-if="!tasks.running"
      icon="board"
      title="还没有任务看板"
      :hint="emptyHint"
    >
      <button class="btn primary" type="button" :disabled="tasks.running" @click="refresh">
        <Icon name="ai" :size="15" />生成看板
      </button>
    </AppEmptyState>

    <!-- 第一版还没出来：给一块明确的等待区，而不是空状态（免得看起来像没开始） -->
    <div v-else class="first-run">
      <AppSpinner :size="20" />
      <p class="first-run-title">正在生成第一版看板…</p>
      <p class="first-run-hint">
        Agent 正在翻最近几周的日课复盘、专题会待办与实体页时间线，约 1-3 分钟；<br />
        这一步跑在后台，你可以切去别的页面，回来就是成品。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import Icon from '../components/Icon.vue';
import { api } from '../api';
import { useTasksStore } from '../stores/tasks';
import {
  boardCardCount,
  boardFacets,
  boardView,
  cardCustomer,
  cardToMarkdown,
  filterCards,
  isOverdue,
  isoToday,
  overdueDays,
  sectionKey,
  taskCardTarget,
  type BoardFilter,
  type TaskBoardColumn,
  type TaskCard,
} from '../lib/taskBoard';
import { formatSessionTime } from '../lib/chatTime';
import { notify } from '../lib/notify';
import { openPageStream } from '../lib/events';

/**
 * 任务看板页：进来先看缓存（六小时内的直接显示），过期或没有就自动让 Agent 重新提炼，
 * 提炼期间不挡旧看板；跑完自动换成新的。整页只读，不写知识库。
 *
 * 视图与筛选都在客户端做（数据已经是结构化的）：按天＝1、2、3… 每天要干什么；
 * 分列＝按来源三节。三档筛选共用，逾期单独一块放最前。
 */
const router = useRouter();
const tasks = useTasksStore();
/** 看板被别端同步更新时的 SSE 订阅（离开页面即断开） */
let closeBoardStream: (() => void) | undefined;

const board = computed(() => tasks.board);

/* ===== 视图：按天 / 分列，选择记在本机 ===== */
type ViewKey = 'day' | 'column';
const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: 'day', label: '按天' },
  { key: 'column', label: '分列' },
];
const VIEW_STORAGE = 'taskBoardView';
function storedView(): ViewKey {
  return localStorage.getItem(VIEW_STORAGE) === 'column' ? 'column' : 'day';
}
const view = ref<ViewKey>(storedView());
function setView(next: ViewKey) {
  view.value = next;
  localStorage.setItem(VIEW_STORAGE, next);
}

/* ===== 筛选：人物 / 客户 / 端组，同一档内「或」、档之间「且」 ===== */
const FACET_ROWS: Array<{ key: keyof BoardFilter; label: string }> = [
  { key: 'owners', label: '人物' },
  { key: 'customers', label: '客户' },
  { key: 'teams', label: '端组' },
];
const filter = reactive<BoardFilter>({ owners: [], customers: [], teams: [] });

const facets = computed(() => boardFacets(board.value));
const totalCards = computed(() => boardCardCount(board.value));
const filteredCards = computed(() => filterCards(board.value, filter));
const hasFilter = computed(
  () => filter.owners.length + filter.customers.length + filter.teams.length > 0
);

function toggleFacet(key: keyof BoardFilter, value: string) {
  const picked = filter[key];
  const at = picked.indexOf(value);
  if (at >= 0) picked.splice(at, 1);
  else picked.push(value);
}

function clearFilter() {
  filter.owners = [];
  filter.customers = [];
  filter.teams = [];
}

function customerOf(card: TaskCard) {
  return cardCustomer(card);
}

/* ===== 收放：按「星期几 / 固定块」记在本机（日期一周一周变，存日期等于每周丢偏好） ===== */
const COLLAPSE_STORAGE = 'taskBoardCollapsed';
function storedCollapsed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE) || '[]');
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}
const collapsed = ref<Set<string>>(new Set(storedCollapsed()));

function isCollapsed(key: string) {
  return collapsed.value.has(key);
}

function persistCollapsed() {
  localStorage.setItem(COLLAPSE_STORAGE, JSON.stringify([...collapsed.value]));
}

function toggleSection(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
  persistCollapsed();
}

const allCollapsed = computed(
  () => sections.value.length > 0 && sections.value.every((section) => collapsed.value.has(section.collapseKey))
);

/** 全部收起 / 全部展开：一次改完，别让人一块一块点 */
function toggleAllCollapsed() {
  collapsed.value = allCollapsed.value
    ? new Set()
    : new Set(sections.value.map((section) => section.collapseKey));
  persistCollapsed();
}

/* ===== 分组：筛过的卡片 → 当前视图的每一块 ===== */
const rawSections = computed<TaskBoardColumn[]>(() => {
  const model = boardView(filteredCards.value, { start: tasks.windowStart, end: tasks.windowEnd });
  return view.value === 'day' ? model.day : model.column;
});

const sections = computed(() => {
  const today = isoToday();
  return rawSections.value.map((section) => ({
    key: `${section.bucket}-${section.date}-${section.title}`,
    /** 收放偏好的稳定标识：按星期几 / 固定块，不随日期变 */
    collapseKey: sectionKey(section),
    title: section.title,
    bucket: section.bucket,
    cards: section.cards.map((card, index) => ({
      key: `${section.title}-${index}-${card.text.slice(0, 12)}`,
      card,
      overdue: isOverdue(card, today),
      overdueDays: overdueDays(card, today),
    })),
  }));
});

/** 顶部副标题：一眼看清这份看板「上次更新时间」、以及是不是别端同步过来的 */
const headSub = computed(() => {
  if (tasks.running) return tasks.answer ? '正在重新提炼，下面是上一版' : '正在从知识库提炼';
  if (!tasks.generatedAt) return '点一下就按知识库生成下周的活';
  const from = !tasks.local && tasks.sourceNodeLabel ? `（来自 ${tasks.sourceNodeLabel}）` : '';
  return `上次更新：${formatSessionTime(tasks.generatedAt)}${from}${tasks.stale ? ' · 已超过 6 小时' : ''}`;
});

const emptyHint = computed(() =>
  tasks.error
    ? `还不能生成：${tasks.error}`
    : '看板由内置 Agent 从最近的复盘、专题会待办与实体页时间线里提炼，点「生成看板」即可（约 1-3 分钟）'
);

const notice = computed<{ tone: 'danger' | 'warn'; text: string; action?: { label: string; run: () => void } } | null>(() => {
  if (tasks.error && tasks.answer) {
    return { tone: 'danger', text: `这次刷新没成功：${tasks.error}`, action: { label: '再试一次', run: () => void refresh() } };
  }
  if (tasks.error && !tasks.answer) {
    return {
      tone: 'danger',
      text: tasks.error,
      action: { label: '去配 Agent', run: () => void router.push('/settings') },
    };
  }
  if (!tasks.running && tasks.stale && tasks.answer) {
    return { tone: 'warn', text: '这份看板超过 6 小时了，建议刷新一次。' };
  }
  return null;
});

/* ===== 计时：跑起来就每秒跳，让人知道它还在动 ===== */
const elapsed = ref('');
let timer: number | undefined;

function tickElapsed() {
  const from = tasks.runStartedAt ? Date.parse(tasks.runStartedAt) : Date.now();
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  const minutes = Math.floor(seconds / 60);
  elapsed.value = minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function syncTimer() {
  if (tasks.running) {
    if (timer === undefined) {
      tickElapsed();
      timer = window.setInterval(tickElapsed, 1000);
    }
  } else if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
    elapsed.value = '';
  }
}

/* 运行状态变了就开/停计时器（store 的状态是唯一来源） */
watch(() => tasks.running, syncTimer, { immediate: true });

async function refresh() {
  if (tasks.running) return;
  await tasks.refresh();
}

/** 依据 → 落点：文件直接进预览/编辑器，页面按标题查 id 再跳 */
async function openSource(card: TaskCard) {
  const target = taskCardTarget(card);
  if (target.kind === 'file') {
    void router.push({ path: '/page', query: { file: target.target } });
    return;
  }
  if (target.kind === 'page') {
    try {
      const { data } = await api.get(`/api/pages/by-title/${encodeURIComponent(target.target)}`);
      void router.push(`/page/${data.id}`);
    } catch {
      notify.error(`没有找到页面《${target.target}》`);
    }
  }
}

function targetOf(card: TaskCard) {
  return taskCardTarget(card);
}

async function copyBoard() {
  const current = board.value;
  if (!current) return;
  try {
    // 复制的是「我正在看的这一版」：视图与筛选都带上
    await navigator.clipboard.writeText(cardToMarkdown(current, rawSections.value));
    notify.success('清单已复制');
  } catch {
    notify.error('复制失败');
  }
}

onMounted(async () => {
  const needsRefresh = await tasks.load();
  // 没有答案或已过期就自动重跑；正在跑的那一轮由 store 接上事件流，不重复触发
  if (needsRefresh && !tasks.running) await tasks.refresh();
  // 别端刷新了看板（多端同步把最新的那份推过来）：重拉一次，界面直接换成最新那版
  closeBoardStream = openPageStream((ev) => {
    if (ev.type === 'board-changed') void tasks.load();
  });
});

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  closeBoardStream?.();
  closeBoardStream = undefined;
  tasks.detach();
});
</script>

<style scoped>
.tasks-view {
  padding: 20px 24px 40px;
  max-width: 1500px;
}

.page-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}

.page-head h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.2px;
}

.page-head .sub { font-size: 12.5px; color: var(--text-faint); }
.spacer { flex: 1; }
.head-actions { display: flex; align-items: center; gap: 8px; }

.running-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--accent-soft);
  color: var(--text-secondary);
  font-size: 12.5px;
}

.running-bar b { color: var(--text); font-weight: 600; }
.running-bar .elapsed { font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.running-bar .hint { color: var(--text-faint); margin-left: auto; }

.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 9px 12px;
  border-radius: var(--radius-control);
  font-size: 12.5px;
}

.notice.danger { background: var(--danger-soft); color: var(--danger); }
.notice.warn { background: var(--warn-soft); color: var(--warning); }
.notice-action {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

.summary {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.loading-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 12.5px;
  padding: 24px 0;
}

.first-run {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 64px 20px;
  text-align: center;
}

.first-run-title { margin: 6px 0 0; color: var(--text-secondary); font-size: 13.5px; }
.first-run-hint { margin: 0; color: var(--text-faint); font-size: 12px; line-height: 1.8; }

/* ===== 工具条：视图切换 + 条数 + 清除筛选 ===== */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-tertiary);
}

.seg-btn {
  padding: 4px 12px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
}

.seg-btn.on {
  background: var(--card-bg);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-raised);
}

.toolbar-count { color: var(--text-faint); font-size: 12px; }

/* ===== 筛选：三档可点的小胶囊（同一档内多选＝或） ===== */
.filters {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}

.filter-row { display: flex; align-items: flex-start; gap: 8px; }

.filter-label {
  flex: 0 0 auto;
  padding-top: 3px;
  color: var(--text-faint);
  font-size: 12px;
}

.filter-chips { display: flex; flex-wrap: wrap; gap: 6px; }

.fchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.fchip:hover { border-color: var(--border-strong); color: var(--text); }

.fchip.on {
  border-color: transparent;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}

.fchip-count { opacity: 0.6; font-size: 11px; }

.filter-empty {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: var(--radius-control);
  background: var(--warn-soft);
  color: var(--warning);
  font-size: 12.5px;
}

.board {
  display: grid;
  gap: 14px;
  align-items: start;
}

/* 按天：一块一行、自上而下严格按顺序（周一到周五 → 周末 → 周期 / 逾期 / 待定）；
   分列：四列并排。两块视图里卡片都在块内自动铺列 */
.board.view-day { grid-template-columns: 1fr; }
.board.view-column { grid-template-columns: repeat(4, minmax(220px, 1fr)); }

.board.view-day .cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 8px;
  align-items: start;
}

.column.collapsed { padding-bottom: 6px; }
.column.collapsed .column-head { margin-bottom: 0; }

/* 没安排的整天压成一行，别让「本日暂无」占掉半屏 */
.column.is-empty { padding: 6px 12px; }
.column.is-empty .column-empty { padding: 0; text-align: left; }
.column.is-empty .column-title { color: var(--text-secondary); }

/* 标题整条是开关：hover 给一点反馈，箭头收起时指右、展开时指下 */
.column-head {
  width: 100%;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  padding: 2px 4px;
  margin: -2px -4px 2px;
  border-radius: var(--radius-control);
  text-align: left;
}

.column-head:hover { background: var(--bg-hover); }

.column-caret {
  color: var(--text-faint);
  transition: transform 140ms ease;
}

.column:not(.collapsed) .column-caret { transform: rotate(90deg); }

.column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}

.column-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.column-title { font-size: 13px; font-weight: 600; }

.column-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.cards { display: flex; flex-direction: column; gap: 8px; }

.card {
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
}

.card-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

.chip {
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
}

.chip.owner { background: var(--accent-soft); color: var(--accent); }
.chip.customer { background: rgba(117, 106, 166, 0.12); color: var(--file-markdown); }
.chip.team { background: var(--bg-tertiary); }
.chip.overdue-days { background: var(--danger-soft); color: var(--danger); font-weight: 600; }

/* 逾期：整块与卡片都压一档红，扫一眼就知道先干这个 */
.column.bucket-overdue { border-color: rgba(196, 43, 28, 0.28); background: var(--danger-soft); }
.column.bucket-overdue .column-title { color: var(--danger); }
.column.bucket-periodic { border-style: dashed; }
.column.bucket-day.is-empty { opacity: 0.65; }
.column.bucket-day.is-empty .cards { padding: 0; }

.column-alert {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--danger);
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
}

.card.overdue { border-color: rgba(196, 43, 28, 0.3); }
.card.overdue .card-text { color: var(--danger); }

.source {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin-top: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source:hover { color: var(--accent); text-decoration: underline; }
.source.plain { cursor: default; }
.source.plain:hover { color: var(--text-faint); text-decoration: none; }

.column-empty {
  margin: 0;
  padding: 10px 0;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

.gaps {
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}

.gaps h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--warning);
}

.gaps ul { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: 12.5px; line-height: 1.8; }
.gaps-hint { margin: 8px 0 0; color: var(--text-faint); font-size: 11.5px; }

/* 窄屏：所有列竖着排（手机与窄窗口）；工具条与筛选折行 */
@media (max-width: 900px) {
  .tasks-view { padding: 16px 14px 32px; }
  .board.view-column,
  .board.view-day { grid-template-columns: 1fr; }
  .page-head { flex-wrap: wrap; }
  .running-bar { flex-wrap: wrap; }
  .running-bar .hint { margin-left: 0; }
  .toolbar { flex-wrap: wrap; }
  .filter-row { flex-direction: column; gap: 4px; }
}
</style>
