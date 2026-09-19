<template>
  <aside
    class="chat-drawer"
    :class="{ overlay: overlay && !isFull, full: isFull }"
    :style="drawerStyle"
    aria-label="内置 Agent"
  >
    <!-- 左缘拖拽手柄：右侧并排形态下调整宽度（双击还原默认，聚焦后方向键微调） -->
    <div
      v-if="resizable"
      class="drawer-resizer"
      :class="{ dragging: dragWidth !== null }"
      v-tooltip="'拖动调整宽度，双击还原'"
      role="separator"
      aria-label="调整内置 Agent 宽度"
      aria-orientation="vertical"
      :aria-valuemin="MIN_DRAWER_WIDTH"
      :aria-valuemax="drawerMaxWidth"
      :aria-valuenow="drawerWidth"
      tabindex="0"
      @pointerdown="startResize"
      @pointermove="onResizeMove"
      @pointerup="endResize"
      @pointercancel="endResize"
      @dblclick="resetDrawerWidth"
      @keydown.left.prevent="nudgeDrawerWidth(16)"
      @keydown.right.prevent="nudgeDrawerWidth(-16)"
      @keydown.home.prevent="setDrawerWidth(MIN_DRAWER_WIDTH)"
      @keydown.end.prevent="setDrawerWidth(drawerMaxWidth)"
    />

    <header class="chat-head">
      <div class="chat-brand"><Icon name="ai" :size="16" /> 内置 Agent</div>
      <select
        v-if="chat.sessions.length"
        class="session-select"
        :value="chat.activeSessionId"
        v-tooltip="'切换会话'"
        aria-label="切换会话"
        @change="onSelectSession"
      >
        <option v-for="session in chat.sessions" :key="session.id" :value="session.id">
          {{ session.title }}
        </option>
      </select>
      <button
        class="btn icon"
        type="button"
        v-tooltip="isFull ? '收回右侧' : '全屏'"
        :aria-label="isFull ? '收回右侧' : '全屏'"
        :aria-pressed="isFull"
        @click="app.toggleChatDrawerMode()"
      >
        <Icon :name="isFull ? 'minimize' : 'maximize'" :size="15" />
      </button>
      <button class="btn icon" type="button" v-tooltip="'新建会话'" aria-label="新建会话" @click="chat.createSession()">
        <Icon name="plus" :size="15" />
      </button>
      <button class="btn icon" type="button" v-tooltip="'删除当前会话'" aria-label="删除当前会话" @click="deleteSession">
        <Icon name="trash" :size="15" />
      </button>
      <button class="btn icon" type="button" v-tooltip="'关闭'" aria-label="关闭" @click="app.toggleChat(false)">
        <Icon name="x" :size="15" />
      </button>
    </header>

    <div v-if="contextChips.length" class="context-strip">
      <span v-for="chip in contextChips" :key="chip" class="context-chip">{{ chip }}</span>
      <button class="context-clear" type="button" v-tooltip="'清除上下文'" aria-label="清除上下文" @click="chat.clearContext()">
        <Icon name="x" :size="12" />
      </button>
    </div>

    <div ref="scrollEl" class="chat-body">
      <div v-if="chat.loading" class="empty-hint"><AppSpinner :size="14" /> 正在加载会话…</div>

      <AppEmptyState
        v-else-if="!timeline.length"
        icon="ai"
        title="内置 Agent"
        hint="由 Engram 随包的 DeepSeek Harness 驱动：可以直接问知识库，也可以让它检索、提炼与写页（写页走证据门禁）。"
      >
        <div class="suggestions">
          <button v-for="item in suggestions" :key="item" type="button" @click="send(item)">{{ item }}</button>
        </div>
      </AppEmptyState>

      <!-- 单列转录（dsh 风格）：消息与执行记录按发生顺序排成一条流，工具卡默认收起 -->
      <div v-else class="transcript">
        <template v-for="(item, index) in timeline" :key="item.key">
          <div v-if="index > 0 && startsNewRun(timeline, index)" class="run-sep" aria-hidden="true" />

          <div v-if="item.kind === 'message'" class="entry" :class="item.role">
            <div class="entry-head" :class="{ 'no-name': !showName(index) }">
              <span v-if="showName(index)" class="entry-name">{{ item.role === 'user' ? '你' : '内置 Agent' }}</span>
              <button
                v-if="item.role === 'assistant' && item.message.content"
                class="text-action"
                type="button"
                @click="copy(item.message.content)"
              >复制</button>
            </div>
            <div v-if="item.role === 'user'" class="entry-plain">{{ item.message.content }}</div>
            <div
              v-else-if="item.message.content"
              class="entry-markdown"
              v-html="renderAssistantMarkdown(item.message.content)"
            />
            <span v-if="item.message.id === streamingId" class="cursor">▍</span>
          </div>

          <div v-else class="tool" :class="item.call.status">
            <button
              class="tool-head"
              type="button"
              :aria-expanded="isToolOpen(item.call)"
              @click="toggleTool(item.call)"
            >
              <Icon :name="toolIcon(item.call.name)" :size="13" />
              <b>{{ toolLabel(item.call.name) }}</b>
              <span class="tool-summary">{{ toolCallSummary(item.call.args) }}</span>
              <span class="tool-state">{{ toolState(item.call.status) }}</span>
              <Icon :name="isToolOpen(item.call) ? 'chevron-up' : 'chevron-down'" :size="13" />
            </button>
            <div v-if="isToolOpen(item.call)" class="tool-body">
              <pre v-if="item.call.args && item.call.args !== '{}'" class="tool-args">{{ item.call.args }}</pre>
              <pre v-if="item.call.text" class="tool-result">{{ item.call.text }}</pre>
              <p v-else-if="item.call.status === 'running'" class="tool-pending">执行中…</p>
              <!-- 兜底：展开后不能是空白（无参数又无输出时给出明确说明，用户才知道是「没输出」而非「没展开」） -->
              <p v-else-if="!item.call.args || item.call.args === '{}'" class="tool-pending">这次调用没有输出内容</p>
            </div>
          </div>
        </template>
      </div>

      <div v-if="chat.statusText" class="run-status">
        <AppSpinner :size="13" /> {{ chat.statusText }}
      </div>
      <div v-if="chat.error" class="run-error">{{ chat.error }}</div>

      <div v-if="terminalRun" class="completion">
        <button
          v-if="['failed', 'cancelled', 'interrupted'].includes(terminalRun.status)"
          class="btn small"
          type="button"
          @click="chat.retry(terminalRun.id)"
        >重试</button>
        <button v-if="terminalRun.status === 'completed'" class="btn small" type="button" @click="ingest">
          沉淀对话到原始资料
        </button>
        <span v-if="terminalRun.ingestedPath" class="faint small">已沉淀：{{ terminalRun.ingestedPath }}</span>
      </div>
    </div>

    <footer class="chat-composer">
      <!-- 选中片段：紧贴输入框上方单独成块，逐条展开看全文、逐条移除或全部清除 -->
      <section v-if="chat.selections.length" class="selection-panel" aria-label="选中的原文片段">
        <header class="selection-head">
          <span class="selection-title">
            <Icon name="report" :size="12" />
            选中片段 {{ chat.selections.length }} 条
          </span>
          <button class="text-action" type="button" @click="chat.clearSelections()">全部清除</button>
        </header>
        <div
          v-for="(item, index) in chat.selections"
          :key="item.id"
          class="selection-item"
          :class="{ open: isSelectionOpen(item) }"
        >
          <div class="selection-item-head">
            <button
              class="selection-toggle"
              type="button"
              :aria-expanded="isSelectionOpen(item)"
              @click="toggleSelection(item)"
            >
              <Icon :name="isSelectionOpen(item) ? 'chevron-up' : 'chevron-down'" :size="12" />
              <b>片段 {{ index + 1 }}</b>
              <span v-if="item.source" class="selection-source" v-tooltip="item.source">{{ item.source }}</span>
              <span class="selection-count">{{ item.text.length }} 字</span>
            </button>
            <button
              class="selection-remove"
              type="button"
              v-tooltip="'移除这段'"
              aria-label="移除这段"
              @click="chat.removeSelection(item.id)"
            >
              <Icon name="x" :size="12" />
            </button>
          </div>
          <pre v-if="isSelectionOpen(item)" class="selection-text">{{ item.text }}</pre>
          <p v-else class="selection-preview">{{ selectionPreview(item.text) }}</p>
        </div>
      </section>

      <textarea
        ref="inputEl"
        v-model="draft"
        rows="3"
        :placeholder="chat.currentRun ? '正在回复…' : '问点什么，或让我整理知识库（Enter 发送，Shift+Enter 换行）'"
        :disabled="Boolean(chat.currentRun)"
        @keydown.enter.exact.prevent="send()"
      />
      <div class="composer-actions">
        <button
          v-if="chat.currentRun"
          class="btn small"
          type="button"
          @click="chat.cancel()"
        >
          <Icon name="square" :size="13" /> 停止
        </button>
        <button
          v-else
          class="btn primary small"
          type="button"
          :disabled="!draft.trim()"
          @click="send()"
        >
          <Icon name="send" :size="13" /> 发送
        </button>
      </div>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import AppSpinner from './ui/AppSpinner.vue';
