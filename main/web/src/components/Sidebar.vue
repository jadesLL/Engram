<template>
  <div class="sidebar-inner">
    <header class="sidebar-header">
      <div class="sidebar-titlebar">
        <h2>知识库</h2>
        <div class="sidebar-title-actions">
          <button class="sidebar-new" type="button" title="新建页面" aria-label="新建页面" @click="emit('new-page')">
            <Icon name="plus" :size="16" />
          </button>
          <button class="sidebar-close" type="button" title="关闭侧边栏" aria-label="关闭侧边栏" @click="emit('close')">
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
            title="清除搜索"
            aria-label="清除搜索"
            @click="filter = ''"
          >
            <Icon name="x" :size="12" />
          </button>
        </div>
      </div>
      <span v-if="ingestHint" class="ingest-hint" :title="ingestHint" aria-live="polite">✦ {{ ingestHint }}</span>
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
              type="button"
              :aria-expanded="!collapsed[g.key]"
              :title="collapsed[g.key] ? `展开${g.label}` : `收起${g.label}`"
              @click="toggle(g.key)"
            >
              <span class="sec-name">{{ g.label }}</span>
            </button>
            <div class="sec-actions">
              <label class="sort-control section-sort" :title="`${g.label}排序：${sortLabel(groupSort[g.key])}`">
                <Icon name="sort" :size="12" />
                <select v-model="groupSort[g.key]" :aria-label="`${g.label}排序`">
                  <option value="name-asc">名称 A→Z</option>
                  <option value="name-desc">名称 Z→A</option>
                  <option value="updated-desc">更新时间</option>
                  <option value="created-desc">创建时间</option>
                </select>
              </label>
              <span class="sec-count">{{ filteredPages(g.pages).length }}</span>
            </div>
          </div>
          <div v-show="!collapsed[g.key]" class="sec-body">
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
            />
            <p v-if="!filteredPages(g.pages).length" class="none">
              {{ filter ? '没有匹配页面' : '暂无页面' }}
            </p>
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
            :title="collapsed.files ? '展开原始资料' : '收起原始资料'"
            @click="toggle('files')"
          >
            <span class="sec-name">原始资料</span>
          </button>
          <div class="sec-actions">
            <label class="sort-control section-sort" :title="`原始资料排序：${sortFilesLabel}`">
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
              title="AI 整理全部"
              aria-label="AI 整理全部"
              @click="ingestAll"
            >
              <Icon name="ai" :size="13" />
            </button>
            <button
              class="add-btn"
              type="button"
              title="新建 Markdown 文件"
              aria-label="新建 Markdown 文件"
              @click="createFile"
            >
              <Icon name="file-plus" :size="13" />
            </button>
            <button
              class="add-btn"
              type="button"
              title="上传文件"
              aria-label="上传文件"
              @click="uploadInput?.click()"
            >
              <Icon name="upload" :size="13" />
            </button>
            <span class="sec-count">{{ visibleFiles.length }}</span>
          </div>
        </div>
        <div v-show="!collapsed.files" class="sec-body">
          <div
            v-for="f in sortList(visibleFiles, sortFiles)"
            :key="f.path"
            class="page-row file-row"
            :class="{ active: isActiveFile(f), selected: selected.has('f:' + f.path) }"
            role="button"
            tabindex="0"
            @click="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
            @keydown.enter.self="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
            @keydown.space.self.prevent="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
          >
            <span
              class="check"
              :class="{ visible: selectionMode || selected.has('f:' + f.path), on: selected.has('f:' + f.path) }"
              @click.stop="toggleSelect({ id: 'f:' + f.path })"
            >
              <Icon v-if="selected.has('f:' + f.path)" name="check" :size="11" />
            </span>
            <Icon
              :name="fileIcon(f.ext)"
              :size="16"
              :stroke-width="1.7"
              :class="['file-icon', fileIconClass(f.ext)]"
            />
            <span class="page-title" :title="f.name">{{ f.name }}</span>
            <span class="row-trailing file-trailing">
              <span
                v-if="fileJob(f.path)"
                class="row-status ingest-progress"
                :title="fileJob(f.path).detail || fileJob(f.path).stage"
              >
                {{ fileJob(f.path).stage }} {{ fileJob(f.path).progress }}%
              </span>
              <span
                v-else-if="f.extractionStatus === 'failed'"
                class="row-status ingested-flag failed"
                :title="f.extractionError ? `提取失败：${f.extractionError.slice(0, 200)}` : '提取失败，可重试'"
              >提取失败</span>
              <span
                v-else-if="f.extractionStatus === 'blocked'"
                class="row-status ingested-flag unsupported"
                :title="f.extractionError || '需要配置文档识别模型'"
              >待配置</span>
              <span
                v-else-if="f.extractionStatus === 'partial'"
                class="row-status ingested-flag warning"
                :title="f.extractionError || '部分页面尚未识别'"
              >部分提取</span>
              <span
                v-else-if="f.ingestedAt"
                class="row-status ingested-flag"
                :title="`已于 ${f.ingestedAt.slice(0, 10)} 整理`"
              >已整理</span>
              <span
                v-else-if="f.ingestStatus === 'failed'"
                class="row-status ingested-flag failed"
                :title="f.ingestError ? `整理失败：${f.ingestError.slice(0, 200)}` : '整理失败，可重试'"
              >失败</span>
              <span
                v-else-if="f.extractionStatus === 'completed'"
                class="row-status ingested-flag extracted"
                title="文字已提取，等待或可重新执行 AI 整理"
              >已提取</span>
              <span
                v-else-if="f.ingestSupported === false"
                class="row-status ingested-flag unsupported"
                title="文件已保存，当前格式暂不支持 AI 整理"
              >仅保存</span>
              <span class="row-actions" @click.stop>
                <button
                  v-if="['md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(f.ext)"
                  type="button"
                  title="AI 整理"
                  aria-label="AI 整理"
                  @click="ingestFile(f)"
                >
                  <Icon name="ai" :size="13" />
                </button>
                <button type="button" title="删除" aria-label="删除" @click="removeFile(f)">
                  <Icon name="trash" :size="13" />
                </button>
              </span>
            </span>
          </div>
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
            :title="collapsed.chat ? '展开对话' : '收起对话'"
            @click="toggle('chat')"
          >
            <span class="sec-name">对话</span>
          </button>
          <div class="sec-actions">
            <label class="sort-control section-sort" :title="`对话排序：${sortChatLabel}`">
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
          <div
            v-for="f in sortList(visibleChatFiles, sortChat)"
            :key="f.path"
            class="page-row file-row"
            :class="{ active: isActiveFile(f), selected: selected.has('f:' + f.path) }"
            role="button"
            tabindex="0"
            @click="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
            @keydown.enter.self="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
            @keydown.space.self.prevent="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
          >
            <span
              class="check"
              :class="{ visible: selectionMode || selected.has('f:' + f.path), on: selected.has('f:' + f.path) }"
              @click.stop="toggleSelect({ id: 'f:' + f.path })"
            >
              <Icon v-if="selected.has('f:' + f.path)" name="check" :size="11" />
            </span>
            <Icon
              :name="fileIcon(f.ext)"
              :size="16"
              :stroke-width="1.7"
              :class="['file-icon', fileIconClass(f.ext)]"
            />
            <span class="page-title" :title="f.name">{{ f.name }}</span>
            <span class="row-trailing file-trailing">
              <span
                v-if="fileJob(f.path)"
                class="row-status ingest-progress"
                :title="fileJob(f.path).detail || fileJob(f.path).stage"
              >
                {{ fileJob(f.path).stage }} {{ fileJob(f.path).progress }}%
              </span>
              <span
                v-else-if="f.extractionStatus === 'failed'"
                class="row-status ingested-flag failed"
                :title="f.extractionError ? `提取失败：${f.extractionError.slice(0, 200)}` : '提取失败，可重试'"
              >提取失败</span>
              <span
                v-else-if="f.extractionStatus === 'blocked'"
                class="row-status ingested-flag unsupported"
                :title="f.extractionError || '需要配置文档识别模型'"
              >待配置</span>
              <span
                v-else-if="f.extractionStatus === 'partial'"
                class="row-status ingested-flag warning"
                :title="f.extractionError || '部分页面尚未识别'"
              >部分提取</span>
              <span
                v-else-if="f.ingestedAt"
                class="row-status ingested-flag"
                :title="`已于 ${f.ingestedAt.slice(0, 10)} 整理`"
              >已整理</span>
              <span
                v-else-if="f.ingestStatus === 'failed'"
                class="row-status ingested-flag failed"
                :title="f.ingestError ? `整理失败：${f.ingestError.slice(0, 200)}` : '整理失败，可重试'"
              >失败</span>
              <span
                v-else-if="f.extractionStatus === 'completed'"
                class="row-status ingested-flag extracted"
                title="文字已提取，等待或可重新执行 AI 整理"
              >已提取</span>
              <span
                v-else-if="f.ingestSupported === false"
                class="row-status ingested-flag unsupported"
                title="文件已保存，当前格式暂不支持 AI 整理"
              >仅保存</span>
              <span class="row-actions" @click.stop>
                <button
                  v-if="['md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(f.ext)"
                  type="button"
                  title="AI 整理"
                  aria-label="AI 整理"
                  @click="ingestFile(f)"
                >
                  <Icon name="ai" :size="13" />
                </button>
                <button type="button" title="删除" aria-label="删除" @click="removeFile(f)">
                  <Icon name="trash" :size="13" />
                </button>
              </span>
            </span>
          </div>
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
            :title="collapsed.ailog ? '展开 AI 整理日志' : '收起 AI 整理日志'"
            @click="toggle('ailog')"
          >
            <span class="sec-name">AI 整理日志</span>
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
            <span class="page-title" :title="p.title">{{ p.title }}</span>
          </div>
          <p v-if="!visibleAiLogs.length" class="none">
            {{ filter ? '没有匹配日志' : 'Dream Cycle 运行后自动生成' }}
          </p>
        </div>
      </section>

      <!-- 标签 -->
      <div v-if="tags.length" class="tags-block">
        <div class="side-sub">标签</div>
        <div class="tags">
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
import { useAppStore } from '../stores/app';
import Icon from './Icon.vue';
import PageRow from './PageRow.vue';

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
  if (!confirm(`删除选中的 ${n} 项？（移入回收站）`)) return;
  for (const key of selected.value) {
    if (key.startsWith('p:')) await api.delete(`/api/pages/${key.slice(2)}`);
    else await api.delete('/api/files', { data: { path: key.slice(2) } });
  }
  clearSelection();
  await load();
}

