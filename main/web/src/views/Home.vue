<template>
  <div
    class="layout"
    :class="{ 'sidebar-open': app.sidebarOpen }"
    :style="{ '--sidebar-width': sidebarWidth + 'px' }"
  >
    <!-- 窄图标导航栏 -->
    <nav class="rail" aria-label="主导航">
      <button class="rail-logo" type="button" v-tooltip="'回到首页'" aria-label="回到首页" @click="$router.push('/page')">W</button>

      <!-- 侧栏开关 -->
      <button
        class="rail-btn action"
        type="button"
        :class="{ open: app.sidebarOpen }"
        v-tooltip="'app.sidebarOpen ? \'收起侧栏\' : \'展开侧栏\''"
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
        <span v-if="item.key === 'reports' && app.openReportCount" class="badge">
          {{ app.openReportCount > 99 ? '99+' : app.openReportCount }}
        </span>
      </button>

      <div class="rail-spacer" />

      <!-- 动作/面板组 -->
      <button class="rail-btn action" type="button" v-tooltip="'新建页面 (Ctrl+N)'" aria-label="新建页面" @click="quickNew">
        <Icon name="plus" :size="19" />
      </button>
      <button
        class="rail-btn action"
        type="button"
        :class="{ open: jobsPanelOpen }"
        v-tooltip="'AI 任务队列'"
        aria-label="AI 任务队列"
        :aria-pressed="jobsPanelOpen"
        @click="jobsPanelOpen = !jobsPanelOpen"
      >
        <Icon name="activity" :size="19" />
        <span v-if="app.activeJobCount > 0" class="badge">{{ app.activeJobCount > 99 ? '99+' : app.activeJobCount }}</span>
      </button>
      <button
        class="rail-btn action"
        type="button"
        :class="{ open: app.aiDrawerOpen }"
        v-tooltip="'AI 助手 (Ctrl+J)'"
        aria-label="AI 助手"
        :aria-pressed="app.aiDrawerOpen"
        @click="app.toggleAi()"
      >
        <Icon name="ai" :size="19" />
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
      v-if="app.sidebarOpen && !isMobile"
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
      <div v-if="app.sidebarOpen && isMobile" class="mask" @click="app.sidebarOpen = false" />
    </transition>

    <!-- 主内容区 -->
    <main class="content">
      <router-view />
    </main>

    <!-- AI 抽屉 -->
    <transition name="slide">
      <aside v-show="app.aiDrawerOpen" class="ai-drawer">
        <AiDrawer />
      </aside>
    </transition>

    <!-- AI 任务队列面板 -->
    <transition name="slide">
      <JobsPanel v-if="jobsPanelOpen" @close="jobsPanelOpen = false" />
    </transition>

    <AppContextMenu />

    <!-- 移动端底部导航 -->
    <nav class="bottom-nav">
      <button v-for="item in bottomItems" :key="item.label" type="button" @click="item.action">
        <Icon :name="item.icon" :size="20" /><span>{{ item.label }}</span>
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { useAssistantStore } from '../stores/assistant';
import { api } from '../api';
import { openPageStream } from '../lib/events';
import Sidebar from '../components/Sidebar.vue';
import AiDrawer from '../components/AiDrawer.vue';
import JobsPanel from '../components/JobsPanel.vue';
import AppContextMenu from '../components/AppContextMenu.vue';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const assistant = useAssistantStore();
const sidebarRef = ref<InstanceType<typeof Sidebar>>();
const jobsPanelOpen = ref(false);

/* ===== AI 任务队列：自适应轮询（活跃 1.5s / 空闲 6s），状态存 app store 供角标/面板/侧栏共用 ===== */
let jobPollStopped = true;
let jobTimer: ReturnType<typeof setTimeout>;
async function pollJobs() {
  await app.refreshJobs();
  // 有活跃任务时同步刷新侧栏（整理后可能生成新页面）
  if (app.activeJobCount > 0) sidebarRef.value?.load();
  if (!jobPollStopped) jobTimer = setTimeout(pollJobs, app.activeJobCount > 0 ? 1500 : 6000);
}

/* ===== 侧栏宽度拖拽 ===== */
const MIN_SIDEBAR = 232;
const MAX_SIDEBAR = 420;
const DEFAULT_SIDEBAR = 280;
const viewportWidth = ref(window.innerWidth);
const isMobile = computed(() => viewportWidth.value <= 768);
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
  viewportWidth.value = window.innerWidth;
  if (!isMobile.value) {
    const clamped = clampSidebarWidth(sidebarWidth.value);
    if (clamped !== sidebarWidth.value) setSidebarWidth(clamped);
  }
}

