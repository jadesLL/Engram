<template>
  <div
    class="layout"
    :class="{ 'sidebar-open': app.sidebarOpen }"
    :style="{ '--sidebar-width': sidebarWidth + 'px' }"
  >
    <!-- 窄图标导航栏 -->
    <nav class="rail" aria-label="主导航">
      <button class="rail-logo" type="button" v-tooltip="'回到首页'" aria-label="回到首页" @click="$router.push('/page')">
        <svg viewBox="0 0 100 100" width="20" height="20" aria-hidden="true">
          <defs>
            <linearGradient id="engram-orbit-rail" gradientUnits="userSpaceOnUse" x1="24" y1="76" x2="76" y2="22">
              <stop offset="0" stop-color="#22D3EE" />
              <stop offset="1" stop-color="#4D8AFF" />
            </linearGradient>
            <linearGradient id="engram-core-rail" gradientUnits="userSpaceOnUse" x1="39" y1="39" x2="61" y2="61">
              <stop offset="0" stop-color="#4D8AFF" />
              <stop offset="1" stop-color="#245BDB" />
            </linearGradient>
          </defs>
          <ellipse cx="50" cy="50" rx="36" ry="15.5" fill="none" stroke="url(#engram-orbit-rail)" stroke-width="8.5" transform="rotate(-28 50 50)" />
          <circle cx="74" cy="28.5" r="5" fill="#22D3EE" />
          <circle cx="50" cy="50" r="11" fill="url(#engram-core-rail)" />
        </svg>
      </button>

      <!-- 侧栏开关 -->
      <button
        class="rail-btn action"
        type="button"
        :class="{ open: app.sidebarOpen }"
        v-tooltip="app.sidebarOpen ? '收起侧栏' : '展开侧栏'"
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
        v-tooltip="item.title"
        :aria-label="item.title"
        :aria-current="item.active ? 'page' : undefined"
        @click="item.action"
      >
        <Icon :name="item.icon" :size="19" />
      </button>

      <div class="rail-spacer" />

      <!-- 内置 Agent（聊天抽屉） -->
      <button
        class="rail-btn"
        type="button"
        :class="{ active: app.chatDrawerOpen }"
        v-tooltip="'内置 Agent'"
        aria-label="内置 Agent"
        @click="app.toggleChat()"
      >
        <Icon name="ai" :size="19" />
        <span v-if="app.chatUnread" class="dot" />
      </button>

      <!-- 动作/面板组 -->
      <button class="rail-btn action" type="button" v-tooltip="'新建页面 (Ctrl+N)'" aria-label="新建页面" @click="quickNew">
        <Icon name="plus" :size="19" />
      </button>
      <div class="rail-divider" />

      <!-- 设置（导航） -->
      <button
        class="rail-btn"
        type="button"
        :class="{ active: isActive('/settings') }"
        v-tooltip="'设置'"
        aria-label="设置"
        :aria-current="isActive('/settings') ? 'page' : undefined"
        @click="$router.push('/settings')"
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

    <!-- 内置 Agent 聊天抽屉：桌面端占位并排，≤1024px 覆盖正文 -->
    <ChatDrawer v-if="app.chatDrawerOpen" :overlay="sidebarOverlay" />

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
import { useUpdateStore } from '../stores/update';
import { api } from '../api';
import { openPageStream } from '../lib/events';
import { notify } from '../lib/notify';
import { promptDialog } from '../lib/confirm';
import { loadRuntimeCapabilities, runtimeCapabilitiesSnapshot } from '../lib/capabilities';
import Sidebar from '../components/Sidebar.vue';
import ChatDrawer from '../components/ChatDrawer.vue';
import AppContextMenu from '../components/AppContextMenu.vue';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const updateStore = useUpdateStore();
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

const navItems = computed(() => [
  { key: 'search', icon: 'search', title: '搜索 (Ctrl+K)', active: isActive('/search'), action: () => router.push('/search') },
  { key: 'graph', icon: 'graph', title: '知识图谱', active: isActive('/graph'), action: () => router.push('/graph') },
]);

const bottomItems = computed(() => [
  { label: '页面', icon: 'pages', action: () => { app.sidebarOpen = true; router.push('/page'); } },
  { label: '搜索', icon: 'search', action: () => router.push('/search') },
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
    action: () => runMore(() => app.toggleChat(true)),
  },
  {
    label: '知识图谱',
    icon: 'graph',
    dot: false,
    action: () => runMore(() => router.push('/graph')),
  },
  {
    label: '设置',
    icon: 'settings',
    dot: updateStore.hasNewVersion,
    action: () => runMore(() => router.push('/settings')),
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
      closeStream = openPageStream((ev) => app.applyPageEvent(ev));
    }
  });
  autoCheckUpdate().catch(() => {});
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
  overflow: hidden;
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
  background: #0f172a;
  box-shadow: var(--rail-logo-shadow);
  user-select: none;
  transition: filter 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}

.rail-logo:hover {
  filter: brightness(1.06);
  box-shadow: var(--rail-logo-shadow-hover);
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
  transition: padding-left 180ms ease;
}

.layout.sidebar-open .content {
  padding-left: calc(var(--sidebar-width) + 72px);
}

.ai-drawer {
  width: clamp(400px, 34vw, 520px);
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg);
  z-index: var(--z-drawer);
}

/* 超过视口 70% 时脱离文档流，覆盖正文区，只留左侧栏可见 */
.ai-drawer.overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 60px;
  right: 0;
  width: auto;
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.08);
  z-index: var(--z-sidebar);
}

.ai-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  background: transparent;
  outline: none;
  z-index: calc(var(--z-sidebar) + 1);
}

.ai-resizer:hover,
.ai-resizer:focus-visible {
  background: var(--sidebar-accent);
  opacity: 0.35;
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

  .ai-drawer { width: clamp(300px, 30vw, 380px); }

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

  .ai-drawer { position: fixed; inset: 0 calc(60px + env(safe-area-inset-bottom)) 0 0; width: 100%; border-left: none; }

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
