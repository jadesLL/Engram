<template>
  <div class="layout">
    <!-- 窄图标导航栏 -->
    <nav class="rail">
      <div class="rail-logo" title="LLM Wiki">W</div>

      <!-- 侧栏开关（动作按钮，永不高亮） -->
      <button
        class="rail-btn action"
        :title="app.sidebarOpen ? '收起侧栏' : '展开侧栏'"
        @click="app.sidebarOpen = !app.sidebarOpen"
      >
        <Icon name="pages" :size="19" />
      </button>

      <div class="rail-divider" />

      <!-- 导航组（路由高亮=灰底） -->
      <button
        v-for="item in navItems"
        :key="item.key"
        class="rail-btn"
        :class="{ active: item.active }"
        :title="item.title"
        @click="item.action"
      >
        <Icon :name="item.icon" :size="19" />
        <span v-if="item.key === 'reports' && app.openReportCount" class="badge">
          {{ app.openReportCount > 99 ? '99+' : app.openReportCount }}
        </span>
      </button>

      <div class="rail-spacer" />

      <!-- 动作/面板组（面板开=图标变蓝，不用灰底） -->
      <button class="rail-btn action" title="新建页面 (Ctrl+N)" @click="quickNew">
        <Icon name="plus" :size="19" />
      </button>
      <button
        class="rail-btn action"
        :class="{ open: jobsPanelOpen }"
        title="AI 任务队列"
        @click="jobsPanelOpen = !jobsPanelOpen"
      >
        <Icon name="activity" :size="19" />
        <span v-if="app.activeJobCount > 0" class="badge">{{ app.activeJobCount > 99 ? '99+' : app.activeJobCount }}</span>
      </button>
      <button
        class="rail-btn action"
        :class="{ open: app.aiDrawerOpen }"
        title="AI 助手 (Ctrl+J)"
        @click="app.toggleAi()"
      >
        <Icon name="ai" :size="19" />
      </button>

      <div class="rail-divider" />

      <!-- 设置（导航） -->
      <button class="rail-btn" :class="{ active: isActive('/settings') }" title="设置" @click="$router.push('/settings')">
        <Icon name="settings" :size="19" />
      </button>
    </nav>

    <!-- 文件树侧栏 -->
    <aside v-show="app.sidebarOpen" class="sidebar" :style="{ width: sidebarWidth + 'px' }">
      <Sidebar ref="sidebarRef" />
    </aside>
    <!-- 拖动分隔条：调整侧栏与文档区占比（死区：最小 180px，最大窗口一半） -->
    <div
      v-if="app.sidebarOpen && !isMobile"
      class="resizer"
      title="拖动调整宽度，双击还原"
      @mousedown="startResize"
      @dblclick="resetSidebarWidth"
    />
    <div v-if="app.sidebarOpen && isMobile" class="mask" @click="app.sidebarOpen = false" />

    <!-- 主内容区 -->
    <main class="content">
      <router-view />
    </main>

    <!-- AI 抽屉 -->
    <transition name="slide">
      <aside v-if="app.aiDrawerOpen" class="ai-drawer">
        <AiDrawer />
      </aside>
    </transition>

    <!-- AI 任务队列面板 -->
    <transition name="slide">
      <JobsPanel v-if="jobsPanelOpen" @close="jobsPanelOpen = false" />
    </transition>

    <!-- 移动端底部导航 -->
    <nav class="bottom-nav">
      <button v-for="item in bottomItems" :key="item.label" @click="item.action">
        <Icon :name="item.icon" :size="20" /><span>{{ item.label }}</span>
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { api } from '../api';
import Sidebar from '../components/Sidebar.vue';
import AiDrawer from '../components/AiDrawer.vue';
import JobsPanel from '../components/JobsPanel.vue';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const sidebarRef = ref<InstanceType<typeof Sidebar>>();
const isMobile = computed(() => window.innerWidth <= 768);
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
const MIN_SIDEBAR = 180; // 死区下限：不能调没
const MAX_SIDEBAR = Math.max(320, Math.floor(window.innerWidth * 0.5)); // 死区上限：最多占一半
const DEFAULT_SIDEBAR = 260;
const sidebarWidth = ref(Number(localStorage.getItem('sidebarWidth')) || DEFAULT_SIDEBAR);

function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarWidth.value;
  const move = (ev: MouseEvent) => {
    sidebarWidth.value = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startW + (ev.clientX - startX)));
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
  sidebarWidth.value = DEFAULT_SIDEBAR;
  localStorage.setItem('sidebarWidth', String(DEFAULT_SIDEBAR));
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

let reportTimer: ReturnType<typeof setInterval>;
onMounted(() => {
  window.addEventListener('keydown', onKey);
  loadReportCount();
  reportTimer = setInterval(loadReportCount, 60_000);
  jobPollStopped = false;
  pollJobs();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  clearInterval(reportTimer);
  jobPollStopped = true;
  if (jobTimer) clearTimeout(jobTimer);
});
</script>

<style scoped>
.layout { display: flex; height: 100%; overflow: hidden; }

.rail {
  width: 48px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 2px;
  z-index: 30;
}
.rail-logo {
  width: 28px;
  height: 28px;
  margin-bottom: 10px;
  border-radius: 6px;
  background: var(--text);
  color: var(--bg);
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.rail-btn {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: background 0.12s, color 0.12s;
}
.rail-btn:hover { background: var(--bg-hover); color: var(--text); }
/* 导航命中：灰底（我在这里） */
.rail-btn.active { background: var(--bg-active); color: var(--text); }
/* 面板开启：图标变蓝（我开了个面板），不用灰底 */
.rail-btn.open { color: var(--accent); background: transparent; }
.rail-btn.open:hover { background: var(--accent-soft); }
.rail-btn .badge { position: absolute; top: -2px; right: -4px; }
.rail-spacer { flex: 1; }
.rail-divider {
  width: 22px;
  height: 1px;
  background: var(--border-strong);
  margin: 6px 0;
}

.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  overflow-y: auto;
  z-index: 20;
}

.resizer {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  border-right: 1px solid var(--border);
  z-index: 25;
}

.content { flex: 1; overflow-y: auto; min-width: 0; position: relative; background: var(--bg); }

.ai-drawer {
  width: 380px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg);
  z-index: 25;
}
.slide-enter-active, .slide-leave-active { transition: transform 0.2s, opacity 0.2s; }
.slide-enter-from, .slide-leave-to { transform: translateX(30px); opacity: 0; }

.bottom-nav { display: none; }
.mask { display: none; }

@media (max-width: 768px) {
  .rail { display: none; }
  .sidebar {
    position: fixed;
    left: 0; top: 0; bottom: 52px;
    width: 78vw !important; /* 覆盖内联宽度，移动端固定占比 */
    max-width: 300px;
    box-shadow: var(--shadow);
  }
  .mask { display: block; position: fixed; inset: 0 0 52px 0; background: rgba(15,15,15,0.25); z-index: 15; }
  .content { padding-bottom: 52px; }
  .ai-drawer { position: fixed; inset: 0 0 52px 0; width: 100%; border-left: none; }
  .bottom-nav {
    display: flex;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: 52px;
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--bg);
    border-top: 1px solid var(--border);
    z-index: 40;
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
</style>