const isActive = (p: string) => route.path.startsWith(p);

const navItems = computed(() => [
  { key: 'search', icon: 'search', title: '搜索 / 问AI (Ctrl+K)', active: isActive('/search'), action: () => router.push('/search') },
  { key: 'graph', icon: 'graph', title: '知识图谱', active: isActive('/graph'), action: () => router.push('/graph') },
  { key: 'reports', icon: 'report', title: '整理报告', active: isActive('/reports'), action: () => router.push('/reports') },
]);

const bottomItems = computed(() => [
  { label: '页面', icon: 'pages', action: () => { app.sidebarOpen = true; router.push('/page'); } },
  { label: '搜索', icon: 'search', action: () => router.push('/search') },
  { label: '新建', icon: 'plus', action: () => quickNew() },
  { label: 'AI', icon: 'ai', action: () => app.toggleAi() },
]);

async function quickNew() {
  const title = prompt('页面标题：', '未命名页面');
  if (title === null) return;
  const { data } = await api.post('/api/pages', { dir: 'Wiki', title: title || '未命名页面' });
  sidebarRef.value?.load();
  router.push(`/page/${data.meta.id}`);
}

async function loadReportCount() {
  try {
    const { data } = await api.get('/api/dream/reports?status=open');
    // 追问类仅作提示，不计入角标
    app.openReportCount = data.reports.filter((r: any) => r.kind !== 'ingest_questions').length;
  } catch { /* ignore */ }
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    router.push('/search');
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
    e.preventDefault();
    app.toggleAi();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    quickNew();
  }
}

function onAssistantUpload() {
  app.sidebarOpen = true;
  nextTick(() => sidebarRef.value?.openUpload());
}

let reportTimer: ReturnType<typeof setInterval>;
let closeStream: (() => void) | null = null;
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onWindowResize);
  loadReportCount();
  reportTimer = setInterval(loadReportCount, 60_000);
  jobPollStopped = false;
  pollJobs();
  assistant.init().catch(() => {});
  window.addEventListener('assistant-open-upload', onAssistantUpload);
  // 服务端 SSE 实时推送：页面增删改/移动时刷新正文与侧栏
  closeStream = openPageStream((ev) => app.applyPageEvent(ev));
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onWindowResize);
  clearInterval(reportTimer);
  jobPollStopped = true;
  if (jobTimer) clearTimeout(jobTimer);
  window.removeEventListener('assistant-open-upload', onAssistantUpload);
  assistant.closeEvents();
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
  border-radius: 12px;
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
  color: #fff;
  background: var(--sidebar-accent);
  box-shadow: var(--rail-logo-shadow);
  font-size: 14px;
  font-weight: 700;
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
  border-radius: 7px;
  color: var(--text-secondary);
  transition: background 150ms ease, color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}

.rail-btn:hover {
  color: var(--text);
  background: var(--sidebar-hover);
}

.rail-btn:active {
  transform: scale(0.96);
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

.rail-btn.open {
  color: var(--sidebar-accent);
  background: transparent;
}

.rail-btn.open:hover {
  background: var(--sidebar-hover);
}

.rail-btn .badge {
  position: absolute;
  top: -3px;
  right: -5px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border: 2px solid var(--sidebar-glass-solid);
  border-radius: 8px;
  font-size: 9px;
  line-height: 13px;
  font-variant-numeric: tabular-nums;
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
  border-radius: 12px;
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

.slide-enter-active,
.slide-leave-active {
  transition: transform 180ms ease, opacity 180ms ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(30px);
  opacity: 0;
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

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .rail { background: var(--sidebar-rail-solid); }
  .sidebar { background: var(--sidebar-material-solid); }
}

@media (max-width: 768px) {
  .rail { display: none; }

  .sidebar {
    position: fixed;
    top: 8px;
    bottom: 64px;
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
    padding-bottom: 64px;
    padding-left: 0;
  }

  .layout.sidebar-open .content {
    padding-left: 0;
  }

  .ai-drawer { position: fixed; inset: 0 0 60px 0; width: 100%; border-left: none; }

  .bottom-nav {
    position: fixed;
    right: 8px;
    bottom: 8px;
    left: 8px;
    display: flex;
    height: 48px;
    padding-bottom: env(safe-area-inset-bottom);
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
}

@media (prefers-reduced-motion: reduce) {
  .rail-logo,
  .rail-btn,
  .resizer::before,
  .slide-enter-active,
  .slide-leave-active,
  .sidebar-slide-enter-active,
  .sidebar-slide-leave-active,
  .fade-enter-active,
  .fade-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
