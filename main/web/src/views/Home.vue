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
      /* 设备矩阵（2026-11）：windowSizeClass 三档由 JS 判定，类名承载布局切换 */
      'size-compact': sizeClass === 'compact',
      'size-medium': sizeClass === 'medium',
      'size-expanded': sizeClass === 'expanded',
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

    <!-- 主内容区：下拉刷新指示器挂在滚动容器里，只有 ≤839 触屏的顶层页会出现 -->
    <main ref="contentEl" class="content">
      <div
        v-if="pullAvailable"
        class="pull-refresh"
        :class="[pullIndicatorClass, { pulling: pullOffset > 0, refreshing }]"
        :style="{ transform: 'translate(-50%, ' + (pullOffset - 46) + 'px)' }"
        aria-hidden="true"
      >
        <span class="pull-ring">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <circle class="pull-track" cx="12" cy="12" r="9" />
            <circle
              class="pull-arc"
              cx="12"
              cy="12"
              r="9"
              :style="{ strokeDashoffset: 56.55 * (1 - pullProgress) + 'px' }"
            />
          </svg>
        </span>
        <span class="pull-label">{{ refreshing ? '刷新中…' : pullProgress >= 1 ? '松开刷新' : '下拉刷新' }}</span>
      </div>
      <router-view />
    </main>

    <UpdateNotice @change="onUpdateNoticeChange" />

    <!-- 内置 Agent 聊天抽屉：桌面端是右侧悬浮卡片（正文让出它的宽度，不遮内容），<840px 覆盖正文；
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

    <!-- 手机新建 FAB（≤839、首页、知识库抽屉收起时）：底栏在时抬到栏上方 88px，medium 贴右下 24px -->
    <transition name="fab-pop">
      <button v-if="newFabVisible" class="new-fab" type="button" aria-label="新建" @click="openNewSheet">
        <Icon name="plus" :size="20" />
        <span>新建</span>
      </button>
    </transition>

    <!-- 「新建」选择面板（2026-11 安卓改版）：一个入口一件事——新建页面 / 记灵感 / 收进收集箱 / 扫码绑定 -->
    <Teleport to="body">
      <transition name="fade">
        <div v-if="newSheetOpen" class="new-mask" @click="newSheetOpen = false" />
      </transition>
      <transition name="more-sheet">
        <div
          v-if="newSheetOpen"
          class="new-sheet"
          :class="{ 'no-nav': sizeClass !== 'compact' }"
          role="dialog"
          aria-modal="true"
          aria-label="新建"
        >
          <div class="new-sheet-bar" />
          <div class="new-sheet-head">
            <h2 class="new-sheet-title">新建</h2>
            <button class="new-sheet-close" type="button" aria-label="关闭新建面板" @click="newSheetOpen = false">
              <Icon name="x" :size="20" />
            </button>
          </div>
          <div class="new-sheet-actions">
            <button
              v-for="action in newActions"
              :key="action.key"
              type="button"
              class="new-action"
              @click="runNewAction(action.action)"
            >
              <span class="new-action-icon"><Icon :name="action.icon" :size="20" /></span>
              <span class="new-action-main">
                <span class="new-action-title">{{ action.label }}</span>
                <span v-if="action.sub" class="new-action-sub">{{ action.sub }}</span>
              </span>
              <Icon name="chevron-right" :size="18" class="new-action-chevron" />
            </button>
          </div>
        </div>
      </transition>
    </Teleport>

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
import { useTouchPointer } from '../lib/pointer';
import { syncStatusView } from '../lib/syncStatus';
import { syncChannelView } from '../lib/syncChannel';
import { windowSizeClassFor } from '../lib/windowSizeClass';
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
/*
 * 设备矩阵（2026-11 安卓改版）：按 lib/windowSizeClass 的 600 / 840 三档给壳层换骨架，
 * 不再用「768 / 1024 两个宽度布尔」各写一套（用户报障：折叠屏展开瞬间界面会跳一套语言）。
 *   compact  <600   手机竖屏 / 折叠屏合上：五项底栏 + 抽屉侧栏（CSS 见 ≤768 兜底块）
 *   medium   600–839 折叠屏展开 / 手机横屏 / 小平板：rail + 无底栏；侧栏仍是浮层抽屉
 *   expanded ≥840   平板横屏 / 桌面网页：rail + 常驻侧栏（桌面三栏，行为不变）
 * CSS 侧用 .layout.size-* 类承接（见样式里的「设备矩阵」段）；窗口变化由 onWindowResize 同步。
 */