const activeId = computed(() => (route.params.id as string) || '');
const fileQuery = computed(() => (route.query.file as string) || '');

const GROUPS = [
  { key: 'concept', label: '概念' },
  { key: 'entity', label: '实体' },
  { key: 'archived', label: '归档' },
];

function groupOf(p: any): string {
  if (p.path.startsWith('原始资料/')) return 'raw'; // 原始资料只在文件区展示
  if (p.path.startsWith('AIWorks/')) return 'system'; // AI 工作区只在日志区展示
  if (p.path.startsWith('Wiki/归档/')) return 'archived';
  if (p.path.startsWith('Wiki/查询/')) return 'qa';
  if (p.type === 'concept') return 'concept';
  if (['person', 'project', 'org'].includes(p.type)) return 'entity';
  return 'unclassified'; // 未分类页面只在「全部页面」出现
}

const typeGroups = computed(() =>
  GROUPS.map((g) => ({
    ...g,
    pages: allPages.value.filter((p) => groupOf(p) === g.key),
  }))
);

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
    alert(e.response?.data?.error || '创建失败');
  }
}

function fileIcon(ext: string): string {
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['docx', 'doc'].includes(ext)) return 'word';
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  if (['pptx', 'ppt'].includes(ext)) return 'ppt';
  return 'attach';
}

