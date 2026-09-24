<template>
  <div
    class="layout"
    :class="{
      'sidebar-open': app.sidebarOpen,
      'chat-dock-open': chatDockOpen,
      'chat-dragging': app.chatDragging,
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
        v-tooltip.right="chat.hasRunning ? `内置 Agent 正在回复（${chat.runningCount} 个会话）` : '内置 Agent'"
        :aria-label="chat.hasRunning ? '内置 Agent（正在回复）' : '内置 Agent'"
        @click="app.toggleChat()"
      >
        <Icon name="ai" :size="19" />
        <span v-if="chat.hasRunning" class="rail-running" aria-hidden="true" />
        <span v-if="app.chatUnread" class="dot" />
      </button>

      <!-- 动作/面板组 -->
      <button class="rail-btn action" type="button" v-tooltip.right="'新建页面 (Ctrl+N)'" aria-label="新建页面" @click="quickNew">
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
        <span v-if="updateStore.hasNewVersion" class="dot" />
      </button>
    </nav>

    <!-- 文件树侧栏 -->
    <transition name="sidebar-slide">
      <aside
        v-show="app.sidebarOpen"
        class="sidebar"
        :style="{ width: sidebarWidth + 'px' }"
        aria-label="知识库侧边栏"
      >
        <Sidebar ref="sidebarRef" @close="app.sidebarOpen = false" @new-page="quickNew" />
      </aside>
    </transition>
    <!-- 拖动分隔条：桌面端 232–420px，且不超过窗口宽度的 40% -->
    <div
      v-if="app.sidebarOpen && !sidebarOverlay"
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
      <div v-if="app.sidebarOpen && sidebarOverlay" class="mask" @click="app.sidebarOpen = false" />
    </transition>

    <!-- 主内容区 -->
    <main class="content">
      <router-view />
    </main>

    <!-- 内置 Agent 聊天抽屉：桌面端是右侧悬浮卡片（正文让出它的宽度，不遮内容），≤1024px 覆盖正文；
         开合动画 drawer-slide 与左侧栏同一套节奏，具体样式在 ChatDrawer 里 -->
    <transition name="drawer-slide">
      <ChatDrawer v-if="app.chatDrawerOpen" :overlay="sidebarOverlay" />
    </transition>

    <!-- 内置 Agent 最小化后的常驻状态：有轮次在跑时任何视图都看得到，点它回到对话 -->
    <AgentStatusPill />

    <AppContextMenu />

    <!-- 移动端底部导航（聊天抽屉打开时让位，避免盖住输入区） -->
    <nav class="bottom-nav" :class="{ 'chat-open': app.chatDrawerOpen }">
      <button v-for="item in bottomItems" :key="item.label" type="button" @click="item.action">
        <Icon :name="item.icon" :size="20" /><span>{{ item.label }}</span>
      </button>
    </nav>

    <!-- 移动端「更多」面板：收纳 rail 上手机无处进入的入口 -->
    <Teleport to="body">
      <transition name="fade">
        <div v-if="moreOpen" class="more-mask" @click="moreOpen = false" />
      </transition>
      <transition name="more-sheet">
        <div v-if="moreOpen" class="more-sheet" role="dialog" aria-label="更多功能">
          <div class="more-sheet-bar" />
          <div class="more-grid">
            <button
              v-for="item in moreItems"
              :key="item.label"
              type="button"
              @click="item.action"
            >
              <span class="more-icon">
                <Icon :name="item.icon" :size="20" />
                <span v-if="item.running" class="more-running" aria-hidden="true" />
                <span v-if="item.dot" class="more-dot" />
              </span>
              <span class="more-label">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { useInboxStore } from '../stores/inbox';
import { useUpdateStore } from '../stores/update';
import { api } from '../api';
import { openPageStream } from '../lib/events';
import { notify } from '../lib/notify';
import { promptDialog } from '../lib/confirm';
import { loadRuntimeCapabilities, runtimeCapabilitiesSnapshot } from '../lib/capabilities';
import Sidebar from '../components/Sidebar.vue';
import ChatDrawer from '../components/ChatDrawer.vue';
import AgentStatusPill from '../components/AgentStatusPill.vue';
import AppContextMenu from '../components/AppContextMenu.vue';
import Icon from '../components/Icon.vue';
import BrandMark from '../components/BrandMark.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const updateStore = useUpdateStore();
const chat = useChatStore();
const inbox = useInboxStore();
const sidebarRef = ref<InstanceType<typeof Sidebar>>();

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

function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarWidth.value;
  const move = (ev: MouseEvent) => {
    sidebarWidth.value = clampSidebarWidth(startW + (ev.clientX - startX));
  };
  const up = () => {
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
    title: inbox.counts.pending
      ? `收集箱（${inbox.counts.pending} 个待整理）`
      : '收集箱',
    active: isActive('/inbox'),
    dot: inbox.counts.pending > 0,
    action: () => go('/inbox'),
  },
]);

const bottomItems = computed(() => [
  { label: '页面', icon: 'pages', action: () => { app.sidebarOpen = true; go('/page'); } },
  { label: '搜索', icon: 'search', action: () => go('/search') },
  { label: '新建', icon: 'plus', action: () => quickNew() },
  { label: '更多', icon: 'more', action: () => { moreOpen.value = true; } },
]);

/* 「更多」面板：rail 在 ≤768px 隐藏后，这些入口仅在此处可达 */
const moreOpen = ref(false);

function runMore(action: () => void) {
  moreOpen.value = false;
  action();
}