import { useAppStore } from '../stores/app';
import { useChatStore, type ChatContext, type ChatRun, type ChatToolCall } from '../stores/chat';
import type { SelectionExcerpt } from '../lib/askAgent';
import { buildChatTimeline, showStreamName, startsNewRun, toolCallSummary } from '../lib/chatTimeline';
import { renderAssistantMarkdown } from '../lib/markdown';
import { notify } from '../lib/notify';

const props = defineProps<{ overlay?: boolean }>();

const app = useAppStore();
const chat = useChatStore();
const draft = ref('');
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

/** 满窗形态：铺满内容区（形态本身不重建组件，会话/草稿/滚动都保留） */
const isFull = computed(() => app.chatDrawerMode === 'full');

/* ===== 左缘拖拽调宽：只在「右侧并排」形态下有意义（浮层/满窗/手机端都铺满可用宽度） ===== */
const MIN_DRAWER_WIDTH = 320;
const MAX_DRAWER_WIDTH = 720;
/** 正文阅读列至少留出的宽度：抽屉拖得再宽也不能把文章挤成竖排 */
const MIN_ARTICLE_WIDTH = 420;
const viewportWidth = ref(window.innerWidth);
/** 左侧图标栏（含间距）占掉的宽度；文件树展开时再加上文件树 */
const leftChromeWidth = ref(64);

