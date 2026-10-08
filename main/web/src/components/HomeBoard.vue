<template>
  <!-- 首页看板：日期 + 问候 + 可编辑模块列表（加 / 删 / 改 / 拖都由用户自己定） -->
  <div
    ref="boardEl"
    class="board"
    :class="{ 'editing-board': store.editing }"
    :style="{ '--board-cols': displayColumns, '--grid-row-h': `${unit}px` }"
  >
    <div class="board-cq">
      <div class="board-inner">
        <div class="board-date">{{ dateLine }} · ENGRAM</div>
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

    <!-- 编辑态工具条：加模块 / 排整齐 / 紧凑 / 恢复默认 -->
    <div v-if="store.editing" class="manage-bar">
      <span class="manage-hint">
        拖动卡片 = 换位置；拖右下角 = 改大小；方向键微调、Shift+方向键改尺寸。窄窗口编辑时可横向滚动。
      </span>
      <div class="manage-spacer" />
      <button class="manage-btn" type="button" :disabled="!store.history.length" @click="store.undo()">撤销</button>
      <button class="manage-btn" type="button" title="把卡片往上收，消掉中间的空洞" @click="store.compact()">
        <Icon name="merge" :size="14" /><span>紧凑</span>
      </button>
      <button class="manage-btn" type="button" title="按当前顺序从左到右、从上到下重排一遍" @click="store.autoArrange()">
        <Icon name="refresh" :size="14" /><span>排整齐</span>
      </button>
      <button class="manage-btn primary" type="button" :disabled="store.board.modules.length >= MAX_MODULES" @click="toggleAdd">
        <Icon name="plus" :size="14" /><span>添加模块</span>
      </button>
      <button class="manage-btn" type="button" @click="onReset">恢复默认</button>
    </div>

    <!-- 模块面板：选类型 → 放进第一个空位（面板留着，可连续加） -->
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

    <!--
      栅格看板（2026-10-07「手机桌面」模式）：固定 12 列 × N 行的 CSS Grid（列数见 lib/homeGrid.ts 的 GRID_COLS），
      每张卡用自己的 col/row/w/h 直接落在格子上（位置数据在 lib/homeBoard.ts + lib/homeGrid.ts）。
      拖动 = 改起点、拖右下角 = 改宽高，两者都吸附到格；碰撞由 placeItem 让位，所以不会叠、不会飞出页面。
    -->
    <div
      v-if="store.board.modules.length"
      ref="gridEl"
      class="board-grid"
      :class="{ editing: store.editing }"
      :style="{ '--grid-rows': gridRows }"
    >
      <div
        v-for="entry in boardModules"
        :key="entry.module.id"
        class="widget"
        :class="[{ dragging: dragId === entry.module.id }, entry.module.w >= 6 ? 'wide' : '']"
        :style="{
          gridColumn: `${entry.place.col + 1} / span ${entry.place.w}`,
          gridRow: `${entry.place.row + 1} / span ${entry.place.h}`,
          transform: dragId === entry.module.id && gestureMode === 'move' ? `translate(${ghost.x}px, ${ghost.y}px)` : undefined,
        }"
        :data-module-id="entry.module.id"
        tabindex="-1"
      >
        <HomeModuleShell
          :kind="entry.module.kind"
          :title="entry.title"
          :width="entry.place.w"
          :height="entry.place.h"
          :capture-style="Number(entry.module.opts.captureStyle) || 2"
          :limit="entry.hasLimit ? entry.limit : undefined"
          :managing="store.editing"
          :dragging="dragId === entry.module.id"
          :target="dragId === entry.module.id"
          :summary="summaryOf(entry.module)"
          @activate="activateSummary"
          @remove="onRemove(entry.module)"
          @rename="onRename(entry.module)"
          @set-size="(width, height) => store.place(entry.module.id, { ...entry.module, w: width, h: height })"
          @set-opt="(key, value) => store.update(entry.module.id, { opts: { ...entry.module.opts, [key]: value } })"
          @drag-request="startDrag($event, entry.module.id)"
          @resize-request="startResize($event, entry.module.id)"
          v-slot="{ expanded }"
        >
          <HomeCapture v-if="entry.module.kind === 'capture'" :submit="onIdea" :variant="Number(entry.module.opts.captureStyle) || 2" :single-row="entry.module.h === 1 && !expanded" :ideas="ideaItems" />
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
          <HomeQueue v-else-if="entry.module.kind === 'queue'" :files="rawFiles" :loading="queueLoading" :error="queueError" :limit="12" @go="go" />
          <HomeBoardCard v-else-if="entry.module.kind === 'board'" :board="tasks.board" :loading="tasksLoading" @go="go" />
          <HomeActivity v-else-if="entry.module.kind === 'activity'" :items="changeLogItems" :limit="entry.limit" @go="go" />
          <HomeDigest v-else-if="entry.module.kind === 'digest'" :lines="digestLines" :agent-name="agentName" @go="go" @chat="onChat" />
          <HomeSync v-else />
        </HomeModuleShell>
      </div>

      <!-- 拖动时的高亮落点：直接画在栅格上（用户看到的就是松手后卡片的位置） -->
      <div
        v-if="targetPreview"
        class="drop-cell"
        :style="{
          gridColumn: `${targetPreview.col + 1} / span ${targetPreview.w}`,
          gridRow: `${targetPreview.row + 1} / span ${targetPreview.h}`,
        }"
        aria-hidden="true"
      />
    </div>
    <div v-else class="board-empty"><p class="board-empty-title">把首页变成你的工作台</p><p class="board-empty-sub">添加常用卡片，从一条灵感开始。</p><button class="manage-btn primary" type="button" @click="openAdd">添加卡片</button></div>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
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
import { useSyncStore } from '../stores/sync';
import {
  DEFAULT_LIMIT,
  HOME_BOARD_COLUMNS,
  MAX_MODULES,
  MODULE_META,
  freshPagesOf,
  homeDigest,
  moveModuleTo,
  kbCounts,
  limitOf,
  moduleMeta,
  moveModuleBy,
  recentPagesOf,
  resizeModuleBy,
  roamPool,
  sectionEntries,
  tagCounts,
  upcomingTasks,
  weeklyStats,
  type HomeModule,
  type HomeBoard,
  type ModuleKind,
} from '../lib/homeBoard.ts';
import { homeDateLine, homeGreeting } from '../lib/homeBoardData.ts';
import {
  GRID_COLS,
  normalizePlace,
  placeItem,
  usedRows,
  viewportColumns,
  viewportPlaces,
  type GridPlace,
} from '../lib/homeGrid.ts';
import { boardView, filterCards, EMPTY_FILTER } from '../lib/taskBoard.ts';
import { pendingDistillOf, pendingDistillLabel, rawMaterialRoute, ratioRows } from '../lib/homeBoard.ts';
import type { HomeCardSummary, HomeCardRow } from '../lib/homeCardPresentation.ts';
import { useAppStore } from '../stores/app';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { api } from '../api';
import { syncStatusView, formatSyncTime } from '../lib/syncStatus.ts';
import { APP_VERSION } from '../version.ts';

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

