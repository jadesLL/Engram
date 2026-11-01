<template>
  <div
    class="layout"
    :class="{
      'sidebar-open': app.sidebarOpen,
      'sidebar-full': app.sidebarFull,
      'sidebar-resizing': sidebarResizing,
      'chat-dock-open': chatDockOpen,
      'chat-dragging': app.chatDragging,
      'update-notice-visible': updateNoticeVisible && !desktopShell,
      'settings-open': isActive('/settings'),
    }"
    :style="{ '--sidebar-width': sidebarWidth + 'px', '--chat-w': app.chatDockWidth + 'px' }"
  >
    <!-- 窄图标导航栏：提示一律贴按钮右侧（图标栏只有一列按钮，上/下都会压住相邻图标） -->
    <nav class="rail" aria-label="主导航">
      <button class="rail-logo" type="button" v-tooltip.right="'回到首页'" aria-label="回到首页" @click="go('/page')">
        <BrandMark :size="30" />
      </button>

      <!-- 侧栏开关 -->
      <button
        class="rail-btn action"
        type="button"
        :class="{ open: app.sidebarOpen }"
        v-tooltip.right="app.sidebarOpen ? '收起侧栏' : '展开侧栏'"
        :aria-label="app.sidebarOpen ? '收起侧栏' : '展开侧栏'"
        :aria-pressed="app.sidebarOpen"
        @click="app.sidebarOpen = !app.sidebarOpen"
      >
        <Icon name="pages" :size="19" />
      </button>

      <div class="rail-divider" />

      <!-- 导航组 -->
      <button
        v-for="item in navItems"
        :key="item.key"
        class="rail-btn"
        type="button"
        :class="{ active: item.active }"
        v-tooltip.right="item.title"
        :aria-label="item.title"
        :aria-current="item.active ? 'page' : undefined"
        @click="item.action"
      >
        <Icon :name="item.icon" :size="19" />
        <span v-if="item.dot" class="dot" />
      </button>

      <div class="rail-spacer" />

      <!-- 内置 Agent（聊天抽屉）：有轮次在跑时按钮上就带状态，抽屉关着也知道它还在干活 -->
      <!-- Agent 的提问（含公司全名核验）弹在对话最下侧，不再单独占一页 -->
      <button
        class="rail-btn"
        type="button"
        :class="{ active: app.chatDrawerOpen, 'is-running': chat.hasRunning }"
        v-tooltip.right="chat.hasRunning ? `${agentName} 正在回复（${chat.runningCount} 个会话）` : agentName"
        :aria-label="chat.hasRunning ? `${agentName}（正在回复）` : agentName"
        @click="app.toggleChat()"
      >
        <Icon name="ai" :size="19" />
        <span v-if="chat.hasRunning" class="rail-running" aria-hidden="true" />
        <span v-if="app.chatUnread" class="dot" />
      </button>

      <!-- 动作/面板组 -->
      <button class="rail-btn action" type="button" v-tooltip.right="'记一条灵感 (Ctrl+N)'" aria-label="记一条灵感" @click="quickNote">
        <Icon name="plus" :size="19" />
      </button>
      <div class="rail-divider" />

      <!-- 设置（导航） -->
      <button
        class="rail-btn"
        type="button"
        :class="{ active: isActive('/settings') }"
        v-tooltip.right="'设置'"
        aria-label="设置"
        :aria-current="isActive('/settings') ? 'page' : undefined"
        @click="go('/settings')"
      >
        <Icon name="settings" :size="19" />
        <span v-if="updateStore.hasNewVersion || sourceHasUpdate || appUpdateStore.hasUpdate" class="dot" />
      </button>
    </nav>

    <!-- 文件树侧栏：满窗时同一颗元素变「目录页」（几何在样式里，见 .layout.sidebar-full） -->
    <transition name="sidebar-slide">
      <aside
        ref="sidebarEl"
        v-show="app.sidebarOpen"
        class="sidebar"
        :class="{ 'is-full': app.sidebarFull }"
        :style="{ width: sidebarWidth + 'px' }"
        aria-label="知识库侧边栏"
      >
        <Sidebar ref="sidebarRef" @close="app.sidebarOpen = false" @new-page="quickNew" />
      </aside>
    </transition>
    <!-- 拖动分隔条：桌面端 232–420px，且不超过窗口宽度的 40%（满窗时目录已铺满，分隔条让位） -->
    <div
      v-if="app.sidebarOpen && !sidebarOverlay && !app.sidebarFull"
      class="resizer"
      v-tooltip="'拖动调整宽度，双击还原'"
      role="separator"
      aria-label="调整侧边栏宽度"
      aria-orientation="vertical"
      :aria-valuemin="MIN_SIDEBAR"
      :aria-valuemax="sidebarMaxWidth"
      :aria-valuenow="sidebarWidth"
      tabindex="0"
      @mousedown="startResize"
      @dblclick="resetSidebarWidth"
      @keydown.left.prevent="nudgeSidebar(-16)"
      @keydown.right.prevent="nudgeSidebar(16)"
      @keydown.home.prevent="setSidebarWidth(MIN_SIDEBAR)"
      @keydown.end.prevent="setSidebarWidth(sidebarMaxWidth)"
    />
    <transition name="fade">
      <div v-if="app.sidebarOpen && sidebarOverlay && !app.sidebarFull" class="mask" @click="app.sidebarOpen = false" />
    </transition>

    <!-- 主内容区 -->
    <main class="content">
      <router-view />
    </main>

    <UpdateNotice @change="onUpdateNoticeChange" />

    <!-- 内置 Agent 聊天抽屉：桌面端是右侧悬浮卡片（正文让出它的宽度，不遮内容），≤1024px 覆盖正文；
         开合动画 drawer-slide 与左侧栏同一套节奏，具体样式在 ChatDrawer 里 -->
    <transition name="drawer-slide">
      <ChatDrawer v-if="app.chatDrawerOpen" :overlay="sidebarOverlay" />
    </transition>

    <!-- 内置 Agent 最小化后的常驻状态：有轮次在跑时任何视图都看得到，点它回到对话 -->
    <AgentStatusPill />

    <AppContextMenu />

    <!-- 移动端底部导航（2026-11 安卓改版：五项）：
         首页 / 知识库 / 收集箱 / Agent / 我的。聊天抽屉打开时整条让位，避免盖住输入区。 -->
    <nav class="bottom-nav" :class="{ 'chat-open': app.chatDrawerOpen }" aria-label="主导航">
      <!-- 当前所在的分区要看得出来（手机 App 的底部标签栏惯例）：选中项图标与文字用强调色 -->
      <button
        v-for="item in bottomItems"
        :key="item.key"
        type="button"
        :class="{ active: item.active }"
        :aria-current="item.active ? 'page' : undefined"
        :aria-label="item.title || item.label"
        @click="item.action"
      >
        <span class="bn-icon">
          <Icon :name="item.icon" :size="20" />
          <span v-if="item.running" class="bn-running" aria-hidden="true" />
          <span v-else-if="item.dot" class="bn-dot" aria-hidden="true" />
        </span>
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <!-- 移动端「我的」面板（2026-11 安卓改版）：替代原来的「更多」九宫格。
         账户行只读展示；快捷动作是「新建页面 / 记一条灵感」；其余入口逐行列出，行高 ≥52px。 -->
    <Teleport to="body">
      <transition name="fade">
        <div v-if="moreOpen" class="more-mask" @click="moreOpen = false" />
      </transition>
      <transition name="more-sheet">
        <div v-if="moreOpen" class="more-sheet" role="dialog" aria-modal="true" aria-label="我的">
          <div class="more-sheet-bar" />
          <div class="more-sheet-head">
            <h2 class="more-sheet-title">我的</h2>
            <button class="more-sheet-close" type="button" aria-label="关闭我的面板" @click="moreOpen = false">
              <Icon name="x" :size="20" />
            </button>
          </div>

          <div class="more-account">
            <span class="more-avatar" aria-hidden="true">{{ accountInitial }}</span>
            <span class="more-account-main">
              <span class="more-account-name">{{ accountName }}</span>
              <span class="more-account-sub">{{ accountSyncLine }}</span>
            </span>
          </div>

          <div class="more-quick">
            <button type="button" @click="runQuick(quickNew)">
              <span class="more-quick-icon"><Icon name="plus" :size="18" /></span>
              <span>新建页面</span>
            </button>
            <button type="button" @click="runQuick(quickNote)">
              <span class="more-quick-icon"><Icon name="lightbulb" :size="18" /></span>
              <span>记一条灵感</span>
            </button>
          </div>

          <div class="more-list">
            <button
              v-for="item in moreItems"
              :key="item.key"
              type="button"
              class="more-row"
              @click="item.action"
            >
              <span class="more-row-icon">
                <Icon :name="item.icon" :size="19" />
                <span v-if="item.dot" class="more-dot" aria-hidden="true" />
              </span>
              <span class="more-row-main">
                <span class="more-row-title">{{ item.label }}</span>
                <span v-if="item.sub" class="more-row-sub">{{ item.sub }}</span>
              </span>
              <Icon name="chevron-right" :size="18" class="more-row-chevron" />
            </button>

            <!-- 外观：三选直接生效（跟随系统 / 浅色 / 深色），复用 app.setTheme 的既有主题逻辑 -->
            <div class="more-appearance">
              <div class="more-row more-row-static">
                <span class="more-row-icon"><Icon name="sun" :size="19" /></span>
                <span class="more-row-main">
                  <span class="more-row-title">外观</span>
                  <span class="more-row-sub">{{ themeLabel }}</span>
                </span>
              </div>
              <div class="more-theme" role="radiogroup" aria-label="外观">
                <button
                  v-for="opt in themeOptions"
                  :key="opt.value"
                  type="button"
                  role="radio"
                  :aria-checked="app.theme === opt.value"
                  :class="{ active: app.theme === opt.value }"
                  @click="app.setTheme(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { useInboxStore } from '../stores/inbox';