/**
 * 量左侧占位：图标栏固定 64px，文件树展开时与 .content 的 padding-left 同源（--sidebar-width + 72）。
 * 读 CSS 变量而不是量 .content 的 padding：后者带 180ms 过渡，切换侧栏瞬间会量到中间值。
 */
function measureLeftChrome(): number {
  const layout = document.querySelector('.layout');
  if (!layout || !app.sidebarOpen) return 64;
  const sidebar = parseFloat(getComputedStyle(layout).getPropertyValue('--sidebar-width'));
  return Number.isFinite(sidebar) && sidebar > 0 ? sidebar + 72 : 64;
}

const resizable = computed(() => !props.overlay && !isFull.value);
const drawerMaxWidth = computed(() =>
  Math.max(
    MIN_DRAWER_WIDTH,
    Math.min(MAX_DRAWER_WIDTH, viewportWidth.value - leftChromeWidth.value - MIN_ARTICLE_WIDTH)
  )
);

/** 用户没拖过时沿用响应式默认宽度（与拖拽上线前的观感一致），同样受上限约束 */
function defaultDrawerWidth() {
  return clampDrawerWidth(Math.min(520, Math.max(360, viewportWidth.value * 0.32)));
}

function clampDrawerWidth(width: number) {
  return Math.min(drawerMaxWidth.value, Math.max(MIN_DRAWER_WIDTH, Math.round(width)));
}

