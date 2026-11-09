<template>
  <div class="tasks-view">
    <div class="page-head">
      <h1>任务看板</h1>
      <span class="sub">{{ headSub }}</span>
      <div class="spacer" />
      <div class="head-actions">
        <button
          v-if="canConfigureAuto"
          class="btn ghost"
          type="button"
          v-tooltip="'自动提炼的间隔（关闭自动 / 每天 / 每 2 天 / 每 3 天 / 每 7 天）在设置里调'"
          @click="openAutoSettings"
        >
          <Icon name="settings" :size="14" />自动提炼：{{ autoLabel }}
        </button>
        <!-- 手机端（设置页「Agent 与自动化」不渲染）：就地改档位，接口已由本机服务代理到中枢 -->
        <AppSelect
          v-if="boardAutoEditable"
          v-model="autoDaysDraft"
          class="head-auto-select"
          aria-label="自动提炼间隔"
          :options="autoChoices"
          :disabled="autoSaving"
          v-tooltip="'看板自动重新提炼的间隔；改完立即生效（打开看板页时才判一次到期）'"
          @change="saveAutoDays"
        />
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
      <!-- 工具条：视图切换（周 / 月）＋ 时间翻页 ＋ 条数；筛选同一套贯穿两个视图 -->
      <div class="toolbar">
        <div class="seg" role="group" aria-label="看板视图">
          <button
            v-for="item in VIEWS"
            :key="item.key"
            class="seg-btn"
            type="button"
            :aria-pressed="view === item.key"
            :class="{ on: view === item.key }"
            @click="setView(item.key)"
          >{{ item.label }}</button>
        </div>
        <div class="date-nav">
          <button
            class="icon-btn"
            type="button"
            :aria-label="view === 'week' ? '上一周' : '上个月'"
            @click="shiftSpan(-1)"
          >
            <Icon name="chevron-left" :size="15" />
          </button>
          <span class="date-label">{{ spanLabel }}</span>
          <button
            class="icon-btn"
            type="button"
            :aria-label="view === 'week' ? '下一周' : '下个月'"
            @click="shiftSpan(1)"
          >
            <Icon name="chevron-right" :size="15" />
          </button>
          <button class="btn ghost small" type="button" @click="goToday">今天</button>
        </div>
        <!-- 手机上筛选三行会吃掉首屏：收成一颗按钮，点开再选 -->
        <button
          class="btn ghost small filter-toggle"
          type="button"
          :aria-expanded="filtersOpen"
          @click="filtersOpen = !filtersOpen"
        >
          <Icon name="sort" :size="13" />筛选<template v-if="activeFilterCount"> · {{ activeFilterCount }}</template>
        </button>
        <span class="toolbar-count">
          共 {{ totalCards }} 条<template v-if="hasFilter"> · 筛后 {{ filteredCards.length }} 条</template><template v-if="panels.overdue.length"> · 逾期 {{ panels.overdue.length }}</template>
        </span>
        <div class="spacer" />
        <button v-if="hasFilter" class="btn ghost" type="button" @click="clearFilter">
          <Icon name="x" :size="13" />清除筛选
        </button>
      </div>

      <div class="filters" :class="{ 'mobile-collapsed': !filtersOpen }">
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

      <!-- 周视图：逾期条先摆出来（免得多任务那一列把它顶出首屏），再看 7 天网格；
           月视图：整月日历 + 各周负载（点某天切到那一周） -->
      <TaskOverdueBar
        v-if="view === 'week'"
        :overdue="panels.overdue"
        :today="today"
        :completing-keys="completingKeys"
        @complete="completeCard"
      />
      <TaskWeekBoard
        v-if="view === 'week'"
        :days="weekView.days"
        :today="today"
        :completing-keys="completingKeys"
        @complete="completeCard"
        @open="openSource"
      />
      <TaskMonthBoard v-else :model="monthView" :today="today" @pick="pickDay" />

      <TaskBoardPanels
        :overdue="panels.overdue"
        :periodic="panels.periodic"
        :later="panels.later"
        :later-title="laterTitle"
        :today="today"
        :completing-keys="completingKeys"
        :hide-overdue="view === 'week' || panels.overdue.length === 0"
        @complete="completeCard"
      />

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
import AppSelect from '../components/ui/AppSelect.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import Icon from '../components/Icon.vue';
import TaskBoardPanels from '../components/taskBoard/TaskBoardPanels.vue';
import TaskMonthBoard from '../components/taskBoard/TaskMonthBoard.vue';
import TaskOverdueBar from '../components/taskBoard/TaskOverdueBar.vue';
import TaskWeekBoard from '../components/taskBoard/TaskWeekBoard.vue';
import { api } from '../api';
import { useTasksStore } from '../stores/tasks';
import { useRuntimeCapabilities } from '../lib/capabilities';
import {
  addDays,
  addMonths,
  boardCardCount,
  boardFacets,
  cardToMarkdown,
  filterCards,
  isoToday,
  mondayOf,
  MONTH_LATER_BUCKET,
  monthBoardView,
  monthSections,
  taskCardKey,
  taskCardTarget,
  weekBoardView,
  weekSections,
  WEEK_LATER_BUCKET,
  type BoardFilter,
  type TaskBoardColumn,
  type TaskCard,
} from '../lib/taskBoard';
import { formatSessionTime } from '../lib/chatTime';
import { boardAutoChoices, boardAutoLabel } from '../lib/boardAuto';
import { runtimeCapabilitiesSnapshot } from '../lib/capabilities';
import { notify } from '../lib/notify';
import { openPageStream } from '../lib/events';