import { useUpdateStore } from '../stores/update';
import { useAppUpdateStore } from '../stores/appUpdate';
import { useHomeBoardStore, flushHomeBoardWrite } from '../stores/homeBoard';
import { useTasksStore } from '../stores/tasks';
import { useSyncStore } from '../stores/sync';
import {
  UPDATE_CHECK_POKE_DEBOUNCE_MS,
  UPDATE_CHECK_STARTUP_MS,
  backoffDelay,
  nextBackoffIndex,
} from '../lib/updateCadence';
import { api } from '../api';
import { openPageStream } from '../lib/events';
import { createFreshnessProbe } from '../lib/freshness';
import { notify } from '../lib/notify';
import { promptDialog } from '../lib/confirm';
import { createIdeaNote } from '../lib/quickNote';
import { loadRuntimeCapabilities, useRuntimeCapabilities } from '../lib/capabilities';
import { haptic } from '../lib/haptics';
import { syncStatusView } from '../lib/syncStatus';
import { registerBackHandler } from '../lib/androidBack';
import Sidebar from '../components/Sidebar.vue';
import ChatDrawer from '../components/ChatDrawer.vue';
import AgentStatusPill from '../components/AgentStatusPill.vue';
import AppContextMenu from '../components/AppContextMenu.vue';
import UpdateNotice from '../components/UpdateNotice.vue';
import Icon from '../components/Icon.vue';
import BrandMark from '../components/BrandMark.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const updateStore = useUpdateStore();
const appUpdateStore = useAppUpdateStore();
const updateNoticeVisible = ref(false);
const sourceHasUpdate = ref(false);
/* 桌面端（有 wikiDesktop 桥）：更新入口渲染进融合标题栏，不再浮在正文上方，正文也就无需为它让出顶部间距 */
const desktopShell = Boolean((window as any).wikiDesktop);
const chat = useChatStore();
const inbox = useInboxStore();
const homeBoard = useHomeBoardStore();
const homeTasks = useTasksStore();
const sync = useSyncStore();

/** 退到后台 / 关页面前把去抖中的布局写补上（同步 store 的 flush，见 stores/homeBoard.ts） */
function flushHomeBoardOnHide() {
  if (document.visibilityState === 'hidden') void flushHomeBoardWrite();
}
const { capabilities } = useRuntimeCapabilities();
const agentName = computed(() => capabilities.value.agentMode === 'hub' ? '服务器 Agent' : capabilities.value.agentMode === 'unavailable' ? 'Agent' : '内置 Agent');
const sidebarRef = ref<InstanceType<typeof Sidebar>>();
const sidebarEl = ref<HTMLElement>();

/**
 * 抽屉「往左一推就收」的手势（2026-09-29）：手机 App 里从左侧拉出来的抽屉，习惯是横滑推回去。
 * 只认浮层档（桌面栏不参与），并且**纵向优先**——手指明显在上下走就交回列表滚动，
 * 否则整列页面会滑不动。判定通过后由我们接管这次触摸（preventDefault），松手过阈值才真的收起。
 */
let detachSidebarSwipe: (() => void) | null = null;

function installSidebarSwipe(el: HTMLElement) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let intent: 'none' | 'swipe' | 'scroll' = 'none';

  const reset = () => {
    intent = 'none';
    dx = 0;
    el.style.transition = '';
    el.style.transform = '';
  };

  const onStart = (event: TouchEvent) => {
    if (!sidebarOverlay.value || !app.sidebarOpen || event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    intent = 'none';
    dx = 0;
  };

  const onMove = (event: TouchEvent) => {
    if (intent === 'scroll' || event.touches.length !== 1) return;
    if (!sidebarOverlay.value || !app.sidebarOpen) return;
    const moveX = event.touches[0].clientX - startX;
    const moveY = event.touches[0].clientY - startY;
    if (intent === 'none') {
      if (Math.abs(moveX) < 10 && Math.abs(moveY) < 10) return;
      // 横向位移明显大于纵向才算「横滑」，否则让列表自己滚
      intent = Math.abs(moveX) > Math.abs(moveY) * 1.4 ? 'swipe' : 'scroll';
      if (intent === 'scroll') return;
    }
    dx = Math.min(0, moveX);
    if (dx < 0) event.preventDefault();
    el.style.transition = 'none';
    el.style.transform = `translateX(${dx}px)`;
    // 滑到一半就已经看不清了：顺带把抽屉压淡，收起的意图更明确
    el.style.opacity = String(Math.max(0.55, 1 + dx / 320));
  };

  const onEnd = () => {
    if (intent !== 'swipe') {
      reset();
      return;
    }
    const shouldClose = dx < -72;
    el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
    el.style.transform = '';
    el.style.opacity = '';
    if (shouldClose) app.sidebarOpen = false;
    window.setTimeout(() => {
      el.style.transition = '';
    }, 220);
    intent = 'none';
    dx = 0;
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd);
  el.addEventListener('touchcancel', onEnd);
  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', onEnd);
  };
}
/** 安卓返回键接管层的注销函数（组件卸载时注销，避免路由重进后残留旧闭包） */
let stopBackHandler: (() => void) | null = null;