function fileIconClass(ext: string): string {
  return `file-icon-${fileIcon(ext)}`;
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
      alert(`以下文件已存在，未重复导入：\n${data.duplicates.join('\n')}`);
    }
  } catch (err: any) {
    alert(err.response?.data?.error || '上传失败');
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
  if (!confirm(`确定删除「${p.title}」？（移入回收站）`)) return;
  await api.delete(`/api/pages/${p.id}`);
  await load();
  if (p.id === activeId.value) router.push('/page');
}

async function removeFile(f: any) {
  if (!confirm(`确定删除「${f.name}」？（移入回收站）`)) return;
  await api.delete('/api/files', { data: { path: f.path } });
  await load();
}

/** AI 整理单个原始资料：提炼概念/实体页到 Wiki */
async function ingestFile(f: any) {
  await api.post('/api/ai/ingest', { path: f.path, force: true });
  ingestHint.value = `「${f.name}」已加入整理队列`;
  await app.refreshJobs();
}

async function ingestAll() {
  if (!confirm('将按当前规则重新整理全部原始资料，并产生相应的 AI 调用。继续？')) return;
  const { data } = await api.post('/api/ai/ingest-all', { force: true });
  ingestHint.value = data.queued > 0 ? `已加入 ${data.queued} 份资料的整理队列` : '原始资料为空';
  if (data.queued > 0) await app.refreshJobs();
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

.file-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-secondary);
  opacity: 0.76;
}

