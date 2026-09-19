<template>
  <div class="sidebar-inner">
    <header class="sidebar-header">
      <div class="sidebar-titlebar">
        <h2>知识库</h2>
        <div class="sidebar-title-actions">
          <SyncButton />
          <button
            class="sidebar-fold"
            type="button"
            v-tooltip="allCollapsed ? '全部展开' : '全部收起'"
            :aria-label="allCollapsed ? '全部展开' : '全部收起'"
            @click="toggleAll"
          >
            <Icon :name="allCollapsed ? 'unfold' : 'fold'" :size="16" />
          </button>
          <button class="sidebar-new" type="button" v-tooltip="'新建页面'" aria-label="新建页面" @click="emit('new-page')">
            <Icon name="plus" :size="16" />
          </button>
          <button class="sidebar-close" type="button" v-tooltip="'关闭侧边栏'" aria-label="关闭侧边栏" @click="emit('close')">
            <Icon name="x" :size="16" />
          </button>
        </div>
      </div>

      <div class="search-toolbar">
        <div class="search-field">
          <Icon name="search" :size="14" class="search-icon" />
          <input v-model="filter" aria-label="搜索侧边栏" placeholder="搜索页面与资料" />
          <button
            v-if="filter"
            class="search-clear"
            type="button"
            v-tooltip="'清除搜索'"
            aria-label="清除搜索"
            @click="filter = ''"
          >
            <Icon name="x" :size="12" />
          </button>
        </div>
      </div>
    </header>

    <div class="side-scroll">
      <!-- 类型分区 -->
      <div class="sidebar-category">
        <section v-for="g in typeGroups" :key="g.key" class="section">
          <div
            class="sec-row"
            :class="{ expanded: !collapsed[g.key] }"
          >
            <button
              class="sec-toggle"
              :class="{ 'drop-target': g.key === 'concept' && dragOverKey === 'concept' && canDropTo('concept') }"
              type="button"
              :aria-expanded="!collapsed[g.key]"
              v-tooltip="collapsed[g.key] ? `展开${g.label}` : `收起${g.label}`"
              @click="toggle(g.key)"
              @dragover="g.key === 'concept' && onDragOverSub($event, 'concept')"
              @dragleave="g.key === 'concept' && onDragLeave('concept')"
              @drop.prevent="g.key === 'concept' && onDropToType('concept')"
            >
              <span class="sec-name">{{ g.label }}</span>
            </button>
            <div class="sec-actions">
              <button
                class="sort-control section-sort"
                type="button"
                :class="{ 'menu-open': isSortMenuOpen(`group:${g.key}`) }"
                v-tooltip="`${g.label}排序：${sortLabel(groupSort[g.key])}`"
                :aria-label="`${g.label}排序，当前 ${sortLabel(groupSort[g.key])}`"
                aria-haspopup="menu"
                :aria-expanded="isSortMenuOpen(`group:${g.key}`)"
                @click="openSortMenu($event, `group:${g.key}`, g.label)"
              >
                <Icon name="sort" :size="12" />
              </button>
              <button
                class="add-btn"
                type="button"
                v-tooltip="`导出全部${g.label}`"
                :aria-label="`导出全部${g.label}`"
                :disabled="!groupPageCount(g) || exporting"
                @click="exportAllPages(g)"
              >
                <Icon name="download" :size="13" />
              </button>
              <span class="sec-count">{{ groupPageCount(g) }}</span>
            </div>
          </div>
          <div v-show="!collapsed[g.key]" class="sec-body">
            <!-- 实体：按子类（人物/客户/项目）分组，子类可折叠 -->
            <template v-if="g.subGroups">
              <div
                v-for="sub in visibleSubGroups(g)"
                :key="sub.key"
                class="sub-group"
                :class="{ expanded: !collapsed[`${g.key}:${sub.key}`] }"
              >
                <button
                  class="sub-head"
                  :class="{ 'drop-target': dragOverKey === sub.key && canDropTo(sub.key) }"
                  type="button"
                  :aria-expanded="!collapsed[`${g.key}:${sub.key}`]"
                  v-tooltip="collapsed[`${g.key}:${sub.key}`] ? `展开${sub.label}` : `收起${sub.label}`"
                  @click="toggle(`${g.key}:${sub.key}`)"
                  @dragover="onDragOverSub($event, sub.key)"
                  @dragleave="onDragLeave(sub.key)"
                  @drop.prevent="onDropToType(sub.key)"
                >
                  <span class="sub-name">{{ sub.label }}</span>
                  <span class="sub-count">{{ filteredPages(sub.pages).length }}</span>
                </button>
                <div v-show="!collapsed[`${g.key}:${sub.key}`]" class="sub-body">
                  <PageRow
                    v-for="p in sortList(filteredPages(sub.pages), groupSort[g.key])"
                    :key="p.id"
                    :page="p"
                    :active="p.id === activeId"
                    :selected="selected.has('p:' + p.id)"
                    :selection-mode="selectionMode"
                    @open="openPage"
                    @archive="archivePage"
                    @unarchive="unarchivePage"
                    @remove="removePage"
                    @toggle-select="toggleSelect"
                    @context-menu="onPageContextMenu"
                    @drag-start="onDragStart"
                    @drag-end="onDragEnd"
                  />
                </div>
              </div>
              <p v-if="!groupPageCount(g)" class="none">
                {{ filter ? '没有匹配页面' : '暂无页面' }}
              </p>
            </template>
            <!-- 概念 / 归档：直接平铺 -->
            <template v-else>
              <PageRow
                v-for="p in sortList(filteredPages(g.pages), groupSort[g.key])"
                :key="p.id"
                :page="p"
                :active="p.id === activeId"
                :selected="selected.has('p:' + p.id)"
                :selection-mode="selectionMode"
                @open="openPage"
                @archive="archivePage"
                @unarchive="unarchivePage"
                @remove="removePage"
                @toggle-select="toggleSelect"
                @context-menu="onPageContextMenu"
                @drag-start="onDragStart"
                @drag-end="onDragEnd"
              />
              <p v-if="!filteredPages(g.pages).length" class="none">
                {{ filter ? '没有匹配页面' : '暂无页面' }}
              </p>
            </template>
          </div>
        </section>
      </div>

      <div class="section-separator" />

      <!-- 原始资料：进料口。上传/新建/拖入；提炼由外部 Agent 处理 -->
      <section
        class="section"
        :class="{ 'files-drop': filesDropHot }"
        @dragover="onFilesDragOver"
        @dragleave="onFilesDragLeave"
        @drop.prevent="onFilesDrop"
      >
        <div
          class="sec-row"
          :class="{ expanded: !collapsed.files }"
        >
          <button
            class="sec-toggle"
            type="button"
            :aria-expanded="!collapsed.files"
            v-tooltip="collapsed.files ? '展开原始资料' : '收起原始资料'"
            @click="toggle('files')"
          >
            <span class="sec-name">原始资料</span>
          </button>
          <div class="sec-actions">
            <button
              class="sort-control section-sort"
              type="button"
              :class="{ 'menu-open': isSortMenuOpen('files') }"
              v-tooltip="`原始资料排序：${sortFilesLabel}`"
              :aria-label="`原始资料排序，当前 ${sortFilesLabel}`"
              aria-haspopup="menu"
              :aria-expanded="isSortMenuOpen('files')"
              @click="openSortMenu($event, 'files', '原始资料')"
            >
              <Icon name="sort" :size="12" />
            </button>
            <button
              class="add-btn"
              type="button"
              v-tooltip="'导出全部资料'"
              aria-label="导出全部资料"
              :disabled="!visibleFiles.length || exporting"
              @click="exportAllFiles"
            >
              <Icon name="download" :size="13" />
            </button>
            <button
              class="add-btn"
              type="button"
              v-tooltip="'新建 Markdown 文件'"
              aria-label="新建 Markdown 文件"
              @click="createFile"
            >
              <Icon name="file-plus" :size="13" />
            </button>
            <button
              class="add-btn"
              type="button"
              v-tooltip="desktopMdOnly ? '导入 Markdown 文档' : '上传文件'"
              :aria-label="desktopMdOnly ? '导入 Markdown 文档' : '上传文件'"
              @click="uploadInput?.click()"
            >
              <Icon name="upload" :size="13" />
            </button>
            <span class="sec-count">{{ visibleFiles.length }}</span>
          </div>
        </div>
        <div v-show="!collapsed.files" class="sec-body">
          <FileRow
            v-for="f in sortList(visibleFiles, sortFiles)"
            :key="f.path"
            :file="f"
            :active="isActiveFile(f)"
            :selected="selected.has('f:' + f.path)"
            :selection-mode="selectionMode"
            :job="fileJob(f.path)"
            @open="openFile"
            @toggle-select="toggleSelect({ id: 'f:' + $event.path })"
            @remove="removeFile"
            @context-menu="onFileContextMenu"
          />
          <p v-if="!visibleFiles.length" class="none">
            {{ filter ? '没有匹配资料' : '暂无资料' }}
          </p>
        </div>
        <input
          ref="uploadInput"
          type="file"
          :accept="desktopMdOnly ? '.md,.markdown' : undefined"
          multiple
          hidden
          @change="onUpload"
        />
      </section>

      <!-- 对话：外置 Agent 沉积的对话文件 -->
      <section class="section">
        <div
          class="sec-row"
          :class="{ expanded: !collapsed.chat }"
        >
          <button
            class="sec-toggle"
            type="button"
            :aria-expanded="!collapsed.chat"
            v-tooltip="collapsed.chat ? '展开对话' : '收起对话'"
            @click="toggle('chat')"
          >
            <span class="sec-name">对话</span>
          </button>
          <div class="sec-actions">
            <button
              class="sort-control section-sort"
              type="button"
              :class="{ 'menu-open': isSortMenuOpen('chat') }"
              v-tooltip="`对话排序：${sortChatLabel}`"
              :aria-label="`对话排序，当前 ${sortChatLabel}`"
              aria-haspopup="menu"
              :aria-expanded="isSortMenuOpen('chat')"
              @click="openSortMenu($event, 'chat', '对话')"
            >
              <Icon name="sort" :size="12" />
            </button>
            <span class="sec-count">{{ visibleChatFiles.length }}</span>
          </div>
        </div>
        <div v-show="!collapsed.chat" class="sec-body">
          <FileRow
            v-for="f in sortList(visibleChatFiles, sortChat)"
            :key="f.path"
            :file="f"
            :active="isActiveFile(f)"
            :selected="selected.has('f:' + f.path)"
            :selection-mode="selectionMode"
            :job="fileJob(f.path)"
            @open="openFile"
            @toggle-select="toggleSelect({ id: 'f:' + $event.path })"
            @remove="removeFile"
            @context-menu="onFileContextMenu"
          />
          <p v-if="!visibleChatFiles.length" class="none">
            {{ filter ? '没有匹配对话' : '暂无对话' }}
          </p>
        </div>
      </section>

      <!-- AI 工作区：服务端自动生成的系统区（操作日志/索引/关系库），只读 -->
      <section class="section">
        <div
          class="sec-row"
          :class="{ expanded: !collapsed.ailog }"
        >
          <button
            class="sec-toggle"
            type="button"
            :aria-expanded="!collapsed.ailog"
            v-tooltip="collapsed.ailog ? '展开 AI 工作区' : '收起 AI 工作区'"
            @click="toggle('ailog')"
          >
            <span class="sec-name">AI 工作区</span>
          </button>
          <span class="sec-count">{{ visibleAiLogs.length }}</span>
        </div>
        <div v-show="!collapsed.ailog" class="sec-body">
          <div
            v-for="p in sortList(visibleAiLogs, 'updated-desc')"
            :key="p.id"
            class="page-row log-row"
            :class="{ active: p.id === activeId }"
            role="button"
            tabindex="0"
            @click="openPage(p)"
            @keydown.enter.self="openPage(p)"
            @keydown.space.self.prevent="openPage(p)"
          >
            <Icon name="report" :size="13" class="log-file-icon" />
            <span class="page-title" v-tooltip="p.title">{{ p.title }}</span>
          </div>
          <p v-if="!visibleAiLogs.length" class="none">
            {{ filter ? '没有匹配页面' : '服务端自动生成' }}
          </p>
        </div>
      </section>

      <!-- 标签已按产品要求从侧栏移除，仅在搜索结果中展示 -->
    </div>

    <!-- 多选操作栏 -->
    <transition name="rise">
      <div v-if="selected.size" class="batch-bar">
        <span class="batch-count">已选 {{ selected.size }} 项</span>
        <button class="batch-btn" type="button" :disabled="!selectedPageCount" @click="batchArchive">归档</button>
        <button class="batch-btn" type="button" :disabled="(!selectedPageCount && !selectedFileCount) || exporting" @click="exportSelected">
          {{ exporting ? '导出中…' : '导出' }}
        </button>
        <button class="batch-btn danger" type="button" @click="batchDelete">删除</button>
        <button class="batch-btn faint-btn" type="button" @click="clearSelection">取消</button>
      </div>
    </transition>

    <!-- 排序下拉：自绘弹层，原生 select 弹层宽度不可控且文字紧贴边缘 -->
    <Teleport to="body">
      <div
        v-if="sortMenu.open"
        ref="sortMenuEl"
        class="sort-menu"
        :class="{ ready: sortMenu.ready }"
        :style="{ left: `${sortMenu.left}px`, top: `${sortMenu.top}px` }"
        role="menu"
        :aria-label="sortMenuLabel"
        @keydown="onSortMenuKeydown"
      >
        <button
          v-for="option in SORT_OPTIONS"
          :key="option.value"
          class="sort-menu-item"
          type="button"
          role="menuitemradio"
          :data-value="option.value"
          :aria-checked="option.value === sortMenuValue"
          @click="chooseSort(option.value)"
        >
          <Icon
            v-if="option.value === sortMenuValue"
            name="check"
            :size="13"
            class="sort-menu-check"
          />
          <span v-else class="sort-menu-check" />
          <span class="sort-menu-text">{{ option.label }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { confirmDialog, promptDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import { hideTooltip } from '../lib/tooltip';
import { openContextMenu, type ContextMenuItem } from '../lib/contextMenu';
import Icon from './Icon.vue';
import PageRow from './PageRow.vue';
import FileRow from './FileRow.vue';
import SyncButton from './SyncButton.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const emit = defineEmits(['close', 'new-page']);

const allPages = ref<any[]>([]);
const files = ref<any[]>([]);
const filter = ref('');
/** 每个分列独立排序并持久化；AI 整理日志固定按时间倒序。 */
const legacySortWiki = localStorage.getItem('sortWiki') || 'name-asc';
const groupSort = ref<Record<string, string>>({
  concept: localStorage.getItem('sortConcept') || legacySortWiki,
  entity: localStorage.getItem('sortEntity') || legacySortWiki,
  archived: localStorage.getItem('sortArchived') || legacySortWiki,
});
const sortFiles = ref(localStorage.getItem('sortFiles') || 'name-asc');
const sortChat = ref(localStorage.getItem('sortChat') || sortFiles.value);
const SORT_LABELS: Record<string, string> = {
  'name-asc': '名称 A→Z',
  'name-desc': '名称 Z→A',
  'updated-desc': '更新时间',
  'created-desc': '创建时间',
};
localStorage.removeItem('sortWiki');

function sortLabel(mode: string) {
  return SORT_LABELS[mode] || '名称 A→Z';
}

const sortFilesLabel = computed(() => SORT_LABELS[sortFiles.value] || '名称 A→Z');
const sortChatLabel = computed(() => SORT_LABELS[sortChat.value] || '名称 A→Z');

/** 排序下拉：自绘弹层。原生 select 的弹层宽度由控件决定，23px 图标触发器下文字紧贴边缘。 */
const SORT_OPTIONS = Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }));
const SORT_MENU_MIN_WIDTH = 152;
const SORT_MENU_MARGIN = 8;
const sortMenuEl = ref<HTMLElement>();
let sortMenuTrigger: HTMLElement | null = null;
const sortMenu = ref({ open: false, ready: false, left: 0, top: 0, target: '', label: '列表' });