/* ===== 文件提取进度：只在对应文件旁显示，系统后台处理不提供通用队列界面 ===== */
let jobPollStopped = true;
let jobTimer: ReturnType<typeof setTimeout>;
async function pollJobs() {
  await app.refreshJobs();
  const extracting = app.jobs.active.some((job: any) => job.kind === 'extract_file');
  if (!jobPollStopped) jobTimer = setTimeout(pollJobs, extracting ? 1500 : 6000);
}

/* ===== 侧栏宽度拖拽 ===== */
const MIN_SIDEBAR = 232;
const MAX_SIDEBAR = 420;
const DEFAULT_SIDEBAR = 280;
const viewportWidth = ref(window.innerWidth);
const isMobile = computed(() => viewportWidth.value <= 768);
/* 769-1024px 紧凑档（折叠屏内屏等）：侧栏浮层化，需要遮罩 */
const isCompact = computed(() => viewportWidth.value > 768 && viewportWidth.value <= 1024);
const sidebarOverlay = computed(() => isMobile.value || isCompact.value);
/** 悬浮档展开中：正文要按卡片宽度让出右侧空间（满窗与紧凑档浮层都不让位——它们本来就盖在正文上） */
const chatDockOpen = computed(() =>
  app.chatDrawerOpen && app.chatDrawerMode === 'dock' && !sidebarOverlay.value
);
const sidebarMaxWidth = computed(() =>
  Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, Math.floor(viewportWidth.value * 0.4)))
);

function clampSidebarWidth(width: number) {
  return Math.min(sidebarMaxWidth.value, Math.max(MIN_SIDEBAR, width));
}

const storedSidebarWidth = Number(localStorage.getItem('sidebarWidth'));
const sidebarWidth = ref(
  clampSidebarWidth(Number.isFinite(storedSidebarWidth) && storedSidebarWidth > 0
    ? storedSidebarWidth
    : DEFAULT_SIDEBAR)
);
/** 是否正在拖侧栏宽度：拖动中不做几何过渡，见 startResize */
const sidebarResizing = ref(false);