/** 侧栏接口已经携带真实账本状态；只在首页放了待提炼卡时读取，所有实例共用一份。 */
const rawFiles = ref<any[]>([]);
const queueLoading = ref(false);
const queueError = ref('');
const hasQueue = computed(() => store.board.modules.some((module) => module.kind === 'queue'));
async function refreshQueue() {
  if (!hasQueue.value || queueLoading.value || document.hidden) return;
  queueLoading.value = true;
  try {
    const { data } = await api.get('/api/files/list', { params: { dir: '原始资料' } });
    rawFiles.value = Array.isArray(data.files) ? data.files : [];
    queueError.value = '';
  } catch {
    queueError.value = rawFiles.value.length ? '刷新失败，显示上次清单' : '待提炼清单读取失败，稍后重试';
  } finally {
    queueLoading.value = false;
  }
}
watch([hasQueue, () => props.pages, () => props.fileCount], () => { void refreshQueue(); }, { immediate: true });
let queueTimer: ReturnType<typeof setInterval> | undefined;

const boardEl = ref<HTMLElement>();
const gridEl = ref<HTMLElement>();
const dateLine = computed(() => homeDateLine());
const greeting = computed(() => homeGreeting());
const stats = computed(() => ({ pages: (props.pages || []).length, files: props.fileCount || 0 }));
const counts = computed(() => kbCounts(props.pages, props.fileCount));
const sections = computed(() => sectionEntries(props.pages, props.rawPaths));
const tasksLoading = computed(() => tasks.loading && !tasks.board);
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
/** 逾期件数：待办卡的角标（「2 逾期」），没有逾期不显示 */
const overdueCount = computed(() => {
  if (!tasks.board) return 0;
  const cards = filterCards(tasks.board, EMPTY_FILTER);
  const view = boardView(cards, { start: tasks.windowStart, end: tasks.windowEnd });
  return view.day.filter((b) => b.bucket === 'overdue').reduce((n, b) => n + b.cards.length, 0);
});