/**
 * 任务看板页：进来先看缓存——距上次提炼没超过「自动提炼」配的间隔就直接显示，
 * 到点了（或还没有答案）才自动让 Agent 重新提炼，提炼期间不挡旧看板，跑完自动换成新的。
 * 间隔在设置里调（关闭自动 / 每天 / 每 2 天 / 每 3 天 / 每 7 天），页头那个按钮只负责跳过去。
 * 逾期任务支持手动完成，将完成日期写回 Markdown 依据。
 *
 * 视图与筛选都在客户端做（数据已经是结构化的）：周视图＝这一周每天要干什么（周一→周日 7 列）；
 * 月视图＝整月日历 + 各周负载。三档筛选共用，逾期 / 周期 / 其它时间单独成块。
 */
const router = useRouter();
const tasks = useTasksStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
/**
 * 能不能在这儿跳去改档位：档位是「Agent 与自动化」大类里的分组，那一类只在能管 Agent 的端
 * （桌面端 / Docker）出现——手机端 agentAdmin=false，按钮就藏起来（副标题仍显示当前档位），
 * 免得点进去落在设置页第一个大类上，像是点坏了。
 */
const canConfigureAuto = computed(() => capabilities.value.features.agentAdmin);
/**
 * 手机上就地改档位：设置页「Agent 与自动化」那一大类不渲染（agentAdmin=false，手机改不了模型 Key
 * 那类中枢配置），但**看板档位本身是通的**——Android 本机服务把 `/api/tasks/board/config` 窄代理到
 * 已绑定的中枢。所以这里给一个档位下拉就地改，免得「能看不能改」（此前只能去设置页，而那一类不出现）。
 */
const boardAutoEditable = computed(() => !canConfigureAuto.value && capabilities.value.agentMode === 'hub');
/** 档位选项由服务端给（关闭自动 / 每天 / 每 2 天 / 每 3 天 / 每 7 天），拿不到时用同一份兜底 */
const autoOptions = ref<number[]>([0, 1, 2, 3, 7]);
const autoDaysDraft = ref('0');
const autoSaving = ref(false);
const autoChoices = computed(() => boardAutoChoices(autoOptions.value));
/** 看板被别端同步更新时的 SSE 订阅（离开页面即断开） */
let closeBoardStream: (() => void) | undefined;