function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarWidth.value;
  // 拖动期间关掉侧栏的几何过渡：否则宽度每帧都在追 180ms 前的值，手感是「拖不动」
  // （与内置 Agent 拖卡片宽度同一处理：.layout.chat-dragging）
  sidebarResizing.value = true;
  const move = (ev: MouseEvent) => {
    sidebarWidth.value = clampSidebarWidth(startW + (ev.clientX - startX));
  };
  const up = () => {
    sidebarResizing.value = false;
    localStorage.setItem('sidebarWidth', String(sidebarWidth.value));
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

function resetSidebarWidth() {
  setSidebarWidth(DEFAULT_SIDEBAR);
}

function setSidebarWidth(width: number) {
  sidebarWidth.value = clampSidebarWidth(width);
  localStorage.setItem('sidebarWidth', String(sidebarWidth.value));
}

function nudgeSidebar(delta: number) {
  setSidebarWidth(sidebarWidth.value + delta);
}

function onWindowResize() {
  const prevOverlay = sidebarOverlay.value;
  viewportWidth.value = window.innerWidth;
  // 跨入浮层档位时收起侧栏，避免展开的桌面侧栏瞬间盖住内容
  if (!prevOverlay && sidebarOverlay.value) app.sidebarOpen = false;
  if (!isMobile.value) {
    const clamped = clampSidebarWidth(sidebarWidth.value);
    if (clamped !== sidebarWidth.value) setSidebarWidth(clamped);
  }
}

const isActive = (p: string) => route.path.startsWith(p);

/**
 * 导航到别的内容：先把内置 Agent 最小化（满窗时它正盖着正文），再跳转。
 * 路由 afterEach 兜的是「任何导航」（侧栏页面、搜索结果、双链、返回轨迹都不经过这里），
 * 这里显式再来一次，是为了「已经在这一页时再点一次图标」也能把 Agent 收下去——
 * 同名路由的重复导航不会触发 afterEach。
 */
function go(path: string) {
  app.minimizeChatForNavigation();
  void router.push(path);
}

const navItems = computed(() => [
  { key: 'search', icon: 'search', title: '搜索 (Ctrl+K)', active: isActive('/search'), dot: false, action: () => go('/search') },
  { key: 'graph', icon: 'graph', title: '知识图谱', active: isActive('/graph'), dot: false, action: () => go('/graph') },
  {
    key: 'inbox',
    icon: 'inbox',
    // 角标只算还没入库的（待整理 + 已转换）：已入库的内容已经进了知识库，不该再催
    title: inbox.activeCount
      ? `收集箱（${inbox.activeCount} 份还没入库）`
      : '收集箱',
    active: isActive('/inbox'),
    dot: inbox.activeCount > 0,
    action: () => go('/inbox'),
  },
  // 任务看板：点一下就去那一页，进页自动让内置 Agent 从知识库提炼（不在页面上弹 Agent 抽屉）
  { key: 'tasks', icon: 'board', title: '任务看板', active: isActive('/tasks'), dot: false, action: () => go('/tasks') },
  { key: 'customer-research', icon: 'report', title: '客户调研', active: isActive('/customer-research'), dot: false, action: () => go('/customer-research') },
]);

/* ===== 手机底部导航（≤768px）：五个顶层入口 =====
 * 桌面端看不到这一条（.bottom-nav 只在 ≤768px 显示），标签项在这里统一定义。
 * 首页与知识库都落在 /page：目录抽屉收起时算首页，抽屉拉开时算知识库——两个标签
 * 各有一件事，不再像旧的「页面」那样一格两件事。
 */
const moreOpen = ref(false);

/** 知识库抽屉在手机上是浮层：切到别的标签时顺手收起，免得盖住刚切过去的页面 */
function closeLibraryDrawer() {
  if (app.sidebarOpen) app.sidebarOpen = false;
}

interface BottomNavItem {
  key: string;
  label: string;
  /** 无障碍名称：带角标数量时比标签更具体（可省，省则用 label） */
  title?: string;
  icon: string;
  active: boolean;
  dot: boolean;
  running: boolean;
  action: () => void;
}

const bottomItems = computed<BottomNavItem[]>(() => [
  {
    key: 'home',
    label: '首页',
    title: '首页',
    icon: 'compass',
    active: isActive('/page') && !app.sidebarOpen,
    dot: false,
    running: false,
    action: () => {
      haptic('tap');
      closeLibraryDrawer();
      go('/page');
    },
  },
  {
    key: 'library',
    label: '知识库',
    title: '知识库',
    icon: 'pages',
    // 选中态靠抽屉判断：两个标签都去 /page，「抽屉开着」就是正在看知识库
    active: app.sidebarOpen,
    dot: false,
    running: false,
    action: () => {
      haptic('tap');
      app.sidebarOpen = true;
      go('/page');
    },
  },
  {
    key: 'inbox',
    label: '收集箱',
    icon: 'inbox',
    // 角标只算还没入库的（待整理 + 已转换）：已入库的内容已经进了知识库，不该再催
    title: inbox.activeCount ? `收集箱（${inbox.activeCount} 份还没入库）` : '收集箱',
    active: isActive('/inbox'),
    dot: inbox.activeCount > 0,
    running: false,
    action: () => {
      haptic('tap');
      closeLibraryDrawer();
      go('/inbox');
    },
  },
  {
    key: 'agent',
    label: 'Agent',
    title: 'Agent',
    icon: 'ai',
    active: app.chatDrawerOpen,
    dot: app.chatUnread,
    running: chat.hasRunning,
    action: () => {
      haptic('tap');
      closeLibraryDrawer();
      app.toggleChat(true);
    },
  },
  {
    key: 'me',
    label: '我的',
    title: '我的',
    icon: 'more',
    active: moreOpen.value,
    dot: false,
    running: false,
    action: () => {
      haptic('tap');
      moreOpen.value = true;
    },
  },
]);

/** 面板列表行：点完先收面板再做事（导航要能马上看到） */
function runMore(action: () => void) {
  moreOpen.value = false;
  action();
}

/** 快捷动作（新建页面 / 记一条灵感）：收面板 + 轻振确认，属于「产生内容」的主操作 */
function runQuick(action: () => void) {
  haptic('tap');
  moreOpen.value = false;
  action();
}

interface MoreSheetItem {
  key: string;
  label: string;
  /** 行内第二行说明（可省） */
  sub?: string;
  icon: string;
  dot: boolean;
  action: () => void;
}

/* 「我的」面板列表：rail 在 ≤768px 隐藏后，这些入口仅在此处可达。
   收集箱与 Agent 已升为底栏顶层，不再重复占用这里的行。 */
const moreItems = computed<MoreSheetItem[]>(() => [
  { key: 'search', label: '搜索', sub: 'Wiki 页面与原始资料', icon: 'search', dot: false, action: () => runMore(() => go('/search')) },
  { key: 'graph', label: '知识图谱', icon: 'graph', dot: false, action: () => runMore(() => go('/graph')) },
  { key: 'tasks', label: '任务看板', icon: 'board', dot: false, action: () => runMore(() => go('/tasks')) },
  { key: 'customer-research', label: '客户调研', icon: 'report', dot: false, action: () => runMore(() => go('/customer-research')) },
  { key: 'sync', label: '多端同步', icon: 'cloud-check', dot: false, action: () => runMore(() => go('/settings')) },
  {
    key: 'settings',
    label: '设置',
    dot: updateStore.hasNewVersion || sourceHasUpdate.value || appUpdateStore.hasUpdate,
    icon: 'settings',
    action: () => runMore(() => go('/settings')),
  },
]);

/* 账户行（只读）：名字取同步群组里这台设备的名字，第二行是同步状态；
   没配置多端同步时只说「本机知识库」，不假装有云端账户体系。 */
const accountName = computed(() => (sync.status?.deviceLabel || '').trim() || 'Engram 本机');
const accountInitial = computed(() => Array.from(accountName.value)[0] || 'E');
const accountSyncLine = computed(() => {
  const state = syncStatusView(sync.status, {
    androidLocal: capabilities.value.runtime === 'android-local',
  });
  if (!state) return '本机知识库 · 未配置多端同步';
  return state.detail ? `${state.label} · ${state.detail}` : state.label;
});

/* 外观三选：直接走 app.setTheme（localStorage + 服务端设置 + 原生状态栏配色都在那里），
   不在这块面板里另造一套主题逻辑。 */
const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const;
const themeLabel = computed(
  () => themeOptions.find((opt) => opt.value === app.theme)?.label || '跟随系统',
);

async function quickNew() {
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog
  const title = await promptDialog({
    title: '新建页面',
    message: '页面标题：',
    value: '未命名页面',
    confirmText: '创建',
  });
  if (title === null) return;
  const { data } = await api.post('/api/pages', { dir: 'Wiki', title: title || '未命名页面' });
  sidebarRef.value?.load();
  // 新建的空页面没有可读内容，直接进编辑器
  app.setReadingMode(false);
  router.push(`/page/${data.meta.id}`);
}

/** 左下角「+」与 Ctrl+N：记一条灵感（建到 原始资料/灵感碎片/），新建 Wiki 页面仍走侧栏顶部「+」 */
async function quickNote() {
  const created = await createIdeaNote();
  if (!created) return;
  sidebarRef.value?.load();
  // 不开「强制编辑器」：灵感页现在就是普通页面，跟着全站形态走（默认沉浸阅读，抬头「返回编辑」进编辑器）
  router.push(`/page/${created.id}`);
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    router.push('/search');
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    quickNote();
  } else if (e.key === 'Escape' && app.sidebarFull && !e.defaultPrevented) {
    // 满窗目录的退出键：与内置 Agent 满窗（ChatDrawer 的 Esc）同一套手感。
    // 弹窗/确认框自己会 preventDefault，编辑器全屏的 Esc 也会先处理，这里不抢。
    app.setSidebarFull(false);
  }
}

function onUpdateNoticeChange(visible: boolean, sourceUpdate: boolean) {
  updateNoticeVisible.value = visible;
  sourceHasUpdate.value = sourceUpdate;
}

/* ===== 软件更新自动检测：两级探测 + 自适应退避 =====
   进入应用 3 秒首查；之后按「这轮有没有发现更新」自适应：没发现就 2→5→10→30→60 分钟逐级拉长（有更新待处理时每分钟复查），
   发现了立刻回到最短间隔。切回前台 / 窗口聚焦 / 网络恢复再补查一次（20 秒去抖）。
   节奏策略与桌面主进程同源：lib/updateCadence.ts ↔ desktop/scripts/lib/update-cadence.js。
   手机端（Android App）走同一套节奏，只是把「检查」换成 App 内的 APK 更新检查：
   App 自己也会在启动/回前台时检查一次（MainActivity → AppUpdater.onForeground），两边互补。 */
