<template>
  <div class="sidebar-inner">
    <header class="sidebar-header">
      <div class="sidebar-titlebar">
        <h2>知识库</h2>
        <div class="sidebar-title-actions">
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
      <span v-if="ingestHint" class="ingest-hint" v-tooltip="ingestHint" aria-live="polite">✦ {{ ingestHint }}</span>
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
              v-tooltip="'collapsed[g.key] ? `展开${g.label}` : `收起${g.label}`'"
              @click="toggle(g.key)"
              @dragover="g.key === 'concept' && onDragOverSub($event, 'concept')"
              @dragleave="g.key === 'concept' && onDragLeave('concept')"
              @drop.prevent="g.key === 'concept' && onDropToType('concept')"
            >
              <span class="sec-name">{{ g.label }}</span>
            </button>
            <div class="sec-actions">
              <label class="sort-control section-sort" v-tooltip="`${g.label}排序：${sortLabel(groupSort[g.key])}`">
                <Icon name="sort" :size="12" />
                <select v-model="groupSort[g.key]" :aria-label="`${g.label}排序`">
                  <option value="name-asc">名称 A→Z</option>
                  <option value="name-desc">名称 Z→A</option>
                  <option value="updated-desc">更新时间</option>
                  <option value="created-desc">创建时间</option>
                </select>
              </label>
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
                  v-tooltip="'collapsed[`${g.key}:${sub.key}`] ? `展开${sub.label}` : `收起${sub.label}`'"
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

      <!-- 原始资料：进料口。上传/新建；AI 整理提炼到 Wiki -->
      <section class="section">
        <div
          class="sec-row"
          :class="{ expanded: !collapsed.files }"
        >
          <button
            class="sec-toggle"
            type="button"
            :aria-expanded="!collapsed.files"
            v-tooltip="'collapsed.files ? \'展开原始资料\' : \'收起原始资料\''"
            @click="toggle('files')"
          >
            <span class="sec-name">原始资料</span>
          </button>
          <button
            v-if="filesCoverage.supported"
            class="coverage-badge"
            :class="{ warn: filesCoverage.attention > 0 }"
            type="button"
            v-tooltip="filesCoverage.attention > 0
              ? `${filesCoverage.ingested}/${filesCoverage.supported} 已整理,${filesCoverage.attention} 份需要处理 — 点击查看提炼看板`
              : `${filesCoverage.supported} 份资料全部已整理 — 点击查看提炼看板`"
            @click="router.push('/ingest-coverage')"
          >
            {{ filesCoverage.ingested }}/{{ filesCoverage.supported }}
          </button>
          <div class="sec-actions">
            <label class="sort-control section-sort" v-tooltip="`原始资料排序：${sortFilesLabel}`">
              <Icon name="sort" :size="12" />
              <select v-model="sortFiles" aria-label="原始资料排序">
                <option value="name-asc">名称 A→Z</option>
                <option value="name-desc">名称 Z→A</option>
                <option value="updated-desc">更新时间</option>
                <option value="created-desc">创建时间</option>
              </select>
            </label>
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
              v-tooltip="'AI 整理全部(已整理且未变更的自动跳过,只处理新增/变更/失败的)'"
              aria-label="AI 整理全部"
              @click="ingestAll"
            >
              <Icon name="ai" :size="13" />
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
              v-tooltip="'上传文件'"
              aria-label="上传文件"
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
            @ingest="ingestFile"
            @remove="removeFile"
          />
          <p v-if="!visibleFiles.length" class="none">
            {{ filter ? '没有匹配资料' : '暂无资料' }}
          </p>
        </div>
        <input ref="uploadInput" type="file" multiple hidden @change="onUpload" />
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
            v-tooltip="'collapsed.chat ? \'展开对话\' : \'收起对话\''"
            @click="toggle('chat')"
          >
            <span class="sec-name">对话</span>
          </button>
          <div class="sec-actions">
            <label class="sort-control section-sort" v-tooltip="`对话排序：${sortChatLabel}`">
              <Icon name="sort" :size="12" />
              <select v-model="sortChat" aria-label="对话排序">
                <option value="name-asc">名称 A→Z</option>
                <option value="name-desc">名称 Z→A</option>
                <option value="updated-desc">更新时间</option>
                <option value="created-desc">创建时间</option>
              </select>
            </label>
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
            @ingest="ingestFile"
            @remove="removeFile"
          />
          <p v-if="!visibleChatFiles.length" class="none">
            {{ filter ? '没有匹配对话' : '暂无对话' }}
          </p>
        </div>
      </section>

      <div class="section-separator" />

      <!-- AI 整理日志（只读） -->
      <section class="section">
        <div
          class="sec-row"
          :class="{ expanded: !collapsed.ailog }"
        >
          <button
            class="sec-toggle"
            type="button"
            :aria-expanded="!collapsed.ailog"
            v-tooltip="'collapsed.ailog ? \'展开 AI 整理日志\' : \'收起 AI 整理日志\''"
            @click="toggle('ailog')"
          >
            <span class="sec-name">AI 整理日志</span>
          </button>
          <div class="sec-actions">
            <button
              class="add-btn"
              type="button"
              v-tooltip="'导出全部 AI 整理日志'"
              aria-label="导出全部 AI 整理日志"
              :disabled="!visibleAiLogs.length || exporting"
              @click="exportAllAiLogs"
            >
              <Icon name="download" :size="13" />
            </button>
            <span class="sec-count">{{ visibleAiLogs.length }}</span>
          </div>
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
            <span class="row-trailing">
              <span class="row-actions" @click.stop>
                <a
                  class="row-action-link"
                  :href="`/api/files/raw?path=${encodeURIComponent(p.path)}`"
                  :download="p.title + '.md'"
                  v-tooltip="`下载 ${p.title}`"
                  :aria-label="`下载 ${p.title}`"
                >
                  <Icon name="download" :size="13" />
                </a>
              </span>
            </span>
          </div>
          <p v-if="!visibleAiLogs.length" class="none">
            {{ filter ? '没有匹配日志' : '智能整理运行后自动生成' }}
          </p>
        </div>
      </section>

      <!-- 标签 -->
      <div v-if="tags.length" class="tags-block">
        <div class="sec-row" :class="{ expanded: !collapsed.tags }">
          <button
            class="sec-toggle"
            type="button"
            :aria-expanded="!collapsed.tags"
            v-tooltip="'collapsed.tags ? \'展开标签\' : \'收起标签\''"
            @click="toggle('tags')"
          >
            <span class="sec-name">标签</span>
          </button>
          <span class="sec-count">{{ tags.length }}</span>
        </div>
        <div v-show="!collapsed.tags" class="tags">
          <button v-for="t in tags" :key="t.name" class="tag" type="button" @click="searchTag(t.name)">
            #{{ t.name }} {{ t.count }}
          </button>
        </div>
      </div>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { humanError } from '../lib/ingestError';