/** 本地是否已有用户调过的宽度偏好；没有就跟随窗口宽度 */
const hasWidthPreference = ref(localStorage.getItem('chatDrawerWidth') !== null);
/** 拖拽过程中用本地值跟手，松手才写回偏好（避免每帧都写 localStorage） */
const dragWidth = ref<number | null>(null);
const drawerWidth = computed(() =>
  dragWidth.value ?? (hasWidthPreference.value ? clampDrawerWidth(app.chatDrawerWidth) : defaultDrawerWidth())
);
const drawerStyle = computed(() => (resizable.value ? { width: `${drawerWidth.value}px` } : {}));

function setDrawerWidth(width: number) {
  dragWidth.value = null;
  app.setChatDrawerWidth(clampDrawerWidth(width));
  hasWidthPreference.value = true;
}

/** 双击还原：清掉偏好，回到跟随窗口的响应式默认宽度 */
function resetDrawerWidth() {
  dragWidth.value = null;
  localStorage.removeItem('chatDrawerWidth');
  hasWidthPreference.value = false;
}

function nudgeDrawerWidth(delta: number) {
  setDrawerWidth(drawerWidth.value + delta);
}

let resizeStartX = 0;
let resizeStartWidth = 0;

function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  // 文件树可能刚被拖宽：每次起拖都重新量一次左侧占位，上限跟着变
  leftChromeWidth.value = measureLeftChrome();
  resizeStartX = event.clientX;
  resizeStartWidth = drawerWidth.value;
  dragWidth.value = resizeStartWidth;
  const handle = event.currentTarget as HTMLElement;
  try {
    handle.setPointerCapture(event.pointerId);
  } catch { /* 拿不到指针捕获也能靠元素自身的 pointermove 跟手 */ }
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

/** 手柄贴在抽屉左缘：向左拖是加宽，位移取反 */
function onResizeMove(event: PointerEvent) {
  if (dragWidth.value === null) return;
  dragWidth.value = clampDrawerWidth(resizeStartWidth - (event.clientX - resizeStartX));
}

function endResize(event: PointerEvent) {
  if (dragWidth.value === null) return;
  const width = dragWidth.value;
  dragWidth.value = null;
  const handle = event.currentTarget as HTMLElement;
  try {
    handle.releasePointerCapture(event.pointerId);
  } catch { /* 已经释放过 */ }
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  // 只是点了一下手柄、宽度没变：不动偏好（免得把「跟随窗口」意外钉成固定值）
  if (width !== resizeStartWidth) setDrawerWidth(width);
}

function onDrawerViewportResize() {
  viewportWidth.value = window.innerWidth;
  leftChromeWidth.value = measureLeftChrome();
}

const suggestions = [
  '列出还没有提炼的原始资料',
  '这个知识库现在有哪些实体页？',
  '搜索「同步」相关的页面并总结要点',
];

const contextChips = computed(() => {
  const ctx = chat.currentContext as ChatContext;
  const chips: string[] = [];
  if (ctx.currentPage?.title) chips.push(`页面：${ctx.currentPage.title}`);
  if (ctx.currentFile?.path) chips.push(`文件：${ctx.currentFile.path}`);
  // 选中原文不再只报字数：输入框上方有独立的片段面板，可逐条展开看全文
  return chips;
});

/* ===== 选中片段：默认展开看全文，点标题收起为一行摘要；新加入的片段自动展开 ===== */
const selectionOpen = ref<Record<string, boolean>>({});
const knownSelections = new Set<string>();

watch(
  () => chat.selections.map((item) => item.id).join(','),
  () => {
    for (const item of chat.selections) {
      if (knownSelections.has(item.id)) continue;
      knownSelections.add(item.id);
      selectionOpen.value = { ...selectionOpen.value, [item.id]: true };
    }
  },
  { immediate: true }
);

function isSelectionOpen(item: SelectionExcerpt): boolean {
  return selectionOpen.value[item.id] ?? true;
}

function toggleSelection(item: SelectionExcerpt) {
  selectionOpen.value = { ...selectionOpen.value, [item.id]: !isSelectionOpen(item) };
}

/** 收起态的一行摘要：压掉换行、只留开头，方便多条并排扫一眼 */
function selectionPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

const terminalRun = computed<ChatRun | null>(() => {
  const run = chat.latestRun;
  if (!run) return null;
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run : null;
});