const sortMenuValue = computed(() => {
  if (sortMenu.value.target === 'files') return sortFiles.value;
  if (sortMenu.value.target === 'chat') return sortChat.value;
  return groupSort.value[sortMenu.value.target.replace(/^group:/, '')] || 'name-asc';
});

const sortMenuLabel = computed(() => `${sortMenu.value.label}排序`);

function isSortMenuOpen(target: string) {
  return sortMenu.value.open && sortMenu.value.target === target;
}

function sortMenuItems(): HTMLButtonElement[] {
  return Array.from(sortMenuEl.value?.querySelectorAll<HTMLButtonElement>('.sort-menu-item') || []);
}

function focusSortMenuItem(value?: string) {
  const items = sortMenuItems();
  if (!items.length) return;
  const current = items.find((item) => item.dataset.value === value);
  (current || items[0]).focus({ preventScroll: true });
}

async function openSortMenu(event: MouseEvent, target: string, label: string) {
  if (isSortMenuOpen(target)) {
    closeSortMenu();
    return;
  }
  sortMenuTrigger = event.currentTarget as HTMLElement;
  const rect = sortMenuTrigger.getBoundingClientRect();
  sortMenu.value = {
    open: true,
    ready: false,
    target,
    label,
    left: rect.right - SORT_MENU_MIN_WIDTH,
    top: rect.bottom + 4,
  };
  await nextTick();
  const menu = sortMenuEl.value;
  if (!menu) return;
  const { width, height } = menu.getBoundingClientRect();
  const maxLeft = Math.max(SORT_MENU_MARGIN, window.innerWidth - width - SORT_MENU_MARGIN);
  sortMenu.value.left = Math.min(Math.max(SORT_MENU_MARGIN, rect.right - width), maxLeft);
  sortMenu.value.top = rect.bottom + height + 4 > window.innerHeight - SORT_MENU_MARGIN
    ? Math.max(SORT_MENU_MARGIN, rect.top - height - 4)
    : rect.bottom + 4;
  sortMenu.value.ready = true;
  await nextTick();
  focusSortMenuItem(sortMenuValue.value);
}