import { useAppStore } from '../stores/app';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import { openContextMenu, type ContextMenuItem } from '../lib/contextMenu';
import { openMergeDialog } from '../lib/mergeDialog';
import Icon from './Icon.vue';
import PageRow from './PageRow.vue';
import FileRow from './FileRow.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const emit = defineEmits(['close', 'new-page']);

const allPages = ref<any[]>([]);
const files = ref<any[]>([]);
const tags = ref<{ name: string; count: number }[]>([]);
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
const uploadInput = ref<HTMLInputElement>();
const defaultCollapsed: Record<string, boolean> = {
  concept: true,
  entity: true,
  archived: true,
  files: true,
  chat: true,
  ailog: true,
  tags: true,
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
const ingestHint = ref('');
let chatTimer: ReturnType<typeof setTimeout> | undefined;
let chatStopped = false;
/** 轻量刷新对话文件列表：外置 Agent 经 save_chat 写入后，对话分区数秒内出现新文件与整理状态 */
async function refreshChats() {
  try {
    const { data } = await api.get('/api/files/list?dir=' + encodeURIComponent('原始资料/对话'));
    chatFiles.value = data.files;
  } catch { /* 保留上次状态 */ }
  if (!chatStopped) chatTimer = setTimeout(refreshChats, 5000);
}

/** 文件行整理进度：取自 app 共享任务队列（Home 自适应轮询维护，角标/面板/侧栏同一数据源） */
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

/** 导出 AI 整理日志分区的全部页面 */
async function exportAllAiLogs() {
  const paths = aiLogs.value.map((p: any) => p.path).filter(Boolean);
  if (!paths.length) return;
  await exportFiles(paths, 'AI整理日志');
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
  place: '地点', work: '作品', project: '产品', other: '其他',
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

/** 右键页面行：合并 / 归档 / 删除 */
function onPageContextMenu({ x, y, page }: { x: number; y: number; page: any }) {
  const isArchived = page.path.startsWith('Wiki/归档/');
  const items: ContextMenuItem[] = [
    {
      id: 'merge',
      label: '合并到…',
      icon: 'merge',
      action: () => openMergeDialog(page),
    },
    {
      id: 'archive',
      label: isArchived ? '取消归档' : '归档',
      icon: isArchived ? 'restore' : 'archive',
      separatorBefore: true,
      action: () => (isArchived ? unarchivePage(page) : archivePage(page)),
    },
    { id: 'delete', label: '删除', icon: 'trash', action: () => removePage(page) },
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
      { key: 'place', label: '地点' },
      { key: 'work', label: '作品' },
      { key: 'project', label: '产品' },
      { key: 'other', label: '其他' },
    ],
  },
  { key: 'archived', label: '归档' },
];

/** 顶层分组：概念 / 实体 / 归档（状态分类），其余走原始资料、AI 日志等专属分区 */
function topGroupOf(p: any): string {
  if (p.path.startsWith('原始资料/')) return 'raw'; // 原始资料只在文件区展示
  if (p.path.startsWith('AIWorks/')) return 'system'; // AI 工作区只在日志区展示
  if (p.path.startsWith('Wiki/归档/')) return 'archived';
  if (p.path.startsWith('Wiki/查询/')) return 'qa';
  if (p.type === 'concept') return 'concept';
  if (['person', 'customer', 'org', 'place', 'work', 'project', 'other'].includes(p.type)) return 'entity';
  return 'unclassified'; // 未分类页面只在「全部页面」出现
}

/** 实体下的子类：人物 / 客户 / 组织 / 地点 / 作品 / 产品 / 其他 */
function subGroupOf(p: any): string | null {
  if (p.type === 'person') return 'person';
  if (p.type === 'customer') return 'customer';
  if (p.type === 'org') return 'org';
  if (p.type === 'place') return 'place';
  if (p.type === 'work') return 'work';
  if (p.type === 'project') return 'project';
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

const aiLogs = computed(() =>
  allPages.value.filter(
    (p) =>
      p.path.startsWith('AIWorks/log/') ||
      p.path.startsWith('Wiki/关系/') ||
      p.path === 'Wiki/index.md' ||
      p.path === 'Wiki/log.md'
  )
);

/** 对话分区文件（原始资料/对话/，递归；与原始资料同构：带已整理/整理中/整理失败标志） */
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

/** 原始资料提炼覆盖率:已整理/支持提炼/需处理 三计数,供分组角标展示 */
const filesCoverage = computed(() => {
  let supported = 0;
  let ingested = 0;
  let attention = 0;
  for (const file of files.value) {
    if (file.ingestSupported === false) continue;
    supported++;
    if (file.ingestedAt) {
      ingested++;
      continue;
    }
    if (file.ingestStatus === 'failed' || ['failed', 'blocked', 'partial'].includes(file.extractionStatus || '')) {
      attention++;
    } else if (!file.extractionStatus) {
      attention++;
    }
  }
  return { supported, ingested, attention };
});
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
  const [{ data: pl }, { data: fl }, { data: cf }, { data: tg }] = await Promise.all([
    api.get('/api/pages/list'),
    api.get('/api/files/list'),
    api.get('/api/files/list?dir=' + encodeURIComponent('原始资料/对话')),
    api.get('/api/pages/tags'),
  ]);
  allPages.value = pl.pages;
  files.value = fl.files;
  chatFiles.value = cf.files;
  tags.value = tg.tags;
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
  const name = prompt('文件名（.md 可直接编辑）：', '未命名.md');
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

async function onUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  const fd = new FormData();
  fd.append('dir', '原始资料');
  for (const f of input.files) fd.append('files', f);
  try {
    const { data } = await api.post('/api/files/upload', fd);
    // 部分文件重复时提示，但已成功的照常导入
    if (data.duplicates?.length) {
      ingestHint.value = `以下文件已存在，未重复导入：${data.duplicates.join('、')}`;
    }
  } catch (err: any) {
    notify.error(err.response?.data?.error || '上传失败');
  }
  input.value = '';
  await load();
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

/** AI 整理单个原始资料：提炼概念/实体页到 Wiki */
async function ingestFile(f: any) {
  try {
    await api.post('/api/ai/ingest', { path: f.path, force: true });
    ingestHint.value = `「${f.name}」已加入整理队列`;
    await app.refreshJobs();
  } catch (e: any) {
    ingestHint.value = humanError(e?.response?.data?.error || e?.message || '请求失败');
  }
}

async function ingestAll() {
  const ok = await confirmDialog({
    title: '整理全部原始资料',
    message: '将全部原始资料加入整理队列。已整理且内容未变更的会自动跳过,实际只处理新增、变更或之前失败的资料。继续?',
    confirmText: '继续',
  });
  if (!ok) return;
  try {
    const { data } = await api.post('/api/ai/ingest-all', { force: true });
    ingestHint.value = data.queued > 0 ? `已加入 ${data.queued} 份资料的整理队列` : '原始资料为空';
    if (data.queued > 0) await app.refreshJobs();
  } catch (e: any) {
    ingestHint.value = humanError(e?.response?.data?.error || e?.message || '请求失败');
  }
}

function searchTag(tag: string) {
  router.push({ path: '/search', query: { q: `#${tag}` } });
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
});
onUnmounted(() => {
  chatStopped = true;
  if (chatTimer) clearTimeout(chatTimer);
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

.sidebar-new,
.sidebar-close {
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-secondary);
}

.sidebar-new {
  display: flex;
}

.sidebar-close {
  display: none;
}

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
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--sidebar-control);
  box-shadow: inset 0 0 0 1px var(--sidebar-control-border);
  transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
}