const board = computed(() => tasks.board);
const completingKeys = ref(new Set<string>());

async function completeCard(card: TaskCard) {
  const key = taskCardKey(card);
  if (completingKeys.value.has(key)) return;
  completingKeys.value.add(key);
  try {
    const { data } = await api.post<{ key: string; date: string; path: string }>('/api/tasks/board/complete', {
      key,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    tasks.completedTaskKeys = [...new Set([...tasks.completedTaskKeys, data.key])];
    notify.success(`已手动完成：${data.date}，已写入 ${data.path}`);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '完成记录保存失败，请重试');
  } finally {
    completingKeys.value.delete(key);
  }
}

/* ===== 视图：周视图 / 月视图，选择记在本机（旧版「按天 / 分列」读到时统一归到周视图） ===== */
type ViewKey = 'week' | 'month';
const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: 'week', label: '周视图' },
  { key: 'month', label: '月视图' },
];
const VIEW_STORAGE = 'taskBoardView';
function storedView(): ViewKey {
  return localStorage.getItem(VIEW_STORAGE) === 'month' ? 'month' : 'week';
}
const view = ref<ViewKey>(storedView());
function setView(next: ViewKey) {
  view.value = next;
  localStorage.setItem(VIEW_STORAGE, next);
}

/**
 * 时间锚点：周视图看 weekStart 那一周，月视图看 monthAnchor 那个月。
 * 默认跟着这份看板的窗口（服务端按答案生成时刻算好的「下周」）；用户自己翻过之后不再被刷新带跑。
 */
const today = computed(() => isoToday());
const weekStart = ref(mondayOf(isoToday()));
const monthAnchor = ref(weekStart.value.slice(0, 7));
const manualSpan = ref(false);

watch(
  () => tasks.windowStart,
  (value) => {
    if (!value || manualSpan.value) return;
    weekStart.value = mondayOf(value);
    monthAnchor.value = weekStart.value.slice(0, 7);
  },
  { immediate: true }
);

function monthDay(date: string) {
  const [, month, day] = date.split('-');
  return `${Number(month)} 月 ${Number(day)} 日`;
}

/** 工具条上的时间范围：周视图「11 月 9 日 – 11 月 15 日」，月视图「2026 年 11 月」 */
const spanLabel = computed(() => {
  if (view.value === 'month') {
    const [year, month] = monthAnchor.value.split('-').map(Number);
    return `${year} 年 ${month} 月`;
  }
  return `${monthDay(weekStart.value)} – ${monthDay(addDays(weekStart.value, 6))}`;
});

/** 翻页：周视图一周一周翻，月视图一个月一个月翻；翻到别的月时周锚点落在那个月的第一个周一 */
function shiftSpan(delta: number) {
  manualSpan.value = true;
  if (view.value === 'week') {
    weekStart.value = addDays(mondayOf(weekStart.value), delta * 7);
    monthAnchor.value = weekStart.value.slice(0, 7);
    return;
  }
  monthAnchor.value = addMonths(monthAnchor.value, delta);
  weekStart.value = mondayOf(`${monthAnchor.value}-01`);
}

function goToday() {
  manualSpan.value = true;
  const now = isoToday();
  weekStart.value = mondayOf(now);
  monthAnchor.value = now.slice(0, 7);
}