async function autoCheckUpdate(): Promise<boolean> {
  const caps = await loadRuntimeCapabilities();
  if (caps.runtime === 'android-local') {
    if (!caps.features.apkUpdate) return false;
    await appUpdateStore.check();
    return true;
  }
  if (!caps.features.serverUpdate) return false;
  const desktop = (window as any).wikiDesktop;
  if (desktop?.getDesktopEnv) {
    try {
      const env = await desktop.getDesktopEnv();
      // 源码模式由主进程检查 Git 提交；Release 版本号不代表日常源码更新。
      if (env && !env.packaged && env.platform === 'win32') return false;
    } catch {
      // 壳信息暂不可用时继续检查服务器更新。
    }
  }
  await updateStore.check();
  return true;
}

let closeStream: (() => void) | null = null;
/** 推送兜底探针：SSE 晚到/丢失时按内容版本号自愈（见 lib/freshness） */
let freshness: ReturnType<typeof createFreshnessProbe> | null = null;
/** 兜底探针间隔：3 秒足够让「保存完成 → 侧栏出现」的体感保持在一瞬，探针本身只有几十字节 */
const FRESHNESS_INTERVAL_MS = 3000;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let updateBackoffIndex = 0;
let updatePokedAt = 0;

function scheduleUpdateCheck(delayMs: number) {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => { updateTimer = null; void runUpdateCheck(); }, delayMs);
}

/** 跑一轮检查并按结果排下一轮；这一形态不需要前端检测（源码模式/Android）就停表 */
async function runUpdateCheck() {
  let ran = false;
  try {
    ran = await autoCheckUpdate();
  } catch {
    // 网络抖动不当作「发现更新」，按未发现继续退避
  }
  if (!ran) return;
  updateBackoffIndex = nextBackoffIndex(updateBackoffIndex, updateStore.hasNewVersion || appUpdateStore.hasUpdate);
  scheduleUpdateCheck(backoffDelay(updateBackoffIndex));
}

/** 回到应用（切前台/聚焦/网络恢复）：补查一次，并把节奏拉回最灵敏档 */
function pokeUpdateCheck() {
  const now = Date.now();
  if (now - updatePokedAt < UPDATE_CHECK_POKE_DEBOUNCE_MS) return;
  updatePokedAt = now;
  updateBackoffIndex = 0;
  scheduleUpdateCheck(800);
}

function onUpdateVisibility() {
  if (document.visibilityState !== 'visible') return;
  pokeUpdateCheck();
  // 后台期间推送可能被节流/掉线：回前台立即对一次账，不等下一个探针周期
  void freshness?.check();
}
function onUpdateOnline() {
  pokeUpdateCheck();
  void freshness?.check();
}
/** 窗口重新获得焦点（切回应用）：与回前台同口径，补一次推送对账 */
function onWindowFocus() {
  pokeUpdateCheck();
  void freshness?.check();
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onWindowResize);
  // Android 返回键/侧滑返回：先收掉应用级浮层（我的面板 → 对话抽屉 → 文件树），
  // 都关着才交回原生（历史后退或退到后台）。桌面端没有原生调用，注册了也不会触发。
  stopBackHandler = registerBackHandler(() => {
    if (moreOpen.value) {
      moreOpen.value = false;
      return true;
    }
    if (app.chatDrawerOpen) {
      app.toggleChat(false);
      return true;
    }
    if (app.sidebarOpen) {
      app.sidebarOpen = false;
      return true;
    }
    return false;
  });
  // 抽屉横滑手势：aside 一直挂在 DOM 里（v-show 切换），挂载时装一次即可
  if (sidebarEl.value) detachSidebarSwipe = installSidebarSwipe(sidebarEl.value);
  app.loadUiPreferences(); // 侧栏「AI 工作区」默认隐藏，是否显示由服务端设置决定
  // 首页看板布局：先按本地那份画出来（进页面就有内容），服务端答复到了再校正（多端一致）
  void homeBoard.load();
  // 布局改动是去抖写服务端的（600ms）：页面隐藏/卸载前补一次，免得「刚拖完就关掉」只留在本地
  document.addEventListener('visibilitychange', flushHomeBoardOnHide);
  window.addEventListener('pagehide', flushHomeBoardWrite);
  // 看板里任何模块加进来时「补拉」：近期待办在首页首次渲染时可能没有这个模块，
  // 之后用户在编辑态加上，任务看板数据得跟着到（数据源在 EditorView，见 loadWelcomeOnce）
  watch(
    () => homeBoard.board.modules.some((module) => module.kind === 'tasks'),
    (hasTasks) => {
      if (hasTasks && !homeTasks.board) void homeTasks.load();
    }
  );
  loadRuntimeCapabilities().then((caps) => {
    if (caps.features.jobs) {
      jobPollStopped = false;
      pollJobs();
    }
    // Android 的本地 API 与 WebView 同进程，不建立常驻 SSE；保存操作会直接刷新对应界面。
    if (caps.runtime !== 'android-local') {
      // 服务端 SSE 实时推送：页面增删改/移动刷新正文与侧栏；Agent 提问弹在对话里，这里只提醒一句
      closeStream = openPageStream((ev) => {
        // 事件自带内容版本号：记下来，兜底探针就不会为这条事件再刷一遍
        freshness?.noteRevision(ev.rev);
        if (ev.type === 'settings-changed') {
          if (!homeBoard.editing) void homeBoard.load();
          void app.loadUiPreferences();
          return;
        }
        if (ev.type === 'agent-question') {
          if (app.chatDrawerOpen) return;
          app.chatUnread = true;
          notify.info('Agent 在对话里问了一个问题，点选后它接着往下做');
          return;
        }
        // 收集箱变更（本端拖入、外部拷入或对端同步落地）：刷新图标栏角标与列表
        if (ev.type === 'file-changed' && String(ev.path || '').startsWith('收集箱/')) {
          inbox.load();
        }
        app.applyPageEvent(ev);
      }, () => {
        // 断线重连：断线期间的事件服务端不补发，立刻对一次账把漏掉的内容补上
        void freshness?.check();
      });
      // 推送兜底探针：SSE 在反向代理缓冲、电脑休眠唤醒等场景下可能晚到或丢失，
      // 而 EventSource 只在真断开时重连——「连接还在、事件没来」时界面会一直停在旧状态。
      // 这里每 3 秒读一次内容版本号，变了才重读目录（保存后最多一个周期内出现）。
      // Android 本地端没有这个端点（本机服务只做窄代理），仍由同步内容版本号那条路兜底。
      freshness = createFreshnessProbe({
        fetchRevision: async () => Number((await api.get('/api/events/state')).data?.revision ?? 0),
        onChanged: () => {
          inbox.load();
          app.bumpSidebar();
        },
        intervalMs: FRESHNESS_INTERVAL_MS,
        isVisible: () => document.visibilityState === 'visible',
      });
      freshness.start();
    }
  });
  scheduleUpdateCheck(UPDATE_CHECK_STARTUP_MS);
  document.addEventListener('visibilitychange', onUpdateVisibility);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('online', onUpdateOnline);
  // 内置 Agent 正在跑的轮次要接上事件流：页面刷新后、或抽屉从没打开过，
  // 图标栏那颗「运行中」指示也得亮着（跑完还会亮小红点）。
  chat.syncRunningRuns().catch(() => {});
  // 图标栏「收集箱」角标：启动时取一次待整理数量
  inbox.load();
  // 首页若有「收集箱」卡片：同一份 store，进页面时补一次，卡片里的待整理数与角标一致
  watch(
    () => homeBoard.board.modules.some((module) => module.kind === 'inbox'),
    (hasInbox) => {
      if (hasInbox) void inbox.load();
    }
  );
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onWindowResize);
  stopBackHandler?.();
  stopBackHandler = null;
  detachSidebarSwipe?.();
  detachSidebarSwipe = null;
  document.removeEventListener('visibilitychange', onUpdateVisibility);
  document.removeEventListener('visibilitychange', flushHomeBoardOnHide);
  window.removeEventListener('pagehide', flushHomeBoardWrite);
  void flushHomeBoardWrite(); // 卸载时也补一次（视图被整体换掉时不一定收到 pagehide）
  window.removeEventListener('focus', onWindowFocus);
  window.removeEventListener('online', onUpdateOnline);
  if (updateTimer) clearTimeout(updateTimer);
  jobPollStopped = true;
  if (jobTimer) clearTimeout(jobTimer);
  closeStream?.();
  closeStream = null;
  freshness?.stop();
  freshness = null;
});
</script>