.search-field:focus-within {
  border-color: var(--sidebar-accent);
  background: var(--sidebar-control-focus);
  box-shadow: 0 0 0 3px var(--sidebar-focus-ring);
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
  border-radius: 5px;
  color: var(--text-faint);
}

.search-clear:hover {
  color: var(--text);
  background: var(--sidebar-hover);
}

.ingest-hint {
  display: block;
  overflow: hidden;
  margin-top: 6px;
  padding: 0 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sidebar-accent);
  font-size: 11px;
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
  border-radius: 6px;
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
  box-shadow: 0 0 0 3px var(--sidebar-focus-ring);
}

.sort-control select {
  min-width: 0;
  height: 22px;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
  outline: none;
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
  border-radius: 5px;
  background: transparent;
  opacity: 0;
  pointer-events: none;
  transition: color 150ms ease, background 150ms ease, opacity 150ms ease;
}

.sec-row:hover .sort-control.section-sort,
.sec-row:focus-within .sort-control.section-sort,
.sort-control.section-sort:hover,
.sort-control.section-sort:focus-within {
  opacity: 1;
  pointer-events: auto;
}

.sort-control.section-sort select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
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
  border-radius: 8px;
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
  border-radius: 6px;
  color: var(--text-secondary);
  text-align: left;
}