const moreItems = computed(() => [
  {
    label: '内置 Agent',
    icon: 'ai',
    dot: app.chatUnread,
    running: chat.hasRunning,
    action: () => runMore(() => app.toggleChat(true)),
  },
  {
    label: '知识图谱',
    icon: 'graph',
    dot: false,
    running: false,
    action: () => runMore(() => go('/graph')),
  },
  {
    label: '收集箱',
    icon: 'inbox',
    dot: inbox.counts.pending > 0,
    running: false,
    action: () => runMore(() => go('/inbox')),
  },
  {
    label: '设置',
    icon: 'settings',
    dot: updateStore.hasNewVersion,
    running: false,
    action: () => runMore(() => go('/settings')),
  },
]);

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

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    router.push('/search');
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    quickNew();
  }
}

/* ===== 软件更新自动检测：进入应用查一次（8 小时节流），有新版本时 toast 提醒 ===== */
async function autoCheckUpdate() {
  await loadRuntimeCapabilities();
  if (!runtimeCapabilitiesSnapshot().features.serverUpdate) return;
  await updateStore.check();
  if (updateStore.hasNewVersion && updateStore.lastResult) {
    notify.info(`发现新版本 v${updateStore.lastResult.latestVersion}，可在 设置 → 软件更新 中升级`);
  }
}

let closeStream: (() => void) | null = null;
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onWindowResize);
  loadRuntimeCapabilities().then((caps) => {
    if (caps.features.jobs) {
      jobPollStopped = false;
      pollJobs();
    }
    // Android 的本地 API 与 WebView 同进程，不建立常驻 SSE；保存操作会直接刷新对应界面。
    if (caps.runtime !== 'android-local') {
      // 服务端 SSE 实时推送：页面增删改/移动刷新正文与侧栏；Agent 提问弹在对话里，这里只提醒一句
      closeStream = openPageStream((ev) => {
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
      });
    }
  });
  autoCheckUpdate().catch(() => {});
  // 内置 Agent 正在跑的轮次要接上事件流：页面刷新后、或抽屉从没打开过，
  // 图标栏那颗「运行中」指示也得亮着（跑完还会亮小红点）。
  chat.syncRunningRuns().catch(() => {});
  // 图标栏「收集箱」角标：启动时取一次待整理数量
  inbox.load();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onWindowResize);
  jobPollStopped = true;
  if (jobTimer) clearTimeout(jobTimer);
  closeStream?.();
  closeStream = null;
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
  top: 8px;
  bottom: 8px;
  left: 8px;
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
  top: 8px;
  bottom: 8px;
  left: 60px;
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
  background: var(--bg);
  transition: padding-left 180ms ease, padding-right 180ms ease;
}

.layout.sidebar-open .content {
  padding-left: calc(var(--sidebar-width) + 72px);
}

/*
 * 内置 Agent 悬浮卡片打开：正文让出卡片宽度（贴边 8px + 呼吸 12px），
 * 与左侧文件树让位同一套节奏——两边都是「浮层出现、正文平移让位」，不是压住正文。
 */
.layout.chat-dock-open .content {
  padding-right: calc(var(--chat-w, 0px) + 20px);
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
    top: calc(8px + var(--win-titlebar-h, 0px));
    bottom: 8px;
    left: 60px;
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
    padding-left: 64px;
  }

  /* 触屏紧凑档：放大 rail 触控目标 */
  @media (hover: none) and (pointer: coarse) {
    .rail-btn { width: 36px; height: 36px; }
    .rail { padding: 6px 4px; }
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
    top: 8px;
    bottom: calc(64px + env(safe-area-inset-bottom));
    left: 8px;
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
    padding-bottom: calc(64px + env(safe-area-inset-bottom));
    padding-left: 0;
  }

  .layout.sidebar-open .content {
    padding-left: 0;
  }

  .bottom-nav {
    position: fixed;
    right: 8px;
    /* 手势条设备上整栏抬到手势条上方，内容在 48px 内垂直居中（border-box 下 padding 会压缩内容区导致偏移） */
    bottom: calc(8px + env(safe-area-inset-bottom));
    left: 8px;
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

  .bottom-nav button span { font-size: 10px; }

  /* 聊天抽屉在窄屏是整屏浮层：底部导航让位，否则盖住输入框与发送按钮 */
  .bottom-nav.chat-open { display: none; }

  /* 「更多」底部面板 */
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
    right: 8px;
    bottom: calc(64px + env(safe-area-inset-bottom));
    left: 8px;
    display: block;
    padding: 10px 14px 14px;
    border: 1px solid var(--sidebar-glass-border);
    border-radius: 16px;
    background: var(--sidebar-material);
    box-shadow: var(--sidebar-mobile-shadow);
    backdrop-filter: saturate(150%) blur(24px);
    -webkit-backdrop-filter: saturate(150%) blur(24px);
    z-index: calc(var(--z-chrome) + 1);
  }

  .more-sheet-bar {
    width: 36px;
    height: 4px;
    margin: 0 auto 12px;
    border-radius: 2px;
    background: var(--sidebar-hairline);
  }

  .more-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
  }

  .more-grid button {
    min-height: 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 10px;
    color: var(--text-secondary);
  }

  .more-grid button:active { background: var(--sidebar-hover); }

  .more-icon {
    position: relative;
    width: 42px;
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: var(--sidebar-selection);
    color: var(--text);
  }

  .more-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 7px;
    height: 7px;
    border: 1.5px solid var(--sidebar-glass-solid);
    border-radius: 50%;
    background: var(--sidebar-accent);
  }

  /* 「更多」面板里的运行中脉冲点（与 rail 上同一套动效） */
  .more-running {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sidebar-accent);
    animation: rail-pulse 1.6s ease-out infinite;
  }

  .more-label { font-size: 11px; }
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