function titleOf(module: HomeModule): string {
  return module.title || moduleMeta(module.kind).title;
}

/**
 * 模板用的模块视图：把「标题、条数」这类每帧要用的值一次算好。
 * hasLimit 说明这块模块有没有「显示 N 条」这一项（没有就不画步进器）。
 */
const boardModules = computed(() =>
  (previewBoard.value || store.board).modules.map((module, index) => {
    const max = LIMIT_MAX[module.kind] || 0;
    const hasLimit = max > 0;
    const fallback = DEFAULT_LIMIT[module.kind] || 6;
    return {
      module: dragId.value === module.id && gestureMode.value === 'move' ? { ...module, ...gesture!.origin } : module,
      place: dragId.value === module.id && gestureMode.value === 'move' ? gesture!.origin : displayPlaces.value[index],
      index,
      title: titleOf(module),
      hasLimit,
      limit: hasLimit ? limitOf(module.opts, fallback, max) : 0,
    };
  })
);

const sync = useSyncStore();
const app = useAppStore();
const { capabilities } = useRuntimeCapabilities();
function activateSummary(row: HomeCardRow) { if (row.action === 'chat') onChat(); else if (row.action === 'capture') quickNote(); else if (row.path) go(row.path); }
function summaryOf(module: HomeModule): HomeCardSummary {
  const rowsOf = (list: any[], max = 12): HomeCardRow[] => list.slice(0,max).map(p=>({ text:p.title || String(p.path || '').split('/').pop() || '未命名', detail:p.updated_at ? formatSyncTime(p.updated_at) : '', path:p.id ? `/page/${p.id}` : undefined }));
  const pageSummary = (list: any[], empty: string): HomeCardSummary => ({ value:list.length,label:'篇页面',rows:rowsOf(list,limitOf(module.opts,12,20)),empty });
  const facts: HomeCardRow[] = [
    {text:'概念',detail:counts.value.concepts,amount:counts.value.concepts,path:'/search?q=概念'},
    {text:'实体',detail:counts.value.entities,amount:counts.value.entities,path:'/search?q=实体'},
    {text:'资料',detail:counts.value.files,amount:counts.value.files,path:'/search?q=原始资料'},
  ];
  switch (module.kind) {
    case 'capture': return {value:'记灵感',label:'随手一句，稍后整理',action:true,rows:rowsOf(props.ideaItems),empty:'记一条灵感，稍后整理'};
    case 'stats': return {value:stats.value.pages,label:'知识页面',rows:[...facts,{text:'字数',detail:words.value.toLocaleString()}],chart:'bars'};
    case 'ring': { const ratios=ratioRows(props.pages,props.fileCount);return {value:ratios.total,label:'项知识与资料',rows:ratios.rows.map((r,i)=>({...facts[i],detail:`${r.value} · ${Math.round(r.ratio*100)}%`})),chart:'ring'}; }
    case 'tasks': return {value:taskCards.value.length,label:'件待办',badge:overdueCount.value?{tone:'danger',text:`${overdueCount.value} 逾期`}:undefined,rows:taskCards.value.slice(0,limitOf(module.opts,5,20)).map(c=>({text:c.text,detail:c.date || c.when || '待定',path:'/tasks'})),empty:tasksLoading.value?'正在读取任务…':'近期没有待办，打开看板查看'};
    case 'notes': return pageSummary(props.ideaItems,'还没有灵感，记下一条想法');
    case 'recent': return pageSummary(props.recentItems,'还没有最近更新的页面');
    case 'activity': return pageSummary(changeLogItems.value,'近期没有页面改动');
    case 'fresh': return pageSummary(freshItems.value,'最近七天还没有新增页面');
    // 热力卡的摘要只在 1×1 磁贴或窄卡上用：给「本周改动了多少篇」，别让磁贴显示 0
    case 'heat': return {value:weeklyRows.value.reduce((n,r)=>n+r.updated,0),label:'本周改动'};
    case 'weekly': return {value:weeklyRows.value.reduce((n,r)=>n+r.created,0),label:'本周新增',rows:weeklyRows.value.map(r=>({text:r.label,detail:`${r.updated} 更新 · ${r.created} 新增`,amount:r.updated,path:`/search?q=${encodeURIComponent(r.label)}`})),chart:'trend',empty:'本周还没有更新记录'};
    case 'tags': return {value:tagList.value.length,label:'个常用标签',rows:tagList.value.map(r=>({text:r.tag,detail:r.count,path:`/search?q=${encodeURIComponent(r.tag)}`})),empty:'给页面加一个标签，这里就会显示'};
    case 'sections': return {value:sections.value.length,label:'个分区',rows:sections.value.map(r=>({text:r.label,detail:r.count,amount:r.count,path:`/search?q=${encodeURIComponent(r.label)}`})),chart:'bars'};
    case 'shortcuts': return {value:'快捷入口',label:'搜索 · 新建 · 图谱 · Agent',action:true,rows:[{text:'搜索',detail:'知识库',path:'/search'},{text:'新建',detail:'Wiki',path:'/page'},{text:'图谱',detail:'关系',path:'/graph'},{text:'Agent',detail:'对话',action:'chat'},{text:'看板',detail:'任务',path:'/tasks'},{text:'收集',detail:'资料',path:'/inbox'}]};
    case 'roam': return {value:'换一篇',label:`${roamCandidates.value.length} 篇可漫游`,action:true,rows:rowsOf(roamCandidates.value,8),empty:'知识库还没有可漫游的页面'};
    case 'inbox': return {value:Number(inbox.counts.pending || 0),label:'份待整理资料',rows:(inbox.pendingItems || []).slice(0,12).map((item:any)=>({text:String(item.path || '').split('/').pop() || '未命名资料',detail:'待整理',path:'/inbox'})),empty:'收集箱是空的，拖文件进来开始整理'};
    case 'queue': { const candidates=pendingDistillOf(rawFiles.value,rawFiles.value.length);return {value:queueError.value && !rawFiles.value.length ? '—' : queueLoading.value && !rawFiles.value.length ? '…' : candidates.length,label:queueError.value || '份资料等待提炼',rows:candidates.map(file=>({text:file.name,detail:pendingDistillLabel(file),path:rawMaterialRoute(file)})),empty:queueError.value || (queueLoading.value ? '正在读取待提炼资料…' : '没有等待提炼的资料')}; }
    case 'board': return {value:tasks.board ? filterCards(tasks.board,EMPTY_FILTER).length : 0,label:'件任务',rows:(tasks.board?.groups || []).map(g=>({text:g.title,detail:g.cards.length,amount:g.cards.length,path:'/tasks'})),chart:'bars',empty:tasksLoading.value?'正在读取看板…':'暂无看板，打开任务页面生成'};
    case 'digest': return {value:digestLines.value.length,label:props.agentName || 'Agent 摘要',rows:digestLines.value.map(text=>({text,action:'chat'}))};
    case 'system': { const jobs=app.jobs;const failed=Number(jobs?.failed || 0);const runtime=capabilities.value.runtime==='desktop'?'桌面端本地服务':capabilities.value.runtime==='android-local'?'手机本地服务':'服务器 / Docker';return {value:'运行中',label:runtime,status:{tone:failed?'warn':'ok',text:'运行中'},rows:[{text:'版本',detail:APP_VERSION,path:'/settings?section=update'},{text:'模式',detail:capabilities.value.runtime,path:'/settings'},{text:'Agent',detail:props.agentName || '未配置',action:'chat'},{text:'执行',detail:Number(jobs?.running || 0),path:'/settings'},{text:'排队',detail:Number(jobs?.pending || 0),path:'/settings'},{text:'失败',detail:failed,path:'/settings'}]}; }
    case 'sync': { const view=syncStatusView(sync.status,{androidLocal:capabilities.value.runtime==='android-local'});const tone=view?.tone==='warn'?'warn':view?.tone==='muted'||!view?'muted':'ok';return {value:view?.label || '待配置同步',label:view?.detail || '添加成员设备后开始同步',status:{tone,text:view?.label || '待配置同步'},rows:[{text:'状态',detail:view?.label || '未配置',path:'/settings?section=sync'},{text:'详情',detail:view?.detail || '添加成员设备后开始同步',path:'/settings?section=sync'},...(sync.status?.peers || []).map(p=>({text:p.name,detail:p.online?'在线':'离线',path:'/settings?section=sync'})),{text:'排队',detail:Number(sync.status?.pending || 0),path:'/settings?section=sync'}]}; }
  }
}

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
  const ok = (await props.onIdea?.(content)) ?? false;
  if (ok) void refreshQueue();
  return ok;
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