.sec-toggle:focus-visible,
.add-btn:focus-visible,
.sidebar-close:focus-visible,
.search-clear:focus-visible,
.tag:focus-visible,
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

.coverage-badge {
  flex-shrink: 0;
  margin-left: 4px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: transparent;
  color: var(--success, #2e7d32);
  font-size: 10.5px;
  line-height: 17px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.coverage-badge:hover { border-color: var(--accent); background: var(--accent-soft); }
.coverage-badge.warn {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
  background: var(--warn-soft);
}

.add-btn {
  width: 23px;
  height: 23px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 5px;
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
  border-radius: 6px;
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
  border-radius: 7px;
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

/* AI 日志行内下载按钮（log-row 是手写结构，非 PageRow 组件） */
.log-row .row-trailing {
  position: relative;
  width: 22px;
  height: 100%;
  flex-shrink: 0;
  margin-left: auto;
}
.log-row .row-actions {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  align-items: center;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease;
}
.log-row:hover .row-actions,
.log-row:focus-within .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.log-row .row-action-link {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-faint);
  text-decoration: none;
}
.log-row .row-action-link:hover,
.log-row .row-action-link:focus-visible {
  color: var(--text);
  background: var(--sidebar-active);
  outline: none;
}

.none {
  margin: 2px 0;
  padding: 5px 8px 5px 20px;
  color: var(--text-faint);
  font-size: 11px;
}

.tags-block {
  padding: 9px 5px 4px;
}

.side-sub {
  padding: 0 6px 6px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 4px;
}

.tags .tag {
  max-width: 100%;
  overflow: hidden;
  padding: 2px 7px;
  border: 1px solid var(--sidebar-control-border);
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--sidebar-control);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tags .tag:hover {
  color: var(--text);
  background: var(--sidebar-hover);
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
  border-radius: 6px;
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