<style scoped>
.layout {
  position: relative;
  display: flex;
  height: 100%;
  /*
   * clip 而不是 hidden：hidden 仍然是个「可滚动容器」，卡片从右缘滑入时那一瞬的
   * 溢出会被浏览器「把聚焦元素滚进视野」顺走十几像素，整个界面（图标栏 + 文件树）
   * 跟着横移再弹回，看着就是呼出时左侧抖一下。clip 直接封掉滚动这条路；
   * 前面留一行 hidden 给不认 clip 的老浏览器兜底（那边还有 preventScroll 顶着）。
   */
  overflow: hidden;
  overflow: clip;
  background: var(--bg);
}

.rail {
  position: absolute;
  /* 安卓边到边：整条图标栏让开状态栏/导航栏（--safe-* 桌面端恒为 0，观感不变） */
  top: calc(8px + var(--safe-top));
  bottom: calc(8px + var(--safe-bottom));
  left: calc(8px + var(--safe-left));
  width: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 5px;
  border: 1px solid var(--sidebar-glass-border);
  border-radius: 8px;
  background: var(--sidebar-rail-material);
  box-shadow: var(--sidebar-glass-shadow);
  backdrop-filter: saturate(150%) blur(28px);
  -webkit-backdrop-filter: saturate(150%) blur(28px);
  z-index: var(--z-chrome);
}

.rail-logo {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 9px;
  border-radius: 8px;
  filter: var(--rail-logo-filter);
  user-select: none;
  transition: filter 150ms ease, transform 150ms ease;
}

.rail-logo:hover {
  filter: var(--rail-logo-filter-hover);
}

.rail-logo:active {
  transform: scale(0.96);
}

.rail-btn {
  position: relative;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
}

.rail-btn:hover {
  color: var(--text);
  background: var(--sidebar-hover);
}

/* 按下反馈：鼠标与触屏共用同一个令牌（触屏没有 hover，全靠这一层） */
.rail-btn:active {
  background: var(--press-bg);
}

.rail-btn:focus-visible,
.rail-logo:focus-visible {
  outline: 2px solid var(--sidebar-accent);
  outline-offset: 2px;
}

.rail-btn.active {
  color: var(--text);
  background: var(--sidebar-selection);
  box-shadow: inset 0 0 0 1px var(--sidebar-selection-border);
}

/* Win11 NavigationView 选中指示条：左侧 3px 圆角强调色 pill */
.rail-btn.active::before {
  content: '';
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: -5px;
  width: 3px;
  border-radius: 2px;
  background: var(--sidebar-accent);
}

.rail-btn.open {
  color: var(--sidebar-accent);
  background: transparent;
}

.rail-btn.open:hover {
  background: var(--sidebar-hover);
}

.rail-btn .dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--sidebar-glass-solid);
  border-radius: 50%;
  background: var(--sidebar-accent);
  pointer-events: none;
}

/* 「内置 Agent 正在回复」：图标呼吸 + 右上一颗脉冲点，抽屉关着也知道它还在干活 */
.rail-btn.is-running {
  color: var(--sidebar-accent);
}

.rail-btn.is-running > svg {
  animation: rail-thinking 1.6s ease-in-out infinite;
}

.rail-btn .rail-running {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sidebar-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--sidebar-accent) 55%, transparent);
  animation: rail-pulse 1.6s ease-out infinite;
  pointer-events: none;
}

/* 跑完的「新回复」小红点要压住脉冲点：同一位置，未读优先可见 */
.rail-btn.is-running .dot {
  border-color: var(--sidebar-glass-solid);
  animation: none;
}

@keyframes rail-thinking {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@keyframes rail-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--sidebar-accent) 55%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .rail-btn.is-running > svg,
  .rail-btn .rail-running {
    animation: none;
  }
}

.rail-spacer { flex: 1; }

.rail-divider {
  width: 20px;
  height: 1px;
  margin: 6px 0;
  background: var(--sidebar-hairline);
}

.sidebar {
  position: absolute;
  top: calc(8px + var(--safe-top));
  bottom: calc(8px + var(--safe-bottom));
  left: calc(60px + var(--safe-left));
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--sidebar-glass-border);
  border-radius: 8px;
  background: var(--sidebar-material);
  box-shadow: var(--sidebar-glass-shadow);
  backdrop-filter: saturate(150%) blur(28px);
  -webkit-backdrop-filter: saturate(150%) blur(28px);
  z-index: var(--z-sidebar);
}

.resizer {
  position: absolute;
  top: 18px;
  bottom: 18px;
  left: calc(60px + var(--sidebar-width) - 4px);
  width: 8px;
  cursor: col-resize;
  background: transparent;
  outline: none;
  z-index: var(--z-resizer);
}

.resizer::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: transparent;
  transition: width 150ms ease, left 150ms ease, background 150ms ease;
}

.resizer:hover::before,
.resizer:focus-visible::before {
  left: 3px;
  width: 2px;
  background: var(--sidebar-accent);
}

.resizer:focus-visible {
  box-shadow: 0 0 0 2px var(--sidebar-focus-ring);
}

.content {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding-left: 64px;
  /*
   * 上下各让开系统栏：安卓边到边后 WebView 顶边就是屏幕顶边，正文不能顶到状态栏/导航栏
   * 底下（视图自己的 absolute 顶栏也挂在 .content 内，会一并被抬到状态栏下方）。
   */
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
  /* 横屏时系统导航栏会跑到右侧（inset-right>0）：正文右侧也要让开，否则末列被导航键压住 */
  padding-right: var(--safe-right);
  background: var(--bg);
  transition: padding-left 180ms ease, padding-right 180ms ease, padding-top 180ms ease;
}

.layout.update-notice-visible .content { padding-top: calc(52px + var(--safe-top)); }
.layout.chat-dock-open :deep(.update-notice) { right: calc(var(--chat-w) + 24px); }

