<template>
  <!-- 首页看板：日期 + 问候 + 可编辑模块列表（加 / 删 / 改 / 拖都由用户自己定） -->
  <div ref="boardEl" class="board" :style="{ '--board-cols': store.board.columns }">
    <div class="board-cq">
      <div class="board-inner">
        <div class="board-date">{{ dateLine }}</div>
        <header class="board-hero">
          <div class="board-hero-text">
            <h2 class="board-greeting">{{ greeting }}</h2>
            <p class="muted board-sub">
              库中已有 <strong>{{ stats.pages }}</strong> 个页面、<strong>{{ stats.files }}</strong> 份原始资料
            </p>
          </div>
          <button
            class="layout-btn"
            type="button"
            :class="{ on: store.editing }"
            :aria-pressed="store.editing"
            v-tooltip="store.editing ? '退出编辑' : '编辑首页：加模块、删模块、拖动排序'"
            @click="store.setEditing(!store.editing)"
          >
            <Icon :name="store.editing ? 'check' : 'settings'" :size="14" />
            <span>{{ store.editing ? '完成' : '编辑首页' }}</span>
          </button>
        </header>

    <!-- 编辑态工具条：整页列数 + 加模块 / 恢复默认 -->
    <div v-if="store.editing" class="manage-bar">
      <div class="cols" role="group" aria-label="整页列数">
        <span class="cols-label">整页列数</span>
        <button
          v-for="count in HOME_BOARD_COLUMNS"
          :key="count"
          class="cols-btn"
          type="button"
          :class="{ on: count === store.board.columns }"
          :aria-pressed="count === store.board.columns"
          v-tooltip="`${count} 列栅格：模块按自己的格数占位（窄屏会自动少排几列）`"
          @click="store.setBoardColumns(count)"
        >{{ count }}</button>
      </div>
      <span class="manage-hint">拖手柄或按左右方向键排序；底栏可改宽度、改名、删除</span>
      <div class="manage-spacer" />
      <button class="manage-btn primary" type="button" :disabled="store.board.modules.length >= MAX_MODULES" @click="toggleAdd">
        <Icon name="plus" :size="14" /><span>添加模块</span>
      </button>
      <button class="manage-btn" type="button" @click="onReset">恢复默认</button>
    </div>

    <!-- 模块面板：选类型 → 追加到末尾（面板留着，可连续加） -->
    <div v-if="store.editing && addOpen" class="add-panel">
      <button
        v-for="meta in MODULE_META"
        :key="meta.kind"
        class="add-item"
        type="button"
        :disabled="store.board.modules.length >= MAX_MODULES"
        @click="onAdd(meta.kind)"
      >
        <span class="add-icon"><Icon :name="meta.icon" :size="16" /></span>
        <span class="add-text"><strong>{{ meta.title }}</strong><em>{{ meta.hint }}</em></span>
      </button>
    </div>

    <div v-if="store.board.modules.length" class="board-grid">
      <div
        v-for="entry in boardModules"
        :key="entry.module.id"
        class="widget"
        :class="`span-${entry.module.span}`"
        :data-module-id="entry.module.id"
        tabindex="-1"
      >
        <HomeModuleShell
          :kind="entry.module.kind"
          :title="entry.title"
          :span="entry.module.span"
          :columns="store.board.columns"
          :limit="entry.hasLimit ? entry.limit : undefined"
          :managing="store.editing"
          :dragging="dragId === entry.module.id"
          :drop-before="dropAnchor?.id === entry.module.id && dropAnchor.before"
          :drop-after="dropAnchor?.id === entry.module.id && !dropAnchor.before"
          @remove="onRemove(entry.module)"
          @rename="onRename(entry.module)"
          @set-span="(span) => store.update(entry.module.id, { span })"
          @set-opt="(key, value) => store.update(entry.module.id, { opts: { ...entry.module.opts, [key]: value } })"
          @move="(delta) => onMove(entry.module, delta)"
          @drag-request="startDragFromGrip($event, entry.module.id, entry.index)"
        >
          <HomeCapture v-if="entry.module.kind === 'capture'" :submit="onIdea" />
          <HomeShortcuts v-else-if="entry.module.kind === 'shortcuts'" :agent-name="agentName" @go="go" @chat="onChat" />
          <HomeRecent v-else-if="entry.module.kind === 'recent'" :items="recentItems" :limit="entry.limit" @go="go" />
          <HomeNotes v-else-if="entry.module.kind === 'notes'" :items="ideaItems" :limit="entry.limit" @go="go" @capture="quickNote" />
          <HomeTasks
            v-else-if="entry.module.kind === 'tasks'"
            :cards="taskCards"
            :limit="entry.limit"
            :loading="tasksLoading"
            @go="go"
          />
          <HomeFresh v-else-if="entry.module.kind === 'fresh'" :items="freshItems" :limit="entry.limit" @go="go" />
          <HomeStats v-else-if="entry.module.kind === 'stats'" :pages="stats.pages" :counts="counts" :words="words" @go="go" />
          <HomeWeekly v-else-if="entry.module.kind === 'weekly'" :rows="weeklyRows" :days="7" @go="go" />
          <HomeTags v-else-if="entry.module.kind === 'tags'" :tags="tagList" @go="go" />
          <HomeSections v-else-if="entry.module.kind === 'sections'" :entries="sections" @go="go" />
          <HomeRoam v-else-if="entry.module.kind === 'roam'" :pages="roamCandidates" @go="go" @capture="quickNote" />
          <HomeSystem v-else-if="entry.module.kind === 'system'" :counts="counts" :agent-name="agentName" @go="go" />
          <HomeRing v-else-if="entry.module.kind === 'ring'" :pages="props.pages" :files="props.fileCount" @go="go" />
          <HomeHeat v-else-if="entry.module.kind === 'heat'" :pages="props.pages" :weeks="entry.limit" />
          <HomeInbox v-else-if="entry.module.kind === 'inbox'" @go="go" />
          <HomeQueue v-else-if="entry.module.kind === 'queue'" :pages="props.pages" :limit="4" @go="go" />
          <HomeBoardCard v-else-if="entry.module.kind === 'board'" :board="tasks.board" :loading="tasksLoading" @go="go" />
          <HomeActivity v-else-if="entry.module.kind === 'activity'" :items="changeLogItems" :limit="entry.limit" @go="go" />
          <HomeDigest v-else-if="entry.module.kind === 'digest'" :lines="digestLines" :agent-name="agentName" @go="go" @chat="onChat" />
          <HomeSync v-else />
        </HomeModuleShell>
      </div>
    </div>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { confirmDialog, promptDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import Icon from './Icon.vue';
import HomeModuleShell from './HomeModuleShell.vue';
import HomeCapture from './HomeBoardModules/HomeCapture.vue';
import HomeShortcuts from './HomeBoardModules/HomeShortcuts.vue';
import HomeRecent from './HomeBoardModules/HomeRecent.vue';
import HomeNotes from './HomeBoardModules/HomeNotes.vue';
import HomeTasks from './HomeBoardModules/HomeTasks.vue';
import HomeFresh from './HomeBoardModules/HomeFresh.vue';
import HomeStats from './HomeBoardModules/HomeStats.vue';
import HomeWeekly from './HomeBoardModules/HomeWeekly.vue';
import HomeTags from './HomeBoardModules/HomeTags.vue';
import HomeSections from './HomeBoardModules/HomeSections.vue';
import HomeRoam from './HomeBoardModules/HomeRoam.vue';
import HomeSystem from './HomeBoardModules/HomeSystem.vue';
import HomeRing from './HomeBoardModules/HomeRing.vue';
import HomeHeat from './HomeBoardModules/HomeHeat.vue';
import HomeInbox from './HomeBoardModules/HomeInbox.vue';
import HomeQueue from './HomeBoardModules/HomeQueue.vue';
import HomeBoardCard from './HomeBoardModules/HomeBoardSnapshot.vue';
import HomeActivity from './HomeBoardModules/HomeActivity.vue';
import HomeDigest from './HomeBoardModules/HomeDigest.vue';
import HomeSync from './HomeBoardModules/HomeSync.vue';
import { useHomeBoardStore } from '../stores/homeBoard';
import { useTasksStore } from '../stores/tasks';
import { useInboxStore } from '../stores/inbox';
import {
  DEFAULT_LIMIT,
  HOME_BOARD_COLUMNS,
  MAX_MODULES,
  MODULE_META,
  freshPagesOf,
  homeDigest,
  kbCounts,
  limitOf,
  moduleMeta,
  recentPagesOf,
  roamPool,
  sectionEntries,
  tagCounts,
  upcomingTasks,
  weeklyStats,
  type HomeModule,
  type ModuleKind,
} from '../lib/homeBoard.ts';
import { homeDateLine, homeGreeting } from '../lib/homeBoardData.ts';
import { boardView, filterCards, EMPTY_FILTER } from '../lib/taskBoard.ts';

/** 各列表类模块的条数上限（与 lib/homeBoard.ts 的归一口径一致；heat 的「条数」是周数） */
const LIMIT_MAX: Record<string, number> = { recent: 12, notes: 12, fresh: 12, tasks: 20, heat: 12 };

const props = defineProps<{
  /** 全部页面（已按更新时间倒序） */
  pages: any[];
  /** 原始资料份数 */
  fileCount: number;
  /** 「原始资料」整棵树的文件路径（分区导航计数用，可为空） */
  rawPaths: string[];
  /** 最近更新：只含 Wiki 非归档页与灵感碎片 */
  recentItems: any[];
  /** 近期灵感：只含灵感碎片 */
  ideaItems: any[];
  agentName: string;
  /**
   * 灵感落盘回调：请求由上层（编辑页）发出，返回是否成功。
   * 用回调 prop 而不是 emit——Vue 的 emit 返回值是 void，拿不到「成没成功」这个结果。
   */
  onIdea?: (content: string) => Promise<boolean>;
}>();

const emit = defineEmits<{
  (e: 'go', path: string): void;
  (e: 'chat'): void;
  (e: 'note'): void;
}>();

const store = useHomeBoardStore();
const tasks = useTasksStore();
const inbox = useInboxStore();

const boardEl = ref<HTMLElement>();
const dateLine = computed(() => homeDateLine());
const greeting = computed(() => homeGreeting());
const stats = computed(() => ({ pages: (props.pages || []).length, files: props.fileCount || 0 }));
const counts = computed(() => kbCounts(props.pages, props.fileCount));
const sections = computed(() => sectionEntries(props.pages, props.rawPaths));
const tasksLoading = computed(() => !tasks.board);
/** 全库字数（「知识库概览」与「运行状态」共用） */
const words = computed(() =>
  (props.pages || []).reduce((sum, page) => sum + Math.max(0, Number(page?.word_count) || 0), 0)
);
/** 本周新增（最近 7 天创建的页面） */
const freshItems = computed(() => freshPagesOf(props.pages, 7));
/** 本周动态：最近 7 天的新增 / 改动 / 字数，按分区归类（空的分类不画） */
const weeklyRows = computed(() => weeklyStats(props.pages, 7));
/** 随机漫游的候选池（组件自己从里面挑一篇，「换一个」不重渲染整页） */
const roamCandidates = computed(() => roamPool(props.pages));
/** 常用标签：库里出现最多的前 12 个 */
const tagList = computed(() => tagCounts(props.pages, 12));
/** 「最近改动」用同一批数据，观感是时间线（点 + 竖线） */
const changeLogItems = computed(() => recentPagesOf(props.pages));
/** 「Agent 摘要」：库存量 + 近 7 天动静 + 待办与收集箱，本地拼句，不调模型 */
const digestLines = computed(() =>
  homeDigest({
    pages: props.pages,
    files: props.fileCount,
    taskCount: taskCards.value.length,
    inboxPending: Number(inbox.counts.pending || 0),
  })
);

/** 近期待办：与旧欢迎页同一口径（逾期 → 窗口内日期 → 周期 → 待定），条数由模块选项决定 */
const taskCards = computed(() => {
  if (!tasks.board) return [];
  const cards = filterCards(tasks.board, EMPTY_FILTER);
  const view = boardView(cards, { start: tasks.windowStart, end: tasks.windowEnd });
  return upcomingTasks(view.day, 20);
});

function titleOf(module: HomeModule): string {
  return module.title || moduleMeta(module.kind).title;
}

/**
 * 模板用的模块视图：把「标题、条数」这类每帧要用的值一次算好。
 * hasLimit 说明这块模块有没有「显示 N 条」这一项（没有就不画步进器）。
 */
const boardModules = computed(() =>
  store.board.modules.map((module, index) => {
    const max = LIMIT_MAX[module.kind] || 0;
    const hasLimit = max > 0;
    const fallback = DEFAULT_LIMIT[module.kind] || 6;
    return {
      module,
      index,
      title: titleOf(module),
      hasLimit,
      limit: hasLimit ? limitOf(module.opts, fallback, max) : 0,
    };
  })
);

/* ===== 加模块 ===== */
const addOpen = ref(false);
function openAdd() {
  store.setEditing(true);
  addOpen.value = true;
}
function toggleAdd() {
  addOpen.value = !addOpen.value;
}
function onAdd(kind: ModuleKind) {
  if (!store.add(kind)) {
    notify.info(`首页最多 ${MAX_MODULES} 块模块`);
    return;
  }
  // 新模块落在末尾：下一帧把它滚进视野，否则「点了没反应」
  void nextTick(() => {
    const last = store.board.modules.at(-1);
    if (!last) return;
    boardEl.value
      ?.querySelector(`[data-module-id="${last.id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/* ===== 删除 / 改名 / 恢复默认 ===== */
async function onRemove(module: HomeModule) {
  const ok = await confirmDialog({
    title: `删除「${titleOf(module)}」？`,
    message: '只从首页移除这块模块，知识库内容不受影响。',
    confirmText: '删除',
    danger: true,
  });
  if (ok) store.remove(module.id);
}

async function onRename(module: HomeModule) {
  const current = module.title || moduleMeta(module.kind).title;
  const next = await promptDialog({
    title: '模块标题',
    message: '留空恢复默认标题：',
    value: current,
    confirmText: '保存',
  });
  if (next === null) return;
  const text = next.trim();
  store.update(module.id, { title: text });
  // 空标题 = 回到类型默认名：同时清掉「改过名」的标记（预览里显示的才是真名）
  if (!text) store.update(module.id, { opts: { ...module.opts, custom: false } });
}

async function onReset() {
  const ok = await confirmDialog({
    title: '恢复默认首页布局？',
    message: '当前模块的顺序、宽度、标题与删除记录都会被重置。',
    confirmText: '恢复默认',
    danger: true,
  });
  if (ok) store.resetToDefault();
}

/* ===== 模块内容回调 ===== */
/** 速记模块把内容递上来（它自己发请求与显示错误）；落盘由上层回调完成 */
async function onIdea(content: string): Promise<boolean> {
  return (await props.onIdea?.(content)) ?? false;
}
function go(path: string) {
  emit('go', path);
}
function onChat() {
  emit('chat');
}
function quickNote() {
  emit('note');
}

/* ===== 拖动排序（指针事件：鼠标与手指同一套，HTML5 拖放触屏不可用） ===== */
const dragId = ref('');
/** 落点线画在哪一格、哪一侧（用它而不是下标：下标是「拔掉源之后」的最终位置，与格子对不上） */
const dropAnchor = ref<{ id: string; before: boolean } | null>(null);
/** 拖拽当下的落位下标（-1 = 不在任何格子上，松手不写盘） */
const dropIndex = ref(-1);

const DRAG_THRESHOLD = 5;
let pending: { id: string; index: number; x: number; y: number } | null = null;
let dragging = false;

/** 手柄按下：先只记位置，越过阈值才算拖（避免点一下手柄就进拖拽态） */
function startDragFromGrip(event: PointerEvent, id: string, index: number) {
  if (!store.editing || event.button !== 0) return;
  pending = { id, index, x: event.clientX, y: event.clientY };
  dragging = false;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(event: PointerEvent) {
  if (!pending) return;
  if (!dragging) {
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < DRAG_THRESHOLD) return;
    dragging = true;
    dragId.value = pending.id;
    // 起手时先显示原位落点，指针一动就有反馈
    dropAnchor.value = { id: pending.id, before: true };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }
  event.preventDefault();
  computeDrop(event.clientX, event.clientY);
}

/**
 * 指针落在哪一格上：取「最近的一格」，以它的横向中线为界——左边插到它前面、右边插到它后面。
 * 同时算出最终落位下标（见 targetToIndex）与**落点线该画在哪一格**（dropAnchor）。
 * 两者分开：落位下标是「拔掉源之后」的数组位置，拿它去和「拔掉之前的格子下标」比会偏一格。
 */
function computeDrop(x: number, y: number) {
  const root = boardEl.value;
  const modules = store.board.modules;
  const fromIndex = modules.findIndex((m) => m.id === dragId.value);
  if (!root || fromIndex < 0) return;
  let best: { index: number; id: string; before: boolean; distance: number } | null = null;
  for (const [index, module] of modules.entries()) {
    if (index === fromIndex) continue;
    const el = root.querySelector(`[data-module-id="${module.id}"]`) as HTMLElement | null;
    if (!el) continue;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // 距离用平方值比（纵向压 0.6 的权重：一行一行往下拖时更容易落在正下方那一格）
    const distance = (x - cx) ** 2 + (y - cy) ** 2 * 0.6;
    if (!best || distance < best.distance) {
      best = { index, id: module.id, before: x < cx, distance };
    }
  }
  if (!best) {
    // 指针离开所有格子（拖到看板外面）：线收在自己原位，松手等于没动
    dropIndex.value = -1;
    dropAnchor.value = pending ? { id: pending.id, before: true } : null;
    return;
  }
  dropIndex.value = targetToIndex(fromIndex, best.index, best.before);
  dropAnchor.value = { id: best.id, before: best.before };
}

/**
 * 落点 → 最终数组下标。
 * 与 lib/homeBoard.ts 的 dropTargetIndex 同一口径，但界面上多一层「落点是某一格」的语义，
 * 所以这里把「插到该格前 / 后」先翻译成指针位置，再交给同一个函数，保证拖动结果可整体推理。
 */
function targetToIndex(fromIndex: number, targetIndex: number, before: boolean): number {
  if (before) return fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  return fromIndex < targetIndex ? targetIndex : targetIndex + 1;
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  const id = dragId.value;
  const at = dropIndex.value;
  pending = null;
  if (dragging && id && at >= 0) {
    const from = store.board.modules.findIndex((m) => m.id === id);
    if (from !== at) {
      store.move(id, at);
      // 焦点跟着模块走：拖完还想微调时，手柄上按左右键就能继续（别让焦点留在被移动的那个节点上）
      void nextTick(() => {
        (boardEl.value?.querySelector(`[data-module-id="${id}"] .tool`) as HTMLElement | null)?.focus?.();
      });
    }
  }
  dragging = false;
  dragId.value = '';
  dropIndex.value = -1;
  dropAnchor.value = null;
}

/** 键盘排序：底栏 ▲▼ 或手柄上的左右方向键（触屏与视障用户的等价入口） */
function onMove(module: HomeModule, delta: number) {
  const index = store.board.modules.findIndex((m) => m.id === module.id);
  if (index < 0) return;
  const at = index + delta;
  if (at < 0 || at >= store.board.modules.length) return;
  store.move(module.id, at);
  // 焦点还给手柄自己：键盘用户按完一次还能接着按（焦点跑到容器上就断了）
  void nextTick(() => {
    (boardEl.value?.querySelector(`[data-module-id="${module.id}"] .tool`) as HTMLElement | null)?.focus?.();
  });
}

/* ===== 键盘：Esc 退出编辑态；←/→ 给「当前聚焦的手柄」换位 =====
   Esc 在应用里已经有多处用途（弹窗、侧栏满窗、编辑器全屏），这里只认「编辑态 + 没被上层拦掉」，
   别的场景一律放行；退出编辑时顺手把添加面板收掉，避免下一次进来还挂着。
   方向键只在焦点真的落在某个手柄上时才接管（判 data-module-id 的祖先），否则放行给别的组件。 */
function onBoardKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.defaultPrevented && store.editing) {
    addOpen.value = false;
    store.setEditing(false);
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (event.defaultPrevented || !store.editing) return;
  // 只认落在手柄上的那一次：别处在用方向键的组件（编辑器、下拉选择…）不受影响
  const target = event.target as HTMLElement | null;
  if (!target?.classList?.contains('tool')) return;
  const id = target.closest('[data-module-id]')?.getAttribute('data-module-id');
  if (!id) return;
  const module = store.board.modules.find((m) => m.id === id);
  if (!module) return;
  event.preventDefault();
  onMove(module, event.key === 'ArrowLeft' ? -1 : 1);
}
onMounted(() => window.addEventListener('keydown', onBoardKey));

onUnmounted(() => {
  window.removeEventListener('keydown', onBoardKey);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});
</script>

<style scoped>
/*
 * 首页看板整页可滚：内容比一屏高时从顶上开始（居中只用 auto 外边距——
 * flex 的 align-items: center 在溢出时会吃掉顶部一截，安卓上实测够不着；
 * 2026-10-01 的「首页显示不全」就是这么来的）。
 */
.board {
  height: 100%;
  display: flex;
  overflow-y: auto;
}
/*
 * 容器查询的宿主：整页可滚容器是 .board，居中则由 .board-inner 的 auto 外边距负责，
 * 所以中间再垫一层。它只做一件事——把「正文实际有多宽」暴露给下面的 @container 规则
 * （侧栏展开、Agent 悬浮卡打开都会改这个宽度，媒体查询看不到）。
 */
.board-cq {
  container-type: inline-size;
  width: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
/* 上下 auto 之外，.board-inner 原有的 margin: auto 也把左右留白一起管了 */
.board-cq > .board-inner { margin-top: auto; margin-bottom: auto; }
/*
 * 内容宽度跟着整页列数走：与栅格的 248px 列宽同源（见 .board-grid 的注释），
 * 5 列时页宽上限 = 5×248 + 4×18 + 88 = 1400px，4 列 1134px，下不低 960px。
 */
.board-inner {
  margin: auto;
  width: 100%;
  max-width: max(960px, calc(var(--board-cols, 4) * 248px + (var(--board-cols, 4) - 1) * 18px + 88px));
  padding: 40px 44px 64px;
}

.board-date {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--text-faint);
}
.board-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin: 6px 0 22px;
}
.board-hero-text { min-width: 0; }
.board-greeting { font-size: 30px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; }
.board-sub { margin-top: 6px; font-size: 13.5px; }
.board-sub strong { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

.layout-btn {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
  transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
}
.layout-btn:hover { border-color: var(--accent); color: var(--accent); }
.layout-btn.on { border-color: transparent; background: var(--accent-soft); color: var(--accent); }
.layout-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* 编辑态工具条 */
.manage-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}
.manage-hint { font-size: 12px; color: var(--text-faint); }
.manage-spacer { flex: 1; }

/* 整页列数：2–5，当前档高亮（与底栏的宽度档同一套观感） */
.cols {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
}
.cols-label { margin-right: 6px; font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.cols-btn {
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--text-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  transition: background 150ms ease, color 150ms ease;
}
.cols-btn:hover { color: var(--text-secondary); background: var(--sidebar-hover); }
.cols-btn.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.cols-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.manage-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12.5px;
  transition: border-color 150ms ease, color 150ms ease;
}
.manage-btn:hover { border-color: var(--accent); color: var(--accent); }
.manage-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.manage-btn.primary { border-color: transparent; background: var(--accent); color: #fff; }
.manage-btn.primary:hover { color: #fff; filter: brightness(1.05); }
.manage-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 添加模块面板：两列类型卡，点一下追加一块 */
.add-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
}
.add-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
}
.add-item:hover { border-color: var(--accent); background: var(--card-bg); }
.add-item:disabled { opacity: 0.5; cursor: not-allowed; }
.add-icon {
  width: 30px;
  height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}
.add-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.add-text strong { font-size: 12.5px; font-weight: 600; color: var(--text); }
.add-text em {
  font-style: normal;
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 模块栅格：基准 4 列，三档宽度就是 1/4 · 1/2 · 整行（span 1 / 2 / 3）。
 *
 * 为什么不用 `repeat(auto-fit, minmax(248px, 1fr))`（2026-10-06 浏览器实测）：
 * auto-fit 的列数由「所有条目里最大的 span」决定，span-2 占 4 份时 1046px 只放得下 2 列，
 * 列宽被拉到 514px，span-2 反而撑满整行——「半行」与「整行」看起来一模一样。
 * 固定列 + span 1/2/全行（下表 B 方案）实测：1046px 里 4 列各 248px，
 * span-1 = 248px（1/4）、span-2 = 514px（1/2）、span-3 = 1046px（整行），三档都成立。
 * 页宽上限与 248px 同源（见 .board-inner），所以「整页列数」改的就是这一页的栏位预算。
 *
 * 窄屏按容器宽度降级：并排两块塞不下时不再并排（每档都先保证「两格」放得下）。
 */
.board-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-flow: row;
  grid-auto-rows: min-content;
  gap: 18px;
  align-items: start;
}
.widget { min-width: 0; }
.widget.span-1 { grid-column: span 1; }
.widget.span-2 { grid-column: span 2; }
.widget.span-3 { grid-column: 1 / -1; }
/* 手改 JSON 时可能出现 span 4/5：一律整行，别让浏览器自己猜 */
.widget.span-4,
.widget.span-5 { grid-column: 1 / -1; }

/* 3 列档（约 740-990px 正文）：span-2 还是半行，span-3 仍是整行 */
@container (max-width: 990px) {
  .board-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .widget.span-2 { grid-column: span 2; }
}
/* 2 列档（约 430-740px）：半行 = 1 格，整行不并排 */
@container (max-width: 740px) {
  .board-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .widget.span-2 { grid-column: span 1; }
  .widget.span-3 { grid-column: 1 / -1; }
}
/* 单列档（手机 / 极窄正文） */
@container (max-width: 430px) {
  .board-grid { grid-template-columns: minmax(0, 1fr); }
  .widget.span-1,
  .widget.span-2,
  .widget.span-3 { grid-column: 1 / -1; }
}

.board-empty { padding: 28px 24px; text-align: center; }
.board-empty-title { font-size: 15px; font-weight: 600; }
.board-empty-sub { margin-top: 6px; font-size: 12.5px; }
.board-empty-actions { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }

.board-tip {
  margin-top: 26px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.7;
}

@media (max-width: 1024px) {
  .board-inner { padding: 32px 24px 56px; max-width: 100%; }
  .board-hero { align-items: flex-start; flex-direction: column; gap: 12px; }
}
@media (max-width: 768px) {
  .board-greeting { font-size: 24px; }
  .add-panel { grid-template-columns: 1fr; }
  .manage-bar { flex-wrap: wrap; }
  .manage-hint { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .layout-btn,
  .manage-btn,
  .add-item { transition-duration: 0.01ms; }
}
</style>