/** 对话流：按轮分组，轮内消息与工具卡按落库时间排（见 lib/chatTimeline） */
const timeline = computed(() =>
  buildChatTimeline(chat.messages, chat.sessionToolCalls, chat.runs)
);

/** 正在流式到达的那一段正文（光标只画在它后面） */
const streamingId = computed(() => {
  const run = chat.currentRun;
  if (!run) return '';
  const segments = chat.messages.filter((m) => m.runId === run.id && m.role === 'assistant');
  return segments.length ? segments[segments.length - 1].id : '';
});

const showName = (index: number) => showStreamName(timeline.value, index);

/* ===== 工具卡折叠：默认收起，失败默认展开，用户点过就以用户为准 ===== */
const toolOpenOverride = ref<Record<string, boolean>>({});

function isToolOpen(call: ChatToolCall): boolean {
  return toolOpenOverride.value[call.id] ?? call.status === 'failed';
}

function toggleTool(call: ChatToolCall) {
  toolOpenOverride.value = { ...toolOpenOverride.value, [call.id]: !isToolOpen(call) };
}

function onSelectSession(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  void chat.selectSession(id);
}

async function deleteSession() {
  await chat.deleteActiveSession();
}

async function send(text?: string) {
  const message = (text ?? draft.value).trim();
  if (!message || chat.currentRun) return;
  draft.value = '';
  await chat.send(message);
  await scrollToBottom();
}

async function ingest() {
  const meta = await chat.ingest();
  if (meta) notify.success(`已沉淀到 ${meta.path}`);
}

function copy(text: string) {
  void navigator.clipboard.writeText(text);
  notify.success('已复制');
}

const TOOL_LABELS: Record<string, string> = {
  search: '检索知识库',
  read_page: '读取页面',
  list_pages: '列出页面',
  list_raw_files: '列出原始资料',
  read_raw_file: '读取原始资料',
  write_page: '写入页面',
  page_evidence: '查看来源证据',
  related_pages: '查看关联页面',
  save_chat: '沉淀对话',
  kb_guide: '获取作业指南',
  skill_list: '列出作业技能',
  skill_guide: '获取作业技能',
  rename_page: '重命名页面',
  move_page: '移动页面',
  delete_page: '删除页面（回收站）',
};

/** 执行记录一行的工具图标（与 TOOL_LABELS 同一套键） */
const TOOL_ICONS: Record<string, string> = {
  search: 'search',
  read_page: 'markdown',
  list_pages: 'pages',
  list_raw_files: 'folder',
  read_raw_file: 'file',
  write_page: 'file-plus',
  page_evidence: 'report',
  related_pages: 'graph',
  save_chat: 'archive',
  kb_guide: 'book-open',
  skill_list: 'list-tree',
  skill_guide: 'list-tree',
  rename_page: 'move',
  move_page: 'move',
  delete_page: 'trash',
};

function bareToolName(name: string): string {
  return name.replace(/^mcp__engram__/, '');
}

function toolLabel(name: string): string {
  const bare = bareToolName(name);
  return TOOL_LABELS[bare] || bare;
}

function toolIcon(name: string): string {
  return TOOL_ICONS[bareToolName(name)] || 'activity';
}

function toolState(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return status;
}

async function scrollToBottom() {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
}

/** Esc 只把满窗收回右侧：不关抽屉、不取消正在跑的一轮（弹窗的 Esc 会 stopPropagation，不会误触发） */
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  if (app.chatDrawerMode === 'full') app.setChatDrawerMode('dock');
}

watch(
  () => `${chat.messages.map((m) => m.content.length).join(',')}|${chat.sessionToolCalls.length}|${chat.statusText}`,
  () => void scrollToBottom()
);
watch(() => app.chatDrawerOpen, (open) => {
  if (open) {
    void chat.init().then(() => {
      void scrollToBottom();
      inputEl.value?.focus();
    });
  }
});
/* 选中文字提问：抽屉已经开着时 open 不变，靠计数自增把光标送进输入框 */
watch(() => app.chatComposerFocus, () => {
  if (!app.chatDrawerOpen) return;
  void chat.init().then(() => inputEl.value?.focus());
});
/* 文件树开合会改变正文可用宽度：重新量一次左侧占位，抽屉上限跟着收敛/放宽 */
watch(() => app.sidebarOpen, () => {
  leftChromeWidth.value = measureLeftChrome();
}, { flush: 'post' });