/* ===== 手势预览只在内存里计算；松手保存一次，取消不改变布局 ===== */
const dragId = ref('');
const targetPreview = ref<GridPlace | null>(null);
const previewBoard = ref<HomeBoard | null>(null);
const ghost = ref({ x: 0, y: 0 });
const gestureMode = ref<'move' | 'resize'>('move');
const gridWidth = ref(1000);
const displayColumns = computed(() => store.editing ? GRID_COLS : viewportColumns(gridWidth.value));
const displayPlaces = computed(() => viewportPlaces((previewBoard.value || store.board).modules, displayColumns.value));
const unit = computed(() => Math.max(1, (gridWidth.value - 14 * (displayColumns.value - 1)) / displayColumns.value));
const gridRows = computed(() => Math.max(2, usedRows(displayPlaces.value)));
let gridObserver: ResizeObserver | null = null;
watch(gridEl, (el) => {
  gridObserver?.disconnect();
  if (!el) return;
  gridObserver = new ResizeObserver(([entry]) => { gridWidth.value = entry.contentRect.width; });
  gridObserver.observe(el);
});
let frame = 0;
let gesture: {
  mode: 'move' | 'resize'; id: string; pointer: number;
  startX: number; startY: number; x: number; y: number; scroll: number;
  origin: GridPlace; snapshot: HomeBoard; cell: number; active: boolean;
} | null = null;
function modulePlace(module: HomeModule): GridPlace { return { col: module.col, row: module.row, w: module.w, h: module.h }; }
function startDrag(event: PointerEvent, id: string) { beginGesture(event, id, 'move'); }
function startResize(event: PointerEvent, id: string) { beginGesture(event, id, 'resize'); }
function preventTouchScroll(event: TouchEvent) { if (gesture) event.preventDefault(); }
function beginGesture(event: PointerEvent, id: string, mode: 'move' | 'resize') {
  if (gesture || event.button !== 0) return;
  if (!store.editing && event.pointerType !== 'touch') return;
  // 窄窗口先切回可横向滚动的完整列数编辑画布，下一次拖动再使用稳定坐标。
  if (!store.editing && displayColumns.value < GRID_COLS) { store.setEditing(true); return; }
  const module = store.board.modules.find((m) => m.id === id);
  if (!module) return;
  store.setEditing(true);
  gestureMode.value = mode;
  gesture = { mode, id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY,
    x: event.clientX, y: event.clientY, scroll: boardEl.value?.scrollTop || 0,
    origin: modulePlace(module), snapshot: JSON.parse(JSON.stringify(store.board)), cell: unit.value + 14, active: false };
  window.addEventListener('pointermove', onGestureMove, { passive: false });
  window.addEventListener('pointerup', onGestureEnd);
  window.addEventListener('pointercancel', onGestureEnd);
  window.addEventListener('touchmove', preventTouchScroll, { passive: false });
  event.preventDefault();
}
function updateGesture() {
  frame = 0;
  if (!gesture?.active) return;
  const g = gesture, host = boardEl.value;
  if (host) {
    const box = host.getBoundingClientRect();
    const edge = 54;
    const delta = g.y < box.top + edge ? -Math.min(14, (box.top + edge - g.y) / 4) : g.y > box.bottom - edge ? Math.min(14, (g.y - box.bottom + edge) / 4) : 0;
    if (delta) host.scrollTop += delta;
  }
  const dx = g.x - g.startX, dy = g.y - g.startY + (host?.scrollTop || 0) - g.scroll;
  ghost.value = { x: dx, y: dy };
  const wanted = normalizePlace(g.mode === 'move'
    ? { ...g.origin, col: g.origin.col + Math.round(dx / g.cell), row: g.origin.row + Math.round(dy / g.cell) }
    : { ...g.origin, w: g.origin.w + Math.round(dx / g.cell), h: g.origin.h + Math.round(dy / g.cell) });
  targetPreview.value = wanted;
  previewBoard.value = moveModuleTo(g.snapshot, g.id, wanted);
  frame = requestAnimationFrame(updateGesture);
}
function onGestureMove(event: PointerEvent) {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  gesture.x = event.clientX; gesture.y = event.clientY;
  if (!gesture.active && Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 4) return;
  gesture.active = true; dragId.value = gesture.id;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = gesture.mode === 'resize' ? 'nwse-resize' : 'grabbing';
  event.preventDefault();
  if (!frame) frame = requestAnimationFrame(updateGesture);
}
function onGestureEnd(event?: PointerEvent) {
  if (event && gesture && event.pointerId !== gesture.pointer) return;
  if (gesture?.active && event?.type === 'pointerup') {
    if (frame) cancelAnimationFrame(frame);
    updateGesture();
    if (previewBoard.value) store.commit(previewBoard.value);
  }
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  const id = gesture?.id;
  gesture = null; previewBoard.value = null; targetPreview.value = null; dragId.value = ''; ghost.value = { x: 0, y: 0 };
  document.body.style.userSelect = ''; document.body.style.cursor = '';
  window.removeEventListener('pointermove', onGestureMove); window.removeEventListener('pointerup', onGestureEnd);
  window.removeEventListener('pointercancel', onGestureEnd); window.removeEventListener('touchmove', preventTouchScroll);
  if (id) void nextTick(() => (boardEl.value?.querySelector(`[data-module-id="${id}"] .shell`) as HTMLElement)?.focus());
}
watch(() => store.editing, (editing) => { if (!editing) onGestureEnd(); });