const sizeClass = computed(() => windowSizeClassFor(viewportWidth.value));
/** 侧栏浮层：<840（compact + medium 都是抽屉）；≥840 走常驻侧栏，正文按侧栏宽度让位 */
const sidebarOverlay = computed(() => sizeClass.value !== 'expanded');
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
  const prevSize = sizeClass.value;
  viewportWidth.value = window.innerWidth;
  // 跨入浮层档位时收起侧栏，避免展开的桌面侧栏瞬间盖住内容
  if (!prevOverlay && sidebarOverlay.value) app.sidebarOpen = false;
  /*
   * 尺寸等级变了：浮层面板与下拉手势的可用性跟着变（FAB 只在 ≤839、底栏只在 <600 出现），
   * 开着就收掉，免得跨档后留下一个没有入口的浮层。
   */
  if (prevSize !== sizeClass.value) {
    moreOpen.value = false;
    newSheetOpen.value = false;
    abortPull();
  }
  if (sizeClass.value !== 'compact') {
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

/* ===== 手机底部导航（compact，<600）：五个顶层入口 =====
 * 桌面端看不到这一条；600–839（medium）起由 .layout.size-medium 隐藏、换成左侧 rail，
 * 标签项仍在这里统一定义（数据与桌面 rail 共用一份）。
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

/* 「我的」面板列表：rail 在 compact（<600）隐藏后，这些入口仅在此处可达。
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

/* ===== 下拉刷新（2026-11 设备矩阵）：只给 ≤839 触屏的顶层页，内容在顶部时下拉触发一次同步刷新 =====
 * 手势纪律（与抽屉横滑同一套判定）：
 *  - 只接管「在顶部继续往下拉」；上滑、横滑立刻交还给页面（收集箱卡片横滑、列表滚动都不受干扰）；
 *  - 触点按下去先找真正的纵向滚动容器（首页看板 / 收集箱卡片台各有自己的滚动层），
 *    容器不在顶部就不开始跟手，避免在文章里下拉也把整页拉动；
 *  - 阈值 64px、跟手阻尼 0.55、最多 96px；过阈值松手才刷新，否则回弹。
 * 桌面（≥840）与鼠标操作完全不启用。
 */
const PULL_THRESHOLD = 64;
const PULL_MAX = 96;
/** 只有这三个顶层页支持下拉刷新；/page/:id（阅读）自己管滚动，不抢它的手势 */
const PULL_ROUTES = ['/page', '/inbox', '/tasks'];
const contentEl = ref<HTMLElement>();
const touchPointer = useTouchPointer();
const pullOffset = ref(0);
const refreshing = ref(false);
let detachPullRefresh: (() => void) | null = null;
let pullTracking = false;
let pullScroller: HTMLElement | null = null;
let pullStartY = 0;
let pullStartX = 0;
let pullIntent: 'none' | 'pull' | 'scroll' = 'none';
let pullThresholdHaptic = false;

const pullAvailable = computed(() =>
  sizeClass.value !== 'expanded' && touchPointer.value && PULL_ROUTES.includes(route.path)
);
const pullProgress = computed(() => Math.min(1, pullOffset.value / PULL_THRESHOLD));
/** 进度环取连接通道色（与同步状态同一套令牌），没配置同步时退回强调色 */
const pullIndicatorClass = computed(() => {
  const view = syncChannelView(sync.status);
  return view ? `link-${view.key}` : '';
});

/** 从触点往上找真正的纵向滚动容器；找不到就退回外壳 .content */
function findPullScroller(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof Element ? (target as HTMLElement) : null;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) return el;
    if (el === contentEl.value) break;
    el = el.parentElement;
  }
  return contentEl.value ?? null;
}

function resetPull() {
  pullTracking = false;
  pullIntent = 'none';
  pullOffset.value = 0;
}

/** 放弃本次下拉（子组件接管了触摸 / 滚动容器已经离开顶部） */
function abortPull() {
  if (!pullTracking && pullOffset.value === 0) return;
  resetPull();
}