onMounted(() => {
  window.addEventListener('keydown', onKey);
  // 窗口变窄时收窄到上限内（只收敛显示，用户偏好留着，回到大窗口即恢复）
  window.addEventListener('resize', onDrawerViewportResize);
  leftChromeWidth.value = measureLeftChrome();
  // 首次打开时抽屉是随开关一起挂载的，上面那个 watch 不会触发，这里补一次初始化 + 聚焦
  if (app.chatDrawerOpen) {
    void chat.init().then(async () => {
      await scrollToBottom();
      inputEl.value?.focus();
    });
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onDrawerViewportResize);
  chat.closeEvents();
});
</script>

<style scoped>
.chat-drawer {
  position: relative;
  display: flex;
  flex-direction: column;
  width: clamp(360px, 32vw, 520px);
  height: 100%;
  min-height: 0;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg);
  z-index: var(--z-drawer);
}

/* 左缘拖拽手柄：8px 命中区跨在边框上，平时不显形，悬停/拖动/聚焦时给一条强调色细线 */
.drawer-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
  z-index: 2;
}

.drawer-resizer::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: transparent;
  transition: width 150ms ease, background 150ms ease;
}

.drawer-resizer:hover::before,
.drawer-resizer:focus-visible::before,
.drawer-resizer.dragging::before {
  width: 2px;
  background: var(--accent, #4d8aff);
}

.drawer-resizer:focus-visible {
  box-shadow: 0 0 0 2px var(--sidebar-focus-ring);
}

.chat-drawer.overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 60px;
  right: 0;
  width: auto;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
  z-index: var(--z-sidebar);
}

/*
 * 满窗：铺满正文区（.content 的可视范围），不占用左侧图标栏与文件树——侧栏保持可见可用。
 * 用 absolute 而不是 fixed：fixed 会盖住顶部 36px 拖拽条，窗口就拖不动了。
 * z-index 取 --z-subpanel：低于遮罩(32)与侧栏(35)，紧凑档/手机端文件树浮层打开时能压在满窗之上。
 */
.chat-drawer.full {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 64px;
  right: 0;
  width: auto;
  border-left: none;
  box-shadow: none;
  z-index: var(--z-subpanel);
}

/* 文件树展开时让出侧栏宽度（与 .layout.sidebar-open .content 的 padding-left 同步） */
.layout.sidebar-open .chat-drawer.full {
  left: calc(var(--sidebar-width) + 72px);
}