/** 键盘微调：方向键挪位、Shift+方向键改尺寸（触屏与键盘用户的等价入口） */
function onModuleKey(module: HomeModule, dx: number, dy: number, resize: boolean) {
  if (!store.editing) return;
  const index = store.board.modules.findIndex((item) => item.id === module.id);
  if (index < 0) return;
  const next = resize ? resizeModuleBy(store.board, index, dx, dy) : moveModuleBy(store.board, index, dx, dy);
  const after = next.modules[index];
  if (!after) return;
  const before = JSON.stringify(modulePlace(module));
  if (before === JSON.stringify(modulePlace(after))) return;
  store.place(module.id, modulePlace(after));
}

/* ===== 键盘：Esc 退出编辑态；方向键挪格子 / Shift+方向键改尺寸 =====
   Esc 在应用里已经有多处用途（弹窗、侧栏满窗、编辑器全屏），这里只认「编辑态 + 没被上层拦掉」，
   别的场景一律放行；退出编辑时顺手把添加面板收掉，避免下一次进来还挂着。
   方向键只在焦点真的落在某张卡上时才接管（判 data-module-id 的祖先），否则放行给别的组件。 */
function onBoardKey(event: KeyboardEvent) {
  if ((event.target as HTMLElement)?.closest('dialog')) return;
  if (event.key === 'Escape' && !event.defaultPrevented && store.editing) {
    if (gesture) { event.preventDefault(); onGestureEnd(); return; }
    addOpen.value = false;
    store.setEditing(false);
    return;
  }
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = arrows[event.key];
  if (!step) return;
  if (event.defaultPrevented || !store.editing) return;
  // 只认落在卡片上的那一次：别处在用方向键的组件（编辑器、下拉选择…）不受影响
  const target = event.target as HTMLElement | null;
  if (!target?.closest?.('.shell') || target.closest('input,textarea,select,button,a')) return;
  const id = target.closest('[data-module-id]')?.getAttribute('data-module-id');
  if (!id) return;
  const module = store.board.modules.find((m) => m.id === id);
  if (!module) return;
  event.preventDefault();
  onModuleKey(module, step[0], step[1], event.shiftKey);
}
onMounted(() => {
  window.addEventListener('keydown', onBoardKey);
  window.addEventListener('focus', refreshQueue);
  document.addEventListener('visibilitychange', refreshQueue);
  queueTimer = setInterval(refreshQueue, 10_000);
});