function closeSortMenu(restoreFocus = false) {
  if (!sortMenu.value.open) return;
  sortMenu.value.open = false;
  sortMenu.value.ready = false;
  if (restoreFocus && sortMenuTrigger) {
    sortMenuTrigger.focus({ preventScroll: true });
    // 焦点回到触发器会触发 v-tooltip 的 focus 提示，选择后立即收起，避免气泡滞留在界面上
    hideTooltip(sortMenuTrigger);
  }
}

function chooseSort(value: string) {
  const target = sortMenu.value.target;
  if (target === 'files') sortFiles.value = value;
  else if (target === 'chat') sortChat.value = value;
  else if (target.startsWith('group:')) groupSort.value[target.slice('group:'.length)] = value;
  closeSortMenu(true);
}

function onSortMenuKeydown(event: KeyboardEvent) {
  const items = sortMenuItems();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSortMenu(true);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    items[(current + 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    items[(current - 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === 'Tab') {
    closeSortMenu();
  }
}

function onSortMenuPointerDown(event: PointerEvent) {
  if (!sortMenu.value.open) return;
  const node = event.target as Node;
  if (sortMenuEl.value?.contains(node) || sortMenuTrigger?.contains(node)) return;
  closeSortMenu();
}

/** 滚动、缩放、失焦时收起弹层，避免弹层与触发器脱节 */
function closeSortMenuOnViewportChange() {
  closeSortMenu();
}

const uploadInput = ref<HTMLInputElement>();
// Windows 桌面版导入只收 Markdown：其他格式落盘后无法作为页面提炼，拦在入口并把原因说清楚
const desktopMdOnly = Boolean((window as any).wikiDesktop);
const MD_EXTS = ['.md', '.markdown'];
const defaultCollapsed: Record<string, boolean> = {
  concept: true,
  entity: true,
  archived: true,
  files: true,
  chat: true,
  ailog: true,
};

function loadCollapsedState() {
  try {
    const saved = JSON.parse(localStorage.getItem('sidebarCollapsed') || 'null');
    return saved && typeof saved === 'object'
      ? { ...defaultCollapsed, ...saved }
      : { ...defaultCollapsed };
  } catch {
    return { ...defaultCollapsed };
  }
}

const collapsed = ref<Record<string, boolean>>(loadCollapsedState());

/** 一键全部收起/展开：顶层分区 + 实体子类 */
const COLLAPSE_ALL_KEYS = [
  'concept', 'entity', 'archived', 'files', 'chat', 'ailog',
  'entity:person', 'entity:customer', 'entity:org', 'entity:project', 'entity:other',
];
const allCollapsed = computed(() => COLLAPSE_ALL_KEYS.every((k) => collapsed.value[k]));

function toggleAll() {
  const target = !allCollapsed.value;
  for (const k of COLLAPSE_ALL_KEYS) collapsed.value[k] = target;
}
let chatTimer: ReturnType<typeof setTimeout> | undefined;
let chatStopped = false;
/** 轻量刷新对话文件列表：外部 Agent 经 save_chat 写入后，对话分区数秒内出现新文件 */
async function refreshChats() {
  try {
    const { data } = await api.get('/api/files/list?dir=' + encodeURIComponent('原始资料/对话'));
    chatFiles.value = data.files;
  } catch { /* 保留上次状态 */ }
  if (!chatStopped) chatTimer = setTimeout(refreshChats, 5000);
}

/** 文件行提取进度：后台处理保持隐藏，只把当前文件自身的进度就地展示 */
function fileJob(path: string) {
  return app.fileJob(path);
}

/** 多选状态：'p:<pageId>' 或 'f:<path>' */
const selected = ref(new Set<string>());
const selectionMode = computed(() => selected.value.size > 0);
const selectedPageCount = computed(() =>
  [...selected.value].filter((key) => key.startsWith('p:')).length
);
const selectedFileCount = computed(() =>
  [...selected.value].filter((key) => key.startsWith('f:')).length
);
const exporting = ref(false);

/** 把给定路径列表打包成 zip 下载。单文件直接走 /api/files/raw。
 *  name 为 zip 文件名前缀（如"原始资料"/"Wiki导出"），默认"导出"。 */
async function exportFiles(paths: string[], name?: string) {
  if (!paths.length) return;
  if (paths.length === 1) {
    const link = document.createElement('a');
    link.href = `/api/files/raw?path=${encodeURIComponent(paths[0])}`;
    link.download = paths[0].split('/').pop() || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  exporting.value = true;
  try {
    const res = await api.post('/api/files/export', { paths, name }, { responseType: 'blob' });
    const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const label = name || '导出';
    link.download = `${label}-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    notify.success(`已导出 ${paths.length} 个文件`);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '导出失败');
  } finally {
    exporting.value = false;
  }
}

/** 批量导出选中项：同时支持文件(f:)与页面(p:)。
 *  页面选中存的是 pageId，需从 allPages 反查 path。 */
async function exportSelected() {
  const filePaths = [...selected.value].filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
  const pageIds = [...selected.value].filter((k) => k.startsWith('p:')).map((k) => k.slice(2));
  const pagePaths = pageIds
    .map((id) => allPages.value.find((p) => p.id === id)?.path)
    .filter(Boolean) as string[];
  const paths = [...filePaths, ...pagePaths];
  if (!paths.length) return;
  await exportFiles(paths);
}

async function exportAllFiles() {
  const paths = files.value.map((f: any) => f.path).filter(Boolean);
  if (!paths.length) return;
  await exportFiles(paths, '原始资料');
}

/** 导出某类型分区（概念/实体/归档）的全部页面 */
async function exportAllPages(g: any) {
  const pages = g.subGroups
    ? g.subGroups.flatMap((sub: any) => filteredPages(sub.pages))
    : filteredPages(g.pages);
  const paths = pages.map((p: any) => p.path).filter(Boolean);
  if (!paths.length) return;
  await exportFiles(paths, g.label + '导出');
}

function toggleSelect(item: any) {
  const key = String(item.id).startsWith('f:') || String(item.id).startsWith('p:')
    ? String(item.id)
    : 'p:' + item.id;
  const s = new Set(selected.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  selected.value = s;
}

function clearSelection() {
  selected.value = new Set();
}

async function batchArchive() {
  const pageIds = [...selected.value].filter((k) => k.startsWith('p:')).map((k) => k.slice(2));
  if (!pageIds.length) return;
  for (const id of pageIds) {
    await api.post(`/api/pages/${id}/archive`);
  }
  clearSelection();
  await load();
}

async function batchDelete() {
  const n = selected.value.size;
  const ok = await confirmDialog({
    title: '批量删除',
    message: `删除选中的 ${n} 项？（移入回收站）`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  for (const key of selected.value) {
    if (key.startsWith('p:')) await api.delete(`/api/pages/${key.slice(2)}`);
    else await api.delete('/api/files', { data: { path: key.slice(2) } });
  }
  clearSelection();
  await load();
}

const TYPE_LABELS: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织',
  project: '项目', other: '其他',
};

/** 拖拽改归属：拖动页面行到实体子类/概念标题上，改变页面 type */
const draggedPage = ref<any | null>(null);
const dragOverKey = ref('');

function canDropTo(typeKey: string): boolean {
  return !!draggedPage.value
    && !draggedPage.value.path.startsWith('Wiki/归档/')
    && draggedPage.value.type !== typeKey;
}

function onDragStart(page: any) {
  draggedPage.value = page;
}

function onDragEnd() {
  draggedPage.value = null;
  dragOverKey.value = '';
}

function onDragOverSub(e: DragEvent, typeKey: string) {
  if (!canDropTo(typeKey)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  if (dragOverKey.value !== typeKey) dragOverKey.value = typeKey;
}

function onDragLeave(typeKey: string) {
  if (dragOverKey.value === typeKey) dragOverKey.value = '';
}

async function onDropToType(typeKey: string) {
  const page = draggedPage.value;
  dragOverKey.value = '';
  draggedPage.value = null;
  if (!page || page.type === typeKey) return;
  await changePageType(page, typeKey);
}

async function changePageType(page: any, newType: string) {
  try {
    await api.put(`/api/pages/${page.id}`, { type: newType });
    await load();
    notify.success(`已将「${page.title}」移动到${TYPE_LABELS[newType] || newType}`);
  } catch (e: any) {
    notify.error(e.response?.data?.error || '移动失败');
  }
}

/** 右键页面行：归档 / 删除（语义合并交给外部 Agent 处理） */
function onPageContextMenu({ x, y, page }: { x: number; y: number; page: any }) {
  const isArchived = page.path.startsWith('Wiki/归档/');
  const items: ContextMenuItem[] = [
    {
      id: 'archive',
      label: isArchived ? '取消归档' : '归档',
      icon: isArchived ? 'restore' : 'archive',
      action: () => (isArchived ? unarchivePage(page) : archivePage(page)),
    },
    { id: 'delete', label: '删除', icon: 'trash', action: () => removePage(page) },
  ];
  openContextMenu({ x, y, items });
}

/** 右键/⋯ 资料行：下载 / 删除 */
function onFileContextMenu({ x, y, file }: { x: number; y: number; file: any }) {
  const items: ContextMenuItem[] = [
    {
      id: 'download',
      label: '下载',
      icon: 'download',
      action: () => {
        const a = document.createElement('a');
        a.href = `/api/files/raw?path=${encodeURIComponent(file.path)}`;
        a.download = file.name;
        a.click();
      },
    },
    { id: 'delete', label: '删除', icon: 'trash', action: () => removeFile(file) },
  ];
  openContextMenu({ x, y, items });
}

const activeId = computed(() => (route.params.id as string) || '');
const fileQuery = computed(() => (route.query.file as string) || '');

const GROUPS = [
  { key: 'concept', label: '概念' },
  {
    key: 'entity',
    label: '实体',
    subs: [
      { key: 'person', label: '人物' },
      { key: 'customer', label: '客户' },
      { key: 'org', label: '组织' },
      { key: 'project', label: '项目' },
      { key: 'other', label: '其他' },
    ],
  },
  { key: 'archived', label: '归档' },
];

/** 已从词表移除的历史类型（place/work）：归到「其他」，避免老页面在侧栏消失 */
const LEGACY_ENTITY_TYPES = ['place', 'work'];

/** 顶层分组：概念 / 实体 / 归档（状态分类），其余走原始资料、AI 日志等专属分区 */
function topGroupOf(p: any): string {
  if (p.path.startsWith('原始资料/')) return 'raw'; // 原始资料只在文件区展示
  if (p.path.startsWith('AIWorks/')) return 'system'; // AI 工作区只在日志区展示
  if (p.path.startsWith('Wiki/归档/')) return 'archived';
  if (p.path.startsWith('Wiki/查询/')) return 'qa';
  if (p.type === 'concept') return 'concept';
  if (['person', 'customer', 'org', 'project', 'other', ...LEGACY_ENTITY_TYPES].includes(p.type)) return 'entity';
  return 'unclassified'; // 未分类页面只在「全部页面」出现
}

/** 实体下的子类：人物 / 客户 / 组织 / 项目 / 其他 */
function subGroupOf(p: any): string | null {
  if (p.type === 'person') return 'person';
  if (p.type === 'customer') return 'customer';
  if (p.type === 'org') return 'org';
  if (p.type === 'project') return 'project';
  if (LEGACY_ENTITY_TYPES.includes(p.type)) return 'other';
  if (p.type === 'other') return 'other';
  return null;
}

const typeGroups = computed(() =>
  GROUPS.map((g) => {
    if (g.subs) {
      const subGroups = g.subs
        .map((s) => ({
          ...s,
          pages: allPages.value.filter(
            (p) => topGroupOf(p) === g.key && subGroupOf(p) === s.key
          ),
        }))
        .filter((s) => s.pages.length > 0); // 空子类不展示
      return { ...g, pages: [] as any[], subGroups };
    }
    return {
      ...g,
      pages: allPages.value.filter((p) => topGroupOf(p) === g.key),
      subGroups: undefined,
    };
  })
);

/** 实体顶层计数为各子类合计；概念/归档为该组过滤后页数 */
function groupPageCount(g: any): number {
  if (g.subGroups) {
    return g.subGroups.reduce(
      (sum: number, sub: any) => sum + filteredPages(sub.pages).length,
      0
    );
  }
  return filteredPages(g.pages).length;
}

/** 实体下过滤后仍有页面的子类（搜索时空子类标题随之隐藏） */
function visibleSubGroups(g: any) {
  return (g.subGroups || []).filter(
    (sub: any) => filteredPages(sub.pages).length > 0
  );
}

/** 已废弃的冲突备份机制遗留（2026-09-12 前那套备份页）：系统区不再产生这类页面，
 *  历史遗留（旧库/旧快照播种的成员端）一律不入侧栏，等启动迁移收进回收站 */
const LEGACY_CONFLICT_RE = /^AIWorks\/同步冲突\/|^AIWorks\/log\/conflict\.md$|^同步冲突\//;

/** AI 系统区（操作日志/索引/关系结构，含历史版本遗留路径）在日志区展示 */
const aiLogs = computed(() =>
  allPages.value.filter(
    (p) =>
      !LEGACY_CONFLICT_RE.test(p.path) &&
      (p.path.startsWith('AIWorks/') ||
        p.path.startsWith('Wiki/关系/') ||
        p.path === 'Wiki/index.md' ||
        p.path === 'Wiki/log.md')
  )
);

/** 对话分区文件（原始资料/对话/，递归；与原始资料同构） */
const chatFiles = ref<any[]>([]);

const normalizedFilter = computed(() => filter.value.trim().toLocaleLowerCase('zh-CN'));

function textMatches(value: unknown) {
  return String(value || '').toLocaleLowerCase('zh-CN').includes(normalizedFilter.value);
}

function filteredPages(pages: any[]) {
  if (!normalizedFilter.value) return pages;
  return pages.filter(
    (page) =>
      textMatches(page.title) ||
      textMatches(page.path) ||
      (page.tags || []).some((tag: string) => textMatches(tag))
  );
}

const visibleFiles = computed(() =>
  normalizedFilter.value
    ? files.value.filter((file) => textMatches(file.name) || textMatches(file.path))
    : files.value
);

const visibleChatFiles = computed(() =>
  normalizedFilter.value
    ? chatFiles.value.filter((file) => textMatches(file.name) || textMatches(file.path))
    : chatFiles.value
);
const visibleAiLogs = computed(() => filteredPages(aiLogs.value));

function toggle(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

/** 排序：Wiki 页面与原始资料可调（名称/时间），AI 整理日志固定时间最近的在上 */
function sortList(list: any[], mode: string): any[] {
  const sorted = [...list];
  const nameOf = (x: any) => x.title || x.name || '';
  switch (mode) {
    case 'name-asc':
      return sorted.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN'));
    case 'name-desc':
      return sorted.sort((a, b) => nameOf(b).localeCompare(nameOf(a), 'zh-CN'));
    case 'updated-desc':
      return sorted.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    case 'created-desc':
      return sorted.sort((a, b) =>
        (b.created_at || b.updated_at || '').localeCompare(a.created_at || a.updated_at || '')
      );
    default:
      return sorted;
  }
}

watch([sortFiles, sortChat], () => {
  localStorage.setItem('sortFiles', sortFiles.value);
  localStorage.setItem('sortChat', sortChat.value);
});
watch(
  groupSort,
  (value) => {
    localStorage.setItem('sortConcept', value.concept);
    localStorage.setItem('sortEntity', value.entity);
    localStorage.setItem('sortArchived', value.archived);
  },
  { deep: true }
);
watch(
  collapsed,
  (value) => localStorage.setItem('sidebarCollapsed', JSON.stringify(value)),
  { deep: true }
);

async function load() {
  const [{ data: pl }, { data: fl }, { data: cf }] = await Promise.all([
    api.get('/api/pages/list'),
    api.get('/api/files/list'),
    api.get('/api/files/list?dir=' + encodeURIComponent('原始资料/对话')),
  ]);
  allPages.value = pl.pages;
  files.value = fl.files;
  chatFiles.value = cf.files;
}

function openPage(p: any) {
  router.push(`/page/${p.id}`);
}

function openFile(f: any) {
  // md 文件直接进编辑器（可编辑），其他格式走预览
  if (f.pageId) {
    router.push(`/page/${f.pageId}`);
  } else {
    router.push({ path: '/page', query: { file: f.path } });
  }
}

function isActiveFile(file: any) {
  return fileQuery.value === file.path ||
    (!!file.pageId && String(file.pageId) === String(activeId.value));
}

async function createFile() {
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog
  const name = await promptDialog({
    title: '新建文件',
    message: '文件名（.md 可直接编辑）：',
    value: '未命名.md',
    confirmText: '创建',
  });
  if (name === null) return;
  try {
    const { data } = await api.post('/api/files/create', { name: name || '未命名.md' });
    await load();
    if (data.pageId) router.push(`/page/${data.pageId}`);
    else router.push({ path: '/page', query: { file: data.path } });
  } catch (e: any) {
    notify.error(e.response?.data?.error || '创建失败');
  }
}

/** 桌面版导入前的格式闸门；返回放行的文件，被拦下的逐个点名提示 */
function gateImport(list: File[]): File[] {
  if (!desktopMdOnly) return list;
  const keep = list.filter((f) => MD_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)));
  const skipped = list.filter((f) => !keep.includes(f));
  if (skipped.length) {
    notify.error(
      `Windows 版只接收 Markdown 文档，以下文件未导入：${skipped.map((f) => f.name).join('、')}；` +
        '其他格式请先用外置 Agent 转成 Markdown 再导入（ZCode / Codex / Claude Code 经 MCP 读写本库）',
    );
  }
  return keep;
}

async function uploadFiles(list: File[]) {
  list = gateImport(list);
  if (!list.length) return;
  const fd = new FormData();
  fd.append('dir', '原始资料');
  for (const f of list) fd.append('files', f);
  try {
    const { data } = await api.post('/api/files/upload', fd);
    // 部分文件重复时提示，但已成功的照常导入
    if (data.duplicates?.length) {
      notify.info(`以下文件已存在，未重复导入：${data.duplicates.join('、')}`);
    }
  } catch (err: any) {
    notify.error(err.response?.data?.error || '上传失败');
  }
  await load();
}

async function onUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  await uploadFiles([...(input.files || [])]);
  input.value = '';
}

/** 外部文件拖入原始资料分区即上传；内部页面拖拽（types 无 Files）不受影响 */
const filesDropHot = ref(false);

function isFileDrag(e: DragEvent): boolean {
  return !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
}

function onFilesDragOver(e: DragEvent) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  filesDropHot.value = true;
}

function onFilesDragLeave(e: DragEvent) {
  if (!isFileDrag(e)) return;
  const rt = e.relatedTarget as Node | null;
  if (rt && (e.currentTarget as Node).contains(rt)) return;
  filesDropHot.value = false;
}

async function onFilesDrop(e: DragEvent) {
  if (!isFileDrag(e)) return;
  filesDropHot.value = false;
  await uploadFiles([...(e.dataTransfer?.files || [])]);
}

async function archivePage(p: any) {
  await api.post(`/api/pages/${p.id}/archive`);
  await load();
  if (p.id === activeId.value) router.push('/page');
}

async function unarchivePage(p: any) {
  await api.post(`/api/pages/${p.id}/unarchive`);
  await load();
}

async function removePage(p: any) {
  const ok = await confirmDialog({
    title: '删除页面',
    message: `确定删除「${p.title}」？（移入回收站）`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await api.delete(`/api/pages/${p.id}`);
  await load();
  if (p.id === activeId.value) router.push('/page');
}

async function removeFile(f: any) {
  const ok = await confirmDialog({
    title: '删除文件',
    message: `确定删除「${f.name}」？（移入回收站）`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await api.delete('/api/files', { data: { path: f.path } });
  await load();
}

function openUpload() {
  uploadInput.value?.click();
}

defineExpose({ load, openUpload });
watch(() => app.sidebarVersion, () => load());
onMounted(() => {
  load();
  chatStopped = false;
  refreshChats();
  document.addEventListener('pointerdown', onSortMenuPointerDown, true);
  window.addEventListener('resize', closeSortMenuOnViewportChange);
  window.addEventListener('blur', closeSortMenuOnViewportChange);
  window.addEventListener('scroll', closeSortMenuOnViewportChange, true);
});
onUnmounted(() => {
  chatStopped = true;
  if (chatTimer) clearTimeout(chatTimer);
  document.removeEventListener('pointerdown', onSortMenuPointerDown, true);
  window.removeEventListener('resize', closeSortMenuOnViewportChange);
  window.removeEventListener('blur', closeSortMenuOnViewportChange);
  window.removeEventListener('scroll', closeSortMenuOnViewportChange, true);
});
</script>
<style scoped>
.sidebar-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  color: var(--text);
}
.sidebar-header {
  flex-shrink: 0;
  padding: 12px 11px 7px;
}

.sidebar-titlebar {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 3px 8px 5px;
}

.sidebar-titlebar h2 {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  letter-spacing: 0;
}

.sidebar-title-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.sidebar-fold,
.sidebar-new,
.sidebar-close {
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-secondary);
}

.sidebar-fold,
.sidebar-new {
  display: flex;
}

.sidebar-close {
  display: none;
}

.sidebar-fold:hover,
.sidebar-new:hover,
.sidebar-close:hover {
  color: var(--text);
  background: var(--sidebar-hover);
}

.search-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.search-field {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 30px;
  display: flex;
  align-items: center;
  border: 1px solid var(--sidebar-control-border);
  border-bottom-color: color-mix(in srgb, var(--sidebar-control-border) 60%, var(--text-faint));
  border-radius: var(--radius-control);
  background: var(--sidebar-control);
  transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
}

.search-field:hover {
  background: var(--sidebar-control-focus);
}

/* Win11 文本框聚焦：无 halo，底缘 2px 强调线 */
.search-field:focus-within {
  background: var(--sidebar-control-focus);
  border-bottom-color: var(--sidebar-accent);
  box-shadow: inset 0 -1px 0 var(--sidebar-accent);
}

.search-icon {
  position: absolute;
  left: 9px;
  color: var(--text-faint);
  pointer-events: none;
}

.search-field input {
  width: 100%;
  height: 100%;
  min-width: 0;
  border: 0;
  border-radius: inherit;
  padding: 0 28px 0 30px;
  background: transparent;
  box-shadow: none;
  font-size: 13px;
}

.search-field input:focus {
  border-color: transparent;
}

.search-field input::placeholder {
  color: var(--text-faint);
}

.search-clear {
  position: absolute;
  right: 4px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-faint);
}

.search-clear:hover {
  color: var(--text);
  background: var(--sidebar-hover);
}

.sort-control {
  height: 24px;
  max-width: 116px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 0 5px;
  border: 1px solid var(--sidebar-control-border);
  border-radius: 4px;
  color: var(--text-faint);
  background: var(--sidebar-control);
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

.sort-control:hover {
  color: var(--text-secondary);
  background: var(--sidebar-hover);
}

.sort-control:focus-within {
  color: var(--text);
  box-shadow: 0 0 0 2px var(--sidebar-focus-ring);
}

.sort-control.section-sort {
  position: relative;
  width: 23px;
  height: 23px;
  max-width: none;
  flex: 0 0 23px;
  justify-content: center;
  margin-left: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: color 150ms ease, background 150ms ease, opacity 150ms ease;
}

.sec-row:hover .sort-control.section-sort,
.sec-row:focus-within .sort-control.section-sort,
.sort-control.section-sort:hover,
.sort-control.section-sort:focus-within,
.sort-control.section-sort.menu-open {
  opacity: 1;
  pointer-events: auto;
}

/* 弹层展开时保持触发器高亮，鼠标移入弹层后图标不消失 */
.sort-control.section-sort.menu-open {
  color: var(--text);
  background: var(--sidebar-hover);
}

/* 排序弹层：宽 152px 起，选项左右留白，当前项打勾 */
.sort-menu {
  position: fixed;
  z-index: var(--z-menu);
  min-width: 152px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--card-bg) 92%, transparent);
  box-shadow: var(--shadow);
  backdrop-filter: saturate(150%) blur(20px);
  -webkit-backdrop-filter: saturate(150%) blur(20px);
  color: var(--text);
  opacity: 0;
  pointer-events: none;
}

.sort-menu.ready {
  opacity: 1;
  pointer-events: auto;
}

.sort-menu-item {
  width: 100%;
  min-height: 30px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.sort-menu-item:hover,
.sort-menu-item:focus {
  outline: 0;
  background: var(--bg-hover);
  color: var(--text);
}

.sort-menu-item[aria-checked='true'] {
  color: var(--text);
}

.sort-menu-check {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--sidebar-accent);
}

.sort-menu-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 3px 10px 14px;
}

.side-scroll::-webkit-scrollbar {
  width: 6px;
}

.sidebar-category {
  margin-bottom: 0;
}

.section-separator {
  height: 1px;
  margin: 10px 8px;
  background: var(--sidebar-hairline);
}

.section {
  margin-bottom: 1px;
}

.sec-row {
  position: relative;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 8px;
  border-radius: 4px;
  user-select: none;
  transition: background 150ms ease;
}

.sec-row.expanded::before {
  content: '';
  position: absolute;
  top: 9px;
  bottom: 9px;
  left: 3px;
  width: 2px;
  border-radius: 1px;
  background: var(--text-faint);
  opacity: 0.55;
}

.sec-row:hover {
  background: var(--sidebar-hover);
}

.sec-toggle {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 0 0 3px;
  border-radius: 4px;
  color: var(--text-secondary);
  text-align: left;
}

.sec-toggle:focus-visible,
.add-btn:focus-visible,
.sidebar-close:focus-visible,
.search-clear:focus-visible,
.batch-btn:focus-visible {
  outline: 2px solid var(--sidebar-accent);
  outline-offset: 1px;
}

.sec-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0;
}

.sec-actions {
  display: flex;
  align-items: center;
  gap: 1px;
}

.sec-count {
  min-width: 19px;
  flex-shrink: 0;
  padding: 0 3px;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.add-btn {
  width: 23px;
  height: 23px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 4px;
  color: var(--text-faint);
  opacity: 0;
  transition: color 150ms ease, background 150ms ease, opacity 150ms ease;
}

.sec-row:hover .add-btn,
.sec-row:focus-within .add-btn,
.add-btn:focus-visible {
  opacity: 1;
}

.add-btn:hover {
  color: var(--text);
  background: var(--sidebar-active);
}

.sec-body {
  padding: 2px 0 5px 14px;
}

.sub-group {
  position: relative;
}

.sub-group + .sub-group {
  margin-top: 2px;
}

.sub-head {
  position: relative;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 4px 8px 2px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.sub-head:hover {
  color: var(--text-secondary);
  background: var(--sidebar-hover);
}

.sub-head.drop-target,
.sec-toggle.drop-target {
  background: color-mix(in srgb, var(--sidebar-accent) 15%, transparent);
  box-shadow: inset 0 0 0 2px var(--sidebar-accent);
  color: var(--sidebar-accent);
}

/* 外部文件拖入原始资料分区的落点高亮 */
.section.files-drop {
  outline: 2px dashed var(--sidebar-accent);
  outline-offset: -2px;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--sidebar-accent) 8%, transparent);
}

.sub-head:focus-visible {
  outline: 2px solid var(--sidebar-accent);
  outline-offset: 1px;
}

.sub-group.expanded > .sub-head::before {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 4px;
  left: 0;
  width: 2px;
  border-radius: 1px;
  background: var(--text-faint);
  opacity: 0.5;
}

.sub-body {
  padding: 1px 0 2px;
}

.sub-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub-count {
  min-width: 19px;
  flex-shrink: 0;
  padding: 0 3px;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.page-row {
  position: relative;
  height: 30px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12.5px;
  outline: none;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

.page-row:hover {
  background: var(--sidebar-hover);
}

.page-row:focus-visible {
  box-shadow: inset 0 0 0 2px var(--sidebar-accent);
}

.page-row.active {
  color: var(--text);
  background: var(--sidebar-selection);
  box-shadow: inset 0 0 0 1px var(--sidebar-selection-border);
  font-weight: 500;
}

/* Win11 NavigationView 选中指示条：行左缘 3px 圆角强调色 pill */
.page-row.active::before {
  content: '';
  position: absolute;
  top: 7px;
  bottom: 7px;
  left: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--sidebar-accent);
}

.page-row.selected {
  background: var(--sidebar-selection-strong);
}

.page-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-file-icon {
  flex-shrink: 0;
  color: var(--text-faint);
}

.log-row {
  padding-left: 8px;
}

.none {
  margin: 2px 0;
  padding: 5px 8px 5px 20px;
  color: var(--text-faint);
  font-size: 11px;
}

.batch-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 10px;
  border-top: 1px solid var(--sidebar-hairline);
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: saturate(140%) blur(18px);
  -webkit-backdrop-filter: saturate(140%) blur(18px);
}

.batch-count {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 11px;
}

.batch-btn {
  min-width: 42px;
  height: 26px;
  padding: 0 8px;
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--sidebar-control);
  font-size: 11px;
}

.batch-btn:hover {
  color: var(--text);
  background: var(--sidebar-active);
}

.batch-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.batch-btn.danger {
  color: var(--danger);
}

.faint-btn {
  color: var(--text-faint);
}

.rise-enter-active,
.rise-leave-active {
  transition: transform 160ms ease, opacity 160ms ease;
}

.rise-enter-from,
.rise-leave-to {
  transform: translateY(8px);
  opacity: 0;
}

@media (max-width: 768px) {
  .sidebar-header {
    padding-top: calc(12px + env(safe-area-inset-top));
  }

  .sidebar-close {
    display: flex;
  }

  .add-btn {
    opacity: 0.82;
  }

  .sort-control.section-sort {
    opacity: 0.72;
    pointer-events: auto;
  }
}

/* 触屏（无 hover）：分区操作按钮、排序、日志行下载常显，769-1024px 触屏（折叠屏内屏）同样适用 */
@media (hover: none) and (pointer: coarse) {
  .add-btn {
    opacity: 0.82;
  }

  .sort-control.section-sort {
    opacity: 0.72;
    pointer-events: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .search-field,
  .sec-row,
  .add-btn,
  .page-row,
  .rise-enter-active,
  .rise-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