/* 满窗下头部/正文/输入区同列居中限宽，长文与工具结果不被拉成一整屏 */
.chat-drawer.full .chat-head,
.chat-drawer.full .context-strip,
.chat-drawer.full .chat-body,
.chat-drawer.full .chat-composer {
  padding-left: max(12px, calc((100% - 1080px) / 2));
  padding-right: max(12px, calc((100% - 1080px) / 2));
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.chat-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.session-select {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.context-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.context-chip {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
}

.context-clear {
  display: inline-flex;
  align-items: center;
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}

.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.empty-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12px;
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.suggestions button {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.suggestions button:hover {
  border-color: var(--accent, #4d8aff);
  color: var(--text);
}

/* ===== 单列转录：一条流按发生顺序排，轮间一条细分隔 ===== */
.transcript {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.run-sep {
  height: 1px;
  margin: 2px 0;
  background: var(--border);
}

.entry {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 16px;
  margin-bottom: 2px;
  color: var(--text-faint);
  font-size: 11px;
}

.entry-name {
  font-weight: 600;
}

/* 同一轮的后续正文不再署名，操作按钮仍靠右对齐，避免位置跳动 */
.entry-head.no-name {
  justify-content: flex-end;
}

/* 用户消息：纯文本块 + 左缘强调色竖条（不渲染 Markdown，保持原样） */
.entry-plain {
  padding: 7px 10px;
  border-left: 2px solid var(--accent, #4d8aff);
  border-radius: 0 8px 8px 0;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.entry-markdown {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  overflow-wrap: anywhere;
}

/* 助手正文里的 Markdown 子元素全局没有样式，这里按转录排版补齐 */
.entry-markdown :deep(h2),
.entry-markdown :deep(h3),
.entry-markdown :deep(h4) {
  margin: 12px 0 6px;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.4;
}

.entry-markdown :deep(p) {
  margin: 0 0 8px;
}

.entry-markdown :deep(pre) {
  margin: 8px 0;
  padding: 8px 10px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.entry-markdown :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.entry-markdown :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 11.5px;
  line-height: 1.55;
}

.entry-markdown :deep(sup.cite) {
  color: var(--accent, #4d8aff);
  font-size: 10px;
}

/* 列表项由 Markdown 渲染器转成 span + <br>，这里不再改成块级，避免每项之间多空一行 */
.entry-markdown :deep(.list-line) {
  padding-left: 2px;
}

.cursor {
  display: inline-block;
  animation: blink 1s steps(2, start) infinite;
  color: var(--accent, #4d8aff);
}

@keyframes blink {
  to { visibility: hidden; }
}

/* ===== 执行记录：一行摘要，点开看完整参数与完整结果（靠滚动，不截断） ===== */
.tool {
  border: 1px solid var(--border);
  border-left: 2px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.tool.running {
  border-left-color: var(--accent, #4d8aff);
}

.tool.failed {
  border-left-color: var(--danger, #d64545);
}

.tool-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
}

.tool-head b {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 600;
}

.tool-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-state {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 11px;
}

.tool.running .tool-state {
  color: var(--accent, #4d8aff);
}

.tool.failed .tool-state {
  color: var(--danger, #d64545);
}

.tool-body {
  padding: 0 10px 8px;
  border-top: 1px solid var(--border);
}

.tool-args,
.tool-result {
  margin: 8px 0 0;
  max-height: 320px;
  overflow: auto;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-pending {
  margin: 8px 0 0;
  color: var(--text-faint);
  font-size: 11px;
}

.run-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
  color: var(--text-faint);
  font-size: 12px;
}

.run-error {
  margin: 8px 0;
  color: var(--danger, #d64545);
  font-size: 12px;
}

.completion {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.chat-composer {
  border-top: 1px solid var(--border);
  padding: 10px 12px 12px;
}

/* ===== 选中片段面板：贴在输入框上方，长文靠自身滚动，不把输入框顶出视野 ===== */
.selection-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.selection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.selection-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.selection-head .text-action {
  border: none;
  background: none;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
}

.selection-head .text-action:hover {
  color: var(--accent, #4d8aff);
}

.selection-item {
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent, #4d8aff);
  border-radius: 6px;
  background: var(--bg);
  overflow: hidden;
}

.selection-item-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
}

.selection-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.selection-toggle b {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 600;
}

.selection-source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.selection-count {
  flex-shrink: 0;
  color: var(--text-faint);
}

.selection-remove {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}

.selection-remove:hover {
  background: var(--bg-secondary);
  color: var(--danger, #d64545);
}

.selection-text {
  margin: 0;
  max-height: 168px;
  overflow: auto;
  padding: 0 8px 8px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.selection-preview {
  margin: 0;
  padding: 0 8px 7px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.chat-composer textarea {
  width: 100%;
  resize: none;
  font-size: 13px;
  line-height: 1.5;
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

/* 紧凑档（769-1024px）：文件树是浮层、不占布局位，满窗只让开左侧图标栏 */
@media (min-width: 769px) and (max-width: 1024px) {
  .layout.sidebar-open .chat-drawer.full {
    left: 64px;
  }
}

@media (max-width: 768px) {
  .chat-drawer {
    width: 100%;
    border-left: none;
  }

  /* 手机端 rail 已隐藏，浮层不该再留 60px 空档 */
  .chat-drawer.overlay {
    left: 0;
  }

  /* 手机端没有常驻侧栏（文件树也是浮层），满窗仍铺满整屏 */
  .chat-drawer.full,
  .layout.sidebar-open .chat-drawer.full {
    left: 0;
  }
}
</style>