/** 跟手位移：阻尼后的像素值（松手回弹由 CSS 过渡完成） */
function installPullRefresh(el: HTMLElement): () => void {
  const onStart = (event: TouchEvent) => {
    if (!pullAvailable.value || refreshing.value || event.touches.length !== 1) return;
    const scroller = findPullScroller(event.target);
    if (!scroller || scroller.scrollTop > 0) return;
    pullScroller = scroller;
    pullStartY = event.touches[0].clientY;
    pullStartX = event.touches[0].clientX;
    pullTracking = true;
    pullIntent = 'none';
    pullThresholdHaptic = false;
  };

  const onMove = (event: TouchEvent) => {
    if (!pullTracking || event.touches.length !== 1) return;
    // 子组件（卡片横滑、面板……）已经接管这次触摸：让给它
    if (event.defaultPrevented || (pullScroller?.scrollTop ?? 0) > 0) {
      abortPull();
      return;
    }
    const dy = event.touches[0].clientY - pullStartY;
    const dx = event.touches[0].clientX - pullStartX;
    if (pullIntent === 'none') {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      // 只接管「从顶部往下拉」：上滑 / 横滑立刻交还给页面
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) * 1.2) {
        pullTracking = false;
        pullIntent = 'scroll';
        pullOffset.value = 0;
        return;
      }
      pullIntent = 'pull';
    }
    if (event.cancelable) event.preventDefault();
    pullOffset.value = Math.min(PULL_MAX, dy * 0.55);
    // 过阈值只轻振一次：告诉用户「现在松手会刷新」
    if (!pullThresholdHaptic && pullOffset.value >= PULL_THRESHOLD) {
      pullThresholdHaptic = true;
      haptic('tap');
    }
  };

  const onEnd = () => {
    if (!pullTracking) return;
    const distance = pullOffset.value;
    pullTracking = false;
    pullIntent = 'none';
    if (distance >= PULL_THRESHOLD) void finishPullRefresh();
    else pullOffset.value = 0;
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

/** 松手后的刷新：保持「刷新中…」一小会儿再回弹，完成落一条 toast */
async function finishPullRefresh() {
  refreshing.value = true;
  pullOffset.value = 56;
  const startedAt = Date.now();
  try {
    await refreshTopLevel();
  } finally {
    const remain = 420 - (Date.now() - startedAt);
    if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain));
    refreshing.value = false;
    pullOffset.value = 0;
    notify.success('已刷新');
  }
}

/** 顶层页刷新：先对一次同步账（共享 sync store），再按当前页重读数据；能力位顺手重取（有缓存就不发请求） */
async function refreshTopLevel() {
  await Promise.all([
    sync.refresh().catch(() => undefined),
    inbox.load().catch(() => undefined),
    loadRuntimeCapabilities().catch(() => undefined),
  ]);
  if (route.path === '/page') {
    app.bumpSidebar();
    void homeBoard.load();
  } else if (route.path === '/tasks') {
    void homeTasks.load();
  }
}

/* ===== 新建 FAB + 选择面板（2026-11 安卓改版）=====
 * 手机 / 折叠屏（≤839）在知识库首页、目录抽屉收起时出现：底栏在时抬到栏上方，
 * medium 没有底栏就贴右下 24px。一个入口一件事：新建页面 / 记一条灵感 / 收进收集箱 / 扫码绑定。
 */
const newSheetOpen = ref(false);
const newFabVisible = computed(() =>
  sizeClass.value !== 'expanded'
    // 面板/抽屉打开时让位：浮层是半透明的，蓝色 FAB 留在后面会透出一块色斑
    && !app.sidebarOpen
    && !app.chatDrawerOpen
    && !moreOpen.value
    && !newSheetOpen.value
    && route.path === '/page'
);

function openNewSheet() {
  haptic('tap');
  newSheetOpen.value = true;
}

/** 选完先收面板再做事：建页/跳转要能马上看到，面板不能压在目标页上 */
function runNewAction(action: () => void) {
  newSheetOpen.value = false;
  action();
}

interface NewSheetAction {
  key: string;
  label: string;
  sub?: string;
  icon: string;
  action: () => void;
}

const newActions = computed<NewSheetAction[]>(() => [
  { key: 'page', label: '新建页面', sub: '打开一张空白 Wiki 页面直接写', icon: 'plus', action: () => quickNew() },
  { key: 'idea', label: '记一条灵感', sub: '写进 原始资料/灵感碎片', icon: 'lightbulb', action: () => quickNote() },
  { key: 'inbox', label: '收进收集箱', sub: '先放进去，回头再整理', icon: 'inbox', action: () => go('/inbox') },
  { key: 'scan', label: '扫码绑定中枢', sub: '对准中枢上的二维码完成绑定', icon: 'qr', action: () => go('/settings?section=sync') },
]);