/** 月历里点某一天：切到那一周的周视图接着处理 */
function pickDay(date: string) {
  manualSpan.value = true;
  weekStart.value = mondayOf(date);
  monthAnchor.value = weekStart.value.slice(0, 7);
  setView('week');
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
/** 手机上「筛选」按钮上的数字 */
const activeFilterCount = computed(() => filter.owners.length + filter.customers.length + filter.teams.length);
/** 手机档筛选默认收起（桌面档这个状态不起作用，筛选块始终展开） */
const filtersOpen = ref(false);

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

/* ===== 分组：筛过的卡片 → 当前视图的每一块（口径在 taskBoardModel，界面只画） ===== */
const weekView = computed(() => weekBoardView(filteredCards.value, weekStart.value, today.value));
const monthView = computed(() => monthBoardView(filteredCards.value, monthAnchor.value, today.value));
const panels = computed(() =>
  view.value === 'week'
    ? { overdue: weekView.value.overdue, periodic: weekView.value.periodic, later: weekView.value.later }
    : { overdue: monthView.value.overdue, periodic: monthView.value.periodic, later: monthView.value.later }
);
const laterTitle = computed(() => (view.value === 'week' ? WEEK_LATER_BUCKET : MONTH_LATER_BUCKET));

/** 「复制清单」用当前视图的板块（周：七天 + 三块；月：有任务的日子 + 三块） */
const currentSections = computed<TaskBoardColumn[]>(() =>
  view.value === 'week' ? weekSections(weekView.value) : monthSections(monthView.value)
);

/** 页头「自动提炼」按钮上的档位文案（0 = 关闭自动；口径与设置页同一处：lib/boardAuto） */
const autoLabel = computed(() => boardAutoLabel(tasks.autoDays));

/** 顶部副标题：一眼看清这份看板「上次更新时间」、自动提炼档位，以及是不是别端同步过来的 */
const headSub = computed(() => {
  if (tasks.running) return tasks.answer ? '正在重新提炼，下面是上一版' : '正在从知识库提炼';
  if (!tasks.generatedAt) return '点一下就按知识库生成下周的活';
  const from = !tasks.local && tasks.sourceNodeLabel ? `（来自 ${tasks.sourceNodeLabel}）` : '';
  const auto = tasks.autoDays > 0 ? `自动提炼：${autoLabel.value}` : '自动提炼已关闭';
  return `上次更新：${formatSessionTime(tasks.generatedAt)}${from} · ${auto}`;
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
    return { tone: 'warn', text: `这份看板已超过「${autoLabel.value}」，建议刷新一次。` };
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

/**
 * 跳设置页的「任务看板提炼」分组（档位只有一个编辑入口，就放设置里，看板页只显示当前档位）。
 * 用 ?section=agent&anchor=agent-board 深链：设置页按这两个参数直接落在大类与分组上。
 * 端上没法管 Agent 时（锚点所在大类不渲染）不跳，直接说清楚去哪儿调。
 */
function openAutoSettings() {
  if (!canConfigureAuto.value) {
    notify.info('自动提炼的档位在桌面端 / Docker 端的「设置 → Agent 与自动化 → 任务看板提炼」里调');
    return;
  }
  void router.push({ path: '/settings', query: { section: 'agent', anchor: 'agent-board' } });
}

/** 手机端：档位下拉的初始化（选项由服务端给，拿不到就用与服务端一致的兜底档位） */
async function loadAutoOptions() {
  if (!boardAutoEditable.value) return;
  autoDaysDraft.value = String(tasks.autoDays || 0);
  try {
    const { data } = await api.get<{ options?: number[] }>('/api/tasks/board/config');
    if (Array.isArray(data?.options) && data.options.length) autoOptions.value = data.options;
  } catch {
    /* 拿不到选项不影响改档位：兜底档位与服务端 BOARD_AUTO_OPTIONS 一致 */
  }
}

/** 手机端：就地保存档位（走本机服务窄代理到中枢；改完界面与副标题立刻跟着变） */
async function saveAutoDays() {
  if (autoSaving.value) return;
  const next = Number(autoDaysDraft.value) || 0;
  if (next === (tasks.autoDays || 0)) return;
  autoSaving.value = true;
  try {
    const { data } = await api.put<{ autoDays?: number }>('/api/tasks/board/config', { autoDays: next });
    const saved = Number(data?.autoDays);
    tasks.autoDays = Number.isFinite(saved) ? saved : next;
    autoDaysDraft.value = String(tasks.autoDays);
    notify.success(tasks.autoDays > 0 ? `已保存：${boardAutoLabel(tasks.autoDays)}重新提炼一次` : '已保存：自动提炼已关闭');
  } catch (error: any) {
    autoDaysDraft.value = String(tasks.autoDays || 0);
    notify.error(error?.response?.data?.error || '档位没保存成功');
  } finally {
    autoSaving.value = false;
  }
}

/** 别端同步/服务端回包改了档位时，下拉跟着走（自己正在保存时不打断输入） */
watch(
  () => tasks.autoDays,
  (value) => {
    if (!autoSaving.value) autoDaysDraft.value = String(value || 0);
  },
);

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

async function copyBoard() {
  const current = board.value;
  if (!current) return;
  try {
    // 复制的是「我正在看的这一版」：视图（周/月）与筛选都带上
    await navigator.clipboard.writeText(cardToMarkdown(current, currentSections.value));
    notify.success('清单已复制');
  } catch {
    notify.error('复制失败');
  }
}

onMounted(async () => {
  // 能力位（能否就地跳设置改档位）与看板数据并行取，不互相等
  void loadCapabilities();
  const needsRefresh = await tasks.load();
  // 进页面时看板窗口到了：没被用户翻过就跟到那一周（看板默认看「下周」）
  if (tasks.windowStart && !manualSpan.value) {
    weekStart.value = mondayOf(tasks.windowStart);
    monthAnchor.value = weekStart.value.slice(0, 7);
  }
  // 没有答案或已过期就自动重跑；正在跑的那一轮由 store 接上事件流，不重复触发
  if (needsRefresh && !tasks.running) await tasks.refresh();
  // 手机端：档位下拉的选项与初值（设置页那一类不渲染，只能就地改）
  void loadAutoOptions();
  // Android 本地端没有 /api/events（本机服务不提供该路由）：开 EventSource 只会 404 重连，
  // 还会弹「实时同步连接断开，正在自动重连」——看板换版靠进入页面与手动刷新（同 Home.vue 的门禁）
  if (runtimeCapabilitiesSnapshot().runtime !== 'android-local') {
    // 别端刷新了看板（多端同步把最新的那份推过来）：重拉一次，界面直接换成最新那版
    closeBoardStream = openPageStream((ev) => {
      if (ev.type === 'board-changed' || ev.type === 'page-changed' || ev.type === 'page-deleted' || ev.type === 'page-moved') void tasks.load();
    });
  }
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
  font-size: 24px;
  font-weight: 700;
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

/* 2026-10 方案 A：概览条改成四角圆角 + accent 渐隐底色，不再是左边条卡片 */
.summary {
  margin: 0 0 14px;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  background: linear-gradient(90deg, var(--accent-soft), transparent 75%), var(--bg-secondary);
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

/* ===== 工具条：周 / 月视图切换 + 时间翻页 + 条数 ===== */
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

.date-nav { display: flex; align-items: center; gap: 2px; }
.icon-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.date-label {
  min-width: 158px;
  white-space: nowrap;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.toolbar-count { color: var(--text-secondary); font-size: 12px; }
.filter-toggle { display: none; }
@media (max-width: 768px) {
  .filter-toggle { display: inline-flex; }
  .filters.mobile-collapsed { display: none; }
}
@media (hover: none) and (pointer: coarse) {
  .seg-btn { min-height: 44px; padding: 0 14px; }
  .icon-btn { width: 44px; height: 44px; }
  .fchip { min-height: 44px; padding: 0 14px; }
  .filter-toggle { min-height: 44px; }
}

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
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
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

/* 窄屏：工具条与筛选折行；周/月视图内部自己按 1024 / 640 换形态 */
@media (max-width: 1024px) {
  .tasks-view { padding: 16px 14px 32px; }
  .page-head { flex-wrap: wrap; }
  .running-bar { flex-wrap: wrap; }
  .running-bar .hint { margin-left: 0; }
  .toolbar { flex-wrap: wrap; }
  .filter-row { flex-direction: column; gap: 4px; }
  .date-label { min-width: auto; }
}
</style>