/*
 * 宽屏设置页自己管两根滚动条（左侧目录列 / 右侧内容列，见 styles/settings.css），内容区
 * .content 不参与滚动：它是 Home 的整页滚动容器，一旦被顶高就多出第三根滚动条——而设置页里
 * 只要有一个绝对定位元素漏出壳层（浮层残留、第三方库节点……），.content 就会被顶高 264px
 * （2026-09-27 用户报「最外边这根滑动条没用」：拖它什么都看不到，只把整页推歪）。
 * 选择器带上 .layout 提高权重，压过上面 .content[data-v-*] 的 overflow-y: auto。
 * 窄屏（≤768px）设置页退回整页滚动，滚动权就在 .content 手上，这里不能管。
 */
@media (min-width: 769px) {
  .layout.settings-open .content {
    overflow: hidden;
  }
}

.layout.sidebar-open .content {
  padding-left: calc(var(--sidebar-width) + 72px);
}

/*
 * 知识库目录满窗（2026-10-03）：与内置 Agent 满窗（.chat-drawer.full）同一套落位，
 * 方向相反——贴边铺满正文区、保留左侧图标栏、不再留玻璃边距与圆角。
 * 几何写成具体长度（left / width / top / bottom 都可插值），点一下才是「拉过去」而不是跳过去。
 * width / max-width 带 !important：紧凑档（≤1024px）把侧栏当浮层写死了 min() 与 400px 上限，
 * 「满窗」必须盖过它，否则只铺到 400px（原型里就踩过这一条）。
 */
.sidebar {
  transition: left 180ms cubic-bezier(0.2, 0, 0, 1), top 180ms cubic-bezier(0.2, 0, 0, 1),
    bottom 180ms cubic-bezier(0.2, 0, 0, 1), width 180ms cubic-bezier(0.2, 0, 0, 1),
    border-radius 180ms ease, box-shadow 180ms ease;
}

/* 拖动宽度时不做过渡（否则每帧都在追上一帧的值） */
.layout.sidebar-resizing .sidebar {
  transition: none;
}