onUnmounted(() => {
  clearInterval(queueTimer);
  window.removeEventListener('focus', refreshQueue);
  document.removeEventListener('visibilitychange', refreshQueue);
  onGestureEnd(); gridObserver?.disconnect();
  window.removeEventListener('keydown', onBoardKey);
  window.removeEventListener('pointermove', onGestureMove);
  window.removeEventListener('pointerup', onGestureEnd);
  window.removeEventListener('pointercancel', onGestureEnd);
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
  overflow-x: hidden;
  overflow-y: auto;
}
.board.editing-board { overflow-x:auto; }
.editing-board .board-inner { min-width:930px; }
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
.board-cq > .board-inner { margin-top: 0; margin-bottom: 0; }
/*
 * 内容宽度：固定页宽上限，不随窗口或列数缩放。
 *
 * 历史坑：曾经按「列数 × 单元宽 + 间距 + 页边距」算页宽，于是列数一变页宽也变；
 * 又曾经让 1 格 = 可用宽度 ÷ 列数，于是窗口越宽卡片越胖（2 列时 1 格 430px）。
 * 现在两条都定死：页宽上限 1120px（窗口更宽就居中留白），栅格固定 12 列、正方形格子等分页宽 ——
 * 「一格多大」只由页宽决定，用户改的是「一张卡占几格」。
 */
.board-inner {
  margin: auto;
  width: 100%;
  max-width: 1120px;
  padding: 40px 32px 64px;
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
 * 栅格看板（2026-10-07「手机桌面」模式）：固定 12 列 × N 行的 CSS Grid。
 * 每张卡的 grid-column / grid-row 由数据（col/row/w/h）直接写成内联样式，
 * 所以拖动 = 改数字、缩放 = 改数字，浏览器负责摆位——不会出现「卡片飞出页面」这种事
 * （2026-10-06 的瀑布流用绝对定位 + 脚本算像素，拖动时确实会跑到容器外）。
 * ResizeObserver 按可用宽度计算正方形行高；手势使用相同的格子尺寸与 14px 间距。
 */
.board-grid {
  display: grid;
  grid-template-columns: repeat(var(--board-cols), minmax(0, 1fr));
  grid-auto-rows: var(--grid-row-h);
  /* 只画用到的行数（--grid-rows 由脚本按内容算），避免底部留一大片空白 */
  grid-template-rows: repeat(var(--grid-rows, 4), var(--grid-row-h));
  gap: 14px;
  align-items: stretch;
  position: relative;
}
/* 编辑态：把栅格线画出来（手机桌面那种「看得见的格子」） */
.board-grid.editing {
  background-image:
    linear-gradient(to right, var(--border) 1px, transparent 1px),
    linear-gradient(to bottom, var(--border) 1px, transparent 1px);
  background-size:
    calc((100% + 14px) / var(--board-cols)) 100%,
    100% calc(var(--grid-row-h) + 14px);
  background-position: -1px -1px;
  border-radius: 12px;
}
.widget {
  min-width: 0;
  min-height: 0;
  /* 卡片大小由栅格决定；小卡摘要与完整详情由外壳按实际空间切换。 */
  overflow: visible;
  display: flex;
  flex-direction: column;
}
.widget > .shell { flex: 1; min-height: 0; }
.widget.dragging { z-index: 3; }

/* 拖动时的落点高亮：直接占在栅格的格里 */
.drop-cell {
  grid-area: auto;
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  pointer-events: none;
  z-index: 1;
}
@media (prefers-reduced-motion: reduce) {
  .widget { transition: none; }
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
  .board-hero { align-items: center; gap: 12px; }
}
@media (max-width: 768px) {
  .board-greeting { font-size: 24px; }
  .board-inner { padding: 24px 14px 40px; }
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