/** 换了页面就把手势复位（滚动位置是新的，不能带着上一页的跟手位移） */
watch(() => route.path, () => abortPull());

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
    if (newSheetOpen.value) {
      newSheetOpen.value = false;
      return true;
    }
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
  // 下拉刷新手势：.content 是外壳滚动容器（router-view 切换不清空它），挂载时装一次即可
  if (contentEl.value) detachPullRefresh = installPullRefresh(contentEl.value);
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
  detachPullRefresh?.();
  detachPullRefresh = null;
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
  /* 下拉刷新自己接管「顶部继续往下拉」：别让浏览器再叠一层 overscroll 光晕/滚动链 */
  overscroll-behavior-y: contain;
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
 * width / max-width 带 !important：浮层档（<840px）把侧栏当浮层写死了 min() 与 400px 上限，
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

/*
 * 壳层新增件（2026-11 设备矩阵）：宽度切换由 .layout.size-* 类承接（见下方「设备矩阵」段），
 * 这里只写与尺寸档无关的下拉刷新 / 新建 FAB / 新建面板样式。
 */

/* ---- 下拉刷新指示器：贴在滚动容器顶部，跟手位移由模板内联 transform 给 ---- */
.pull-refresh {
  position: absolute;
  top: 0;
  left: 50%;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.4;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
}

.pull-refresh.pulling,
.pull-refresh.refreshing { opacity: 1; }

/* 松手回弹才做过渡；跟手中（.pulling）必须一像素不差地贴着手指 */
.pull-refresh:not(.pulling) { transition: transform 200ms ease, opacity 160ms ease; }

.pull-ring { display: flex; flex: none; }
.pull-ring svg { display: block; transform: rotate(-90deg); }
.pull-track { stroke: var(--border-strong); stroke-width: 2.4; }
.pull-arc {
  stroke: var(--channel, var(--accent));
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-dasharray: 56.55px;
  transition: stroke-dashoffset 80ms linear;
}
.pull-refresh.refreshing .pull-ring svg { animation: pull-spin 900ms linear infinite; }

@keyframes pull-spin {
  to { transform: rotate(270deg); }
}

@media (prefers-reduced-motion: reduce) {
  .pull-refresh.refreshing .pull-ring svg { animation: none; }
}

/* ---- 新建 FAB（≤839）：底栏在时抬到栏上方 88px，medium 无底栏时贴右下 24px ---- */
.new-fab {
  position: fixed;
  right: calc(16px + var(--safe-right));
  bottom: calc(88px + var(--safe-bottom));
  z-index: calc(var(--z-chrome) + 1);
  height: 56px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 20px 0 18px;
  border-radius: 18px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 15px;
  font-weight: 600;
  box-shadow: var(--shadow-dialog);
}

.new-fab:active { background: var(--accent-pressed); }

/* 软键盘弹起时底栏与常驻胶囊都收起了，FAB 也别挡输入区 */
html.kb-open .new-fab { display: none; }

.fab-pop-enter-active,
.fab-pop-leave-active { transition: opacity 160ms ease, transform 160ms ease; }

.fab-pop-enter-from,
.fab-pop-leave-to { opacity: 0; transform: translateY(10px) scale(0.96); }

/* ---- 「新建」选择面板（Teleport 到 body，宽度档无关）---- */
.new-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 15, 15, 0.26);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  z-index: var(--z-chrome);
}

.new-sheet {
  position: fixed;
  right: calc(8px + var(--safe-right));
  bottom: calc(64px + var(--safe-bottom));
  left: calc(8px + var(--safe-left));
  padding: 10px 14px 14px;
  border: 1px solid var(--sidebar-glass-border);
  border-radius: 16px;
  background: var(--sidebar-material);
  box-shadow: var(--sidebar-mobile-shadow);
  backdrop-filter: saturate(150%) blur(24px);
  -webkit-backdrop-filter: saturate(150%) blur(24px);
  max-height: calc(100dvh - 72px - var(--safe-top) - var(--safe-bottom));
  overflow-y: auto;
  z-index: calc(var(--z-chrome) + 1);
}

/* medium 起没有底栏：面板直接贴底，只让开系统手势条 */
.new-sheet.no-nav { bottom: calc(8px + var(--safe-bottom)); }