.file-icon-markdown { color: var(--file-markdown); opacity: 0.94; }
.file-icon-word { color: var(--file-word); opacity: 0.94; }
.file-icon-excel { color: var(--file-excel); opacity: 0.94; }
.file-icon-ppt { color: var(--file-ppt); opacity: 0.94; }
.file-icon-pdf { color: var(--file-pdf); opacity: 0.94; }

.log-file-icon {
  flex-shrink: 0;
  color: var(--text-faint);
}

.row-trailing {
  position: relative;
  width: 76px;
  height: 100%;
  flex-shrink: 0;
}

.row-status {
  position: absolute;
  top: 50%;
  right: 0;
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateY(-50%);
  transition: opacity 150ms ease;
}

.ingested-flag {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--success);
  font-size: 10px;
}

.ingested-flag::before {
  content: '';
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: 50%;
  background: currentColor;
}

.ingested-flag.failed {
  color: var(--danger);
}

.ingested-flag.unsupported {
  color: var(--text-faint);
}

.ingested-flag.warning {
  color: #a36b00;
}

.ingested-flag.extracted {
  color: var(--accent);
}

.ingest-progress {
  padding: 1px 5px;
  border-radius: 6px;
  color: var(--sidebar-accent);
  background: var(--sidebar-selection);
  font-size: 10px;
  line-height: 17px;
  font-variant-numeric: tabular-nums;
}

.row-actions {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  padding-left: 3px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  background: transparent;
  transition: opacity 150ms ease;
}

.page-row:hover .row-actions,
.page-row:focus-within .row-actions {
  opacity: 1;
  pointer-events: auto;
}

.page-row:hover .row-status,
.page-row:focus-within .row-status {
  opacity: 0;
}

.row-actions button {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 5px;
  color: var(--text-faint);
}

.row-actions button:hover,
.row-actions button:focus-visible {
  color: var(--text);
  background: var(--sidebar-active);
  outline: none;
}

.page-row .check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: #fff;
  opacity: 0;
  transition: opacity 150ms ease, background 150ms ease, border-color 150ms ease;
}

.page-row:hover .check,
.page-row:focus-within .check,
.page-row .check.visible {
  opacity: 1;
}

.page-row .check.on {
  border-color: var(--sidebar-accent);
  background: var(--sidebar-accent);
  opacity: 1;
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
  .row-status,
  .row-actions,
  .page-row .check,
  .rise-enter-active,
  .rise-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