.layout.sidebar-full .sidebar {
  position: absolute;
  top: var(--safe-top);
  bottom: var(--safe-bottom);
  left: calc(64px + var(--safe-left));
  width: calc(100% - 64px - var(--safe-left)) !important;
  max-width: none !important;
  border-color: transparent;
  border-radius: 0;
  box-shadow: none;
  background: var(--bg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  z-index: var(--z-subpanel);
}

/* 满窗是「看目录」的形态：正文被盖住，且不该被误点（点目录行才是唯一动作） */
.layout.sidebar-full .content {
  pointer-events: none;
}

/* 满窗下目录就是主角：分隔条让位（目录已经铺满，拖动宽度没有意义） */
.layout.sidebar-full .resizer {
  display: none;
}

/*
 * 内置 Agent 悬浮卡片打开：正文让出卡片宽度（贴边 8px + 呼吸 12px），
 * 与左侧文件树让位同一套节奏——两边都是「浮层出现、正文平移让位」，不是压住正文。
 */
.layout.chat-dock-open .content {
  padding-right: calc(var(--chat-w, 0px) + 20px + var(--safe-right));
}

/* 拖卡片宽度时正文跟手：过渡会把让位拖后 180ms，卡片就压到字上了 */
.layout.chat-dragging .content {
  transition: none;
}

.sidebar-slide-enter-active,
.sidebar-slide-leave-active {
  transition: transform 160ms ease, opacity 160ms ease;
}

.sidebar-slide-enter-from,
.sidebar-slide-leave-to {
  transform: translateX(-14px) scale(0.985);
  opacity: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 160ms ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.bottom-nav { display: none; }
.mask { display: none; }

.more-mask { display: none; }
.more-sheet { display: none; }

/* 769-1024px 紧凑档（折叠屏内屏/平板竖屏）：rail 保留，侧栏改浮层，AI 抽屉收窄并排 */
@media (min-width: 769px) and (max-width: 1024px) {
  .sidebar {
    position: fixed;
    /* fixed 相对视口定位：桌面端须避开顶部拖拽融合条（非桌面端变量回退 0px） */
    top: calc(8px + var(--win-titlebar-h, 0px) + var(--safe-top));
    bottom: calc(8px + var(--safe-bottom));
    left: calc(60px + var(--safe-left));
    width: min(var(--sidebar-width), calc(100vw - 80px)) !important;
    max-width: 400px;
    box-shadow: var(--sidebar-mobile-shadow);
  }

  .resizer { display: none; }

  .mask {
    position: fixed;
    inset: 0;
    display: block;
    background: rgba(15, 15, 15, 0.26);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    z-index: var(--z-mask);
  }

  .content,
  .layout.sidebar-open .content {
    padding-left: calc(64px + var(--safe-left));
  }

  /* 触屏紧凑档（折叠屏内屏/平板竖屏）：rail 图标按钮用不可见热区补到 44px，
     视觉尺寸不变——36px 的方块在手指上仍然偏小 */
  @media (hover: none) and (pointer: coarse) {
    .rail-btn { width: 36px; height: 36px; }
    .rail { padding: 6px 4px; }
    .rail-btn::after,
    .rail-logo::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 10px;
    }
  }
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .rail { background: var(--sidebar-rail-solid); }
  .sidebar { background: var(--sidebar-material-solid); }
}

@media (max-width: 768px) {
  .rail { display: none; }

  .sidebar {
    position: fixed;
    top: calc(8px + var(--safe-top));
    bottom: calc(64px + var(--safe-bottom));
    left: calc(8px + var(--safe-left));
    width: calc(100vw - 16px) !important;
    max-width: 320px;
    box-shadow: var(--sidebar-mobile-shadow);
    z-index: var(--z-sidebar);
  }

  .resizer {
    display: none;
  }

  .mask {
    position: fixed;
    inset: 0;
    display: block;
    background: rgba(15, 15, 15, 0.26);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    z-index: var(--z-mask);
  }

  .content {
    padding-bottom: calc(64px + var(--safe-bottom));
    padding-left: 0;
  }

  .layout.update-notice-visible .content { padding-top: calc(46px + var(--safe-top)); }

  .layout.sidebar-open .content {
    padding-left: 0;
  }

  .bottom-nav {
    position: fixed;
    right: calc(8px + var(--safe-right));
    /* 手势条设备上整栏抬到手势条上方，内容在 48px 内垂直居中（border-box 下 padding 会压缩内容区导致偏移） */
    bottom: calc(8px + var(--safe-bottom));
    left: calc(8px + var(--safe-left));
    display: flex;
    height: 48px;
    overflow: hidden;
    border: 1px solid var(--sidebar-glass-border);
    border-radius: 12px;
    background: var(--sidebar-material);
    box-shadow: var(--sidebar-glass-shadow);
    backdrop-filter: saturate(150%) blur(24px);
    -webkit-backdrop-filter: saturate(150%) blur(24px);
    z-index: var(--z-chrome);
  }

  .bottom-nav button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    color: var(--text-secondary);
  }

  /* 按下反馈：整栏是 12px 圆角的外壳，按钮自己只填底色、圆角交给外壳的 overflow 裁 */
  .bottom-nav button:active {
    background: var(--sidebar-active);
  }

  /* 当前分区：图标与文字一起用强调色（底部标签栏的选中态） */
  .bottom-nav button.active {
    color: var(--sidebar-accent);
  }

  .bottom-nav button span { font-size: 10px; }

  /* 底栏图标外层：只负责给「运行中 / 未读」小点定位（图标本身仍是 20px 细线） */
  .bn-icon {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .bn-dot {
    position: absolute;
    top: -3px;
    right: -6px;
    width: 7px;
    height: 7px;
    border: 1.5px solid var(--sidebar-glass-solid);
    border-radius: 50%;
    background: var(--sidebar-accent);
    pointer-events: none;
  }

  /* Agent 还有轮次在跑：与 rail 上同一套脉冲点，抽屉关着也能从底栏看出来 */
  .bn-running {
    position: absolute;
    top: -3px;
    right: -6px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sidebar-accent);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--sidebar-accent) 55%, transparent);
    animation: rail-pulse 1.6s ease-out infinite;
    pointer-events: none;
  }

  /* 聊天抽屉在窄屏是整屏浮层：底部导航让位，否则盖住输入框与发送按钮 */
  .bottom-nav.chat-open { display: none; }

  /* 「我的」底部面板（2026-11 安卓改版）：列表式，取代原来的「更多」九宫格 */
  .more-mask {
    position: fixed;
    inset: 0;
    display: block;
    background: rgba(15, 15, 15, 0.26);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
    z-index: var(--z-chrome);
  }

  .more-sheet {
    position: fixed;
    right: calc(8px + var(--safe-right));
    bottom: calc(64px + var(--safe-bottom));
    left: calc(8px + var(--safe-left));
    display: block;
    padding: 10px 14px 14px;
    border: 1px solid var(--sidebar-glass-border);
    border-radius: 16px;
    background: var(--sidebar-material);
    box-shadow: var(--sidebar-mobile-shadow);
    backdrop-filter: saturate(150%) blur(24px);
    -webkit-backdrop-filter: saturate(150%) blur(24px);
    /* 矮视口（手机横屏/分屏）时面板会顶出屏幕：限定高度并允许内部滚动 */
    max-height: calc(100dvh - 72px - var(--safe-top) - var(--safe-bottom));
    overflow-y: auto;
    z-index: calc(var(--z-chrome) + 1);
  }

  .more-sheet-bar {
    width: 36px;
    height: 4px;
    margin: 0 auto 8px;
    border-radius: 2px;
    background: var(--sidebar-hairline);
  }

  /* 标题行 + 右上关闭：面板要有名字也要有显式出口（九宫格时代两样都没有） */
  .more-sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 0 2px 4px;
  }

  .more-sheet-title {
    margin: 0;
    font-size: 17px;
    font-weight: 650;
    color: var(--text);
  }

  .more-sheet-close {
    width: 44px;
    height: 44px;
    /* 热区 44px，视觉靠负外边距贴回右上角，标题行不会被撑高 */
    margin: -6px -8px -6px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    color: var(--text-secondary);
  }

  .more-sheet-close:active { background: var(--sidebar-hover); }

  /* 账户行：只读展示（头像 + 本机名 / 同步状态），不做交互 */
  .more-account {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 2px 4px 12px;
  }

  .more-avatar {
    width: 46px;
    height: 46px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 18px;
    font-weight: 700;
  }

  .more-account-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .more-account-name {
    font-size: 16px;
    font-weight: 650;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .more-account-sub {
    font-size: 12.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 快捷动作：两颗并排的方块按钮，≥52px 高（拇指好点） */
  .more-quick {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 0 4px 12px;
  }

  .more-quick button {
    min-height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--sidebar-glass-border);
    border-radius: 12px;
    background: var(--card-bg);
    box-shadow: var(--shadow-raised);
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
  }

  .more-quick button:active { background: var(--sidebar-hover); }

  .more-quick-icon {
    display: flex;
    color: var(--sidebar-accent);
  }

  /* 列表：一张卡片里逐行排开；行高 ≥52px、行图标 44px 热区、行尾 chevron */
  .more-list {
    overflow: hidden;
    border: 1px solid var(--sidebar-glass-border);
    border-radius: 14px;
    background: var(--card-bg);
  }

  .more-row {
    position: relative;
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 4px;
    /* 行在列表卡片里是通铺的一条：圆角交给外层 .more-list 的 overflow 裁 */
    border-radius: 0;
    text-align: left;
    color: var(--text);
  }

  .more-row + .more-row::before,
  .more-appearance .more-row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 56px;
    right: 0;
    height: 1px;
    background: var(--sidebar-hairline);
  }

  .more-row:active { background: var(--press-bg); }

  .more-row-icon {
    position: relative;
    width: 44px;
    height: 44px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
  }

  .more-row-main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .more-row-title {
    font-size: 15px;
    font-weight: 550;
    line-height: 1.35;
    color: var(--text);
  }

  .more-row-sub {
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .more-row-chevron {
    flex: none;
    color: var(--text-faint);
  }

  .more-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 7px;
    height: 7px;
    border: 1.5px solid var(--card-bg);
    border-radius: 50%;
    background: var(--sidebar-accent);
  }

  /* 外观：三颗分段在 320px 窄屏上会跟标题挤成一排，改成标题行下面整宽排；按钮 44px 高 */
  .more-appearance { display: block; }

  .more-row-static { cursor: default; }
  .more-row-static:active { background: transparent; }

  .more-theme {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 2px 10px 12px 56px;
  }

  .more-theme button {
    height: 44px;
    border-radius: 10px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 12.5px;
    white-space: nowrap;
  }

  .more-theme button.active {
    background: var(--sidebar-selection-strong);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--sidebar-focus-ring);
  }

  .more-theme button:active { background: var(--sidebar-active); }

  /*
   * 触屏手机：底部导航整格 48px 已经够高，但 10px 标签在小屏上读不清；
   * 这里只加字号，不抬整条栏（抬高会连带改 .content 的让位高度）。
   */
  @media (hover: none) and (pointer: coarse) {
    .bottom-nav button span { font-size: 11px; }
  }
}

/*
 * 矮视口（手机横屏、分屏、折叠屏半开）：可视高度只有 320-400px。
 * 「更多」面板原来没有高度上限，5 列图标会顶出屏幕；底部导航也让位过多了。
 */
@media (max-height: 480px) {
  .more-sheet { max-height: calc(100dvh - 24px - var(--safe-top) - var(--safe-bottom)); }
}

.more-sheet-enter-active,
.more-sheet-leave-active {
  transition: transform 200ms ease, opacity 200ms ease;
}

.more-sheet-enter-from,
.more-sheet-leave-to {
  transform: translateY(24px);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .rail-logo,
  .rail-btn,
  .resizer::before,
  .sidebar-slide-enter-active,
  .sidebar-slide-leave-active,
  .fade-enter-active,
  .fade-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