.new-sheet-bar {
  width: 36px;
  height: 4px;
  margin: 0 auto 8px;
  border-radius: 2px;
  background: var(--sidebar-hairline);
}

.new-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 0 2px 4px;
}

.new-sheet-title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  color: var(--text);
}

.new-sheet-close {
  width: 44px;
  height: 44px;
  margin: -6px -8px -6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--text-secondary);
}

.new-sheet-close:active { background: var(--sidebar-hover); }

.new-sheet-actions { display: flex; flex-direction: column; }

.new-action {
  position: relative;
  width: 100%;
  min-height: 60px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 6px 8px 4px;
  text-align: left;
  color: var(--text);
}

.new-action + .new-action::before {
  content: '';
  position: absolute;
  top: 0;
  left: 60px;
  right: 6px;
  height: 1px;
  background: var(--sidebar-hairline);
}

.new-action:active { background: var(--press-bg); }

.new-action-icon {
  width: 44px;
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--sidebar-selection);
  color: var(--sidebar-accent);
}

.new-action-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.new-action-title { font-size: 15px; font-weight: 600; }
.new-action-sub { font-size: 12.5px; color: var(--text-secondary); }
.new-action-chevron { flex: none; color: var(--text-faint); }

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .rail { background: var(--sidebar-rail-solid); }
  .sidebar { background: var(--sidebar-material-solid); }
}

/*
 * compact 兜底块（≤768 媒体查询）：<600 的手机直接吃满这一块；
 * 600–768 已经进入 medium，由文件末尾「设备矩阵」段的 .size-medium 规则压掉
 * （rail 重新显示、底栏隐藏、正文让开 72px）。
 */
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
 * 设备矩阵（2026-11 安卓改版）：windowSizeClass 的 600 / 840 两档由 .layout.size-* 类承载。
 * 这里不新增宽度 @media——全库断点白名单只管桌面三档（640/768/1024），600/840 是
 * Android WindowSizeClass 的另一套口径，写在 lib/windowSizeClass.ts 并由 JS 判档。
 *   compact  <600   ：五项底栏 + 抽屉侧栏（上面的 ≤768 兜底块已经给全）
 *   medium   600–839：rail + 无底栏；侧栏仍是浮层抽屉；正文让开 rail 72px
 *   expanded ≥840   ：rail + 常驻侧栏（回到本文件的基础桌面样式，桌面行为不变）
 */
.layout.size-medium .rail { display: flex; }

/* 600–839 不再有底栏：正文底部只让开系统栏 */
.layout.size-medium .bottom-nav { display: none; }

.layout.size-medium .content,
.layout.size-medium.sidebar-open .content {
  padding-left: calc(72px + var(--safe-left));
  padding-bottom: var(--safe-bottom);
}

/* 侧栏在 medium 仍是浮层抽屉：贴 rail 右侧、限宽、带遮罩；满窗（sidebar-full）仍走基础样式 */
.layout.size-medium:not(.sidebar-full) .sidebar {
  position: fixed;
  top: calc(8px + var(--win-titlebar-h, 0px) + var(--safe-top));
  bottom: calc(8px + var(--safe-bottom));
  left: calc(60px + var(--safe-left));
  width: min(var(--sidebar-width), calc(100vw - 80px)) !important;
  max-width: 400px;
  box-shadow: var(--sidebar-mobile-shadow);
  z-index: var(--z-sidebar);
}

.layout.size-medium .mask {
  position: fixed;
  inset: 0;
  display: block;
  background: rgba(15, 15, 15, 0.26);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  z-index: var(--z-mask);
}

.layout.size-medium .resizer { display: none; }

/* FAB：medium 没有底栏，贴右下 24px（compact 的 88px 见上面的 .new-fab 基础样式） */
.layout.size-medium .new-fab { bottom: calc(24px + var(--safe-bottom)); }

/* 触屏（折叠屏内屏 / 平板 / 横屏手机）：rail 图标用不可见热区补到 44px，视觉尺寸不变 */
@media (hover: none) and (pointer: coarse) {
  .layout.size-medium .rail-btn,
  .layout.size-expanded .rail-btn {
    width: 36px;
    height: 36px;
  }

  .layout.size-medium .rail,
  .layout.size-expanded .rail { padding: 6px 4px; }

  .layout.size-medium .rail-btn::after,
  .layout.size-medium .rail-logo::after,
  .layout.size-expanded .rail-btn::after,
  .layout.size-expanded .rail-logo::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 10px;
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
