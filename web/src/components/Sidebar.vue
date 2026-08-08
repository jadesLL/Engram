<template>
  <div class="sidebar-inner" :class="'style-' + app.sidebarStyle">
    <div class="side-search">
      <input v-model="filter" placeholder="搜索页面…" />
      <div class="side-toolbar">
        <span class="ingest-hint" v-if="ingestHint">✦ {{ ingestHint }}</span>
        <select v-model="sortWiki" class="sort-select" title="Wiki 页面排序（概念/实体/归档）">
          <option value="name-asc">名称 A→Z</option>
          <option value="name-desc">名称 Z→A</option>
          <option value="updated-desc">更新时间</option>
          <option value="created-desc">创建时间</option>
        </select>
      </div>
    </div>

    <div class="side-scroll">
      <!-- 类型分区 -->
      <div v-for="g in typeGroups" :key="g.key" class="section">
        <div class="sec-row" @click="toggle(g.key)">
          <span class="g-dot" :style="{ background: g.color }"></span>
          <span class="caret">{{ collapsed[g.key] ? '▸' : '▾' }}</span>
          <span class="sec-name">{{ g.label }}</span>
          <span class="sec-count">{{ g.pages.length }}</span>
        </div>
        <div v-show="!collapsed[g.key]" class="sec-body">
          <PageRow
            v-for="p in sortList(filtered(g.pages), sortWiki)"
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
          <p v-if="!filtered(g.pages).length" class="faint small none">无</p>
        </div>
      </div>

      <div class="divider" />

      <!-- 原始资料：进料口。上传/新建；AI 整理提炼到 Wiki -->
      <div class="section">
        <div class="sec-row" @click="toggle('files')">
          <span class="g-dot" style="background:#007aff"></span>
          <span class="caret">{{ collapsed.files ? '▸' : '▾' }}</span>
          <span class="sec-name">原始资料</span>
          <button class="add-btn" title="AI 整理全部（提炼概念/实体到 Wiki）" @click.stop="ingestAll">
            <Icon name="ai" :size="13" />
          </button>
          <button class="add-btn" title="新建 md 文件" @click.stop="createFile">
            <Icon name="file-plus" :size="13" />
          </button>
          <button class="add-btn" title="上传文件" @click.stop="uploadInput?.click()">
            <Icon name="upload" :size="13" />
          </button>
          <span class="sec-count">{{ files.length }}</span>
        </div>
        <div v-show="!collapsed.files" class="sec-body">
          <div class="sub-toolbar">
            <select v-model="sortFiles" class="sort-select" title="原始资料排序">
              <option value="name-asc">名称 A→Z</option>
              <option value="name-desc">名称 Z→A</option>
              <option value="updated-desc">更新时间</option>
              <option value="created-desc">创建时间</option>
            </select>
          </div>
          <div
            v-for="f in sortList(files, sortFiles)"
            :key="f.path"
            class="page-row file-row"
            :class="{ active: fileQuery === f.path, selected: selected.has('f:' + f.path) }"
            @click="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
          >
            <span
              class="check"
              :class="{ visible: selectionMode || selected.has('f:' + f.path), on: selected.has('f:' + f.path) }"
              @click.stop="toggleSelect({ id: 'f:' + f.path })"
            >
              <Icon v-if="selected.has('f:' + f.path)" name="check" :size="11" />
            </span>
            <Icon :name="fileIcon(f.ext)" :size="13" class="file-icon" />
            <span class="page-title" :title="f.name">{{ f.name }}</span>
            <span v-if="fileJob(f.path)" class="ingest-progress" :title="fileJob(f.path).detail || fileJob(f.path).stage">
              {{ fileJob(f.path).stage }} {{ fileJob(f.path).progress }}%
            </span>
            <span v-else-if="f.ingestedAt" class="ingested-flag" :title="`已于 ${f.ingestedAt.slice(0, 10)} 整理`">已整理</span>
            <span v-else-if="f.ingestStatus === 'failed'" class="ingested-flag failed" :title="f.ingestError ? `整理失败：${f.ingestError.slice(0, 200)}` : '整理失败，可重试'">整理失败</span>
            <span class="row-actions" @click.stop>
              <button
                v-if="['md', 'markdown', 'docx', 'xlsx', 'pptx'].includes(f.ext)"
                title="AI 整理（提炼概念/实体到 Wiki）"
                @click="ingestFile(f)"
              >
                <Icon name="ai" :size="13" />
              </button>
              <button title="删除" @click="removeFile(f)"><Icon name="trash" :size="13" /></button>
            </span>
          </div>
          <p v-if="!files.length" class="faint small none">空，点 ＋ 上传</p>
        </div>
        <input ref="uploadInput" type="file" multiple hidden @change="onUpload" />
      </div>

      <!-- 对话：外置 Agent 沉积的对话文件（原始资料/对话/），与原始资料同构：实时刷新 + 整理状态 -->
      <div class="section">
        <div class="sec-row" @click="toggle('chat')">
          <span class="g-dot" style="background:#5ac8fa"></span>
          <span class="caret">{{ collapsed.chat ? '▸' : '▾' }}</span>
          <span class="sec-name">对话</span>
          <span class="sec-count">{{ chatFiles.length }}</span>
        </div>
        <div v-show="!collapsed.chat" class="sec-body">
          <div
            v-for="f in sortList(chatFiles, sortFiles)"
            :key="f.path"
            class="page-row file-row"
            :class="{ active: fileQuery === f.path, selected: selected.has('f:' + f.path) }"
            @click="selectionMode ? toggleSelect({ id: 'f:' + f.path }) : openFile(f)"
          >
            <span
              class="check"
              :class="{ visible: selectionMode || selected.has('f:' + f.path), on: selected.has('f:' + f.path) }"
              @click.stop="toggleSelect({ id: 'f:' + f.path })"
            >
              <Icon v-if="selected.has('f:' + f.path)" name="check" :size="11" />
            </span>
            <Icon :name="fileIcon(f.ext)" :size="13" class="file-icon" />
            <span class="page-title" :title="f.name">{{ f.name }}</span>
            <span v-if="fileJob(f.path)" class="ingest-progress" :title="fileJob(f.path).detail || fileJob(f.path).stage">
              {{ fileJob(f.path).stage }} {{ fileJob(f.path).progress }}%
            </span>
            <span v-else-if="f.ingestedAt" class="ingested-flag" :title="`已于 ${f.ingestedAt.slice(0, 10)} 整理`">已整理</span>
            <span v-else-if="f.ingestStatus === 'failed'" class="ingested-flag failed" :title="f.ingestError ? `整理失败：${f.ingestError.slice(0, 200)}` : '整理失败，可重试'">整理失败</span>
            <span class="row-actions" @click.stop>
              <button
                v-if="['md', 'markdown', 'docx', 'xlsx', 'pptx'].includes(f.ext)"
                title="AI 整理（提炼概念/实体到 Wiki）"
                @click="ingestFile(f)"
              >
                <Icon name="ai" :size="13" />
              </button>
              <button title="删除" @click="removeFile(f)"><Icon name="trash" :size="13" /></button>
            </span>
          </div>
          <p v-if="!chatFiles.length" class="faint small none">空（Agent 经 save_chat 写入后在此实时显示）</p>
        </div>
      </div>

      <div class="divider" />

      <!-- AI 整理日志（只读） -->
      <div class="section">
        <div class="sec-row" @click="toggle('ailog')">
          <span class="g-dot" style="background:#ff375f"></span>
          <span class="caret">{{ collapsed.ailog ? '▸' : '▾' }}</span>
          <span class="sec-name">AI 整理日志</span>
          <span class="sec-count">{{ aiLogs.length }}</span>
        </div>
        <div v-show="!collapsed.ailog" class="sec-body">
          <div
            v-for="p in sortList(aiLogs, 'updated-desc')"
            :key="p.id"
            class="page-row"
            :class="{ active: p.id === activeId }"
            @click="openPage(p)"
          >
            <span class="page-title" :title="p.title">{{ p.title }}</span>
          </div>
          <p v-if="!aiLogs.length" class="faint small none">Dream Cycle 运行后自动生成</p>
        </div>
      </div>

      <!-- 标签 -->
      <div v-if="tags.length" class="tags-block">
        <div class="side-sub">标签</div>
        <div class="tags">
          <span v-for="t in tags" :key="t.name" class="tag" @click="searchTag(t.name)">
            #{{ t.name }} {{ t.count }}
          </span>
        </div>
      </div>
    </div>

    <!-- 多选操作栏 -->
    <transition name="rise">
      <div v-if="selected.size" class="batch-bar">
        <span class="batch-count">已选 {{ selected.size }} 项</span>
        <button class="batch-btn" @click="batchArchive">归档</button>
        <button class="batch-btn danger" @click="batchDelete">删除</button>
        <button class="batch-btn faint-btn" @click="clearSelection">取消</button>
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

const allPages = ref<any[]>([]);
const files = ref<any[]>([]);
const tags = ref<{ name: string; count: number }[]>([]);
const filter = ref('');
/** 两个可调排序（各自持久化）：Wiki 页面（概念/实体/归档）共用一种，原始资料独立一种；AI 整理日志固定时间降序 */
const sortWiki = ref(localStorage.getItem('sortWiki') || 'name-asc');
const sortFiles = ref(localStorage.getItem('sortFiles') || 'name-asc');
const uploadInput = ref<HTMLInputElement>();
const collapsed = ref<Record<string, boolean>>({
  concept: true,
  entity: true,
  archived: true,
  files: true,
  chat: true,
  ailog: true,
});
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
  { key: 'concept', label: '概念', color: '#34c759' },
  { key: 'entity', label: '实体', color: '#ff9500' },
  { key: 'archived', label: '归档', color: '#8e8e93' },
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

function filtered(pages: any[]) {
  if (!filter.value.trim()) return pages;
  const f = filter.value.trim().toLowerCase();
  return allPages.value.filter(
    (p) =>
      !p.path.startsWith('原始资料/') &&
      !p.path.startsWith('AIWorks/') &&
      (p.title.toLowerCase().includes(f) ||
        (p.tags || []).some((t: string) => t.toLowerCase().includes(f)))
  );
}

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

watch([sortWiki, sortFiles], () => {
  localStorage.setItem('sortWiki', sortWiki.value);
  localStorage.setItem('sortFiles', sortFiles.value);
});

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
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['docx', 'doc'].includes(ext)) return 'word';
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  if (['pptx', 'ppt'].includes(ext)) return 'ppt';
  return 'attach';
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
  await api.post('/api/ai/ingest', { path: f.path });
  ingestHint.value = `「${f.name}」已加入整理队列`;
  await app.refreshJobs();
}

async function ingestAll() {
  const { data } = await api.post('/api/ai/ingest-all');
  ingestHint.value = data.queued > 0 ? `已加入 ${data.queued} 份资料的整理队列` : '原始资料为空';
  if (data.queued > 0) await app.refreshJobs();
}

function searchTag(tag: string) {
  router.push({ path: '/search', query: { q: `#${tag}` } });
}

defineExpose({ load });
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
/* ===== 基础（三主题共享） ===== */
.sidebar-inner { display: flex; flex-direction: column; height: 100%; }
.side-search { padding: 10px 10px 6px; }
.side-search input { width: 100%; border: none; background: var(--bg-tertiary); font-size: 13px; padding: 6px 10px; }
.ingest-hint { margin: 0; font-size: 12px; color: var(--accent); flex: 1; }
.side-toolbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.sort-select {
  margin-left: auto; border: none; background: transparent; font-size: 11px;
  color: var(--text-faint); cursor: pointer; outline: none;
}
.sort-select:hover { color: var(--text-secondary); }
.sub-toolbar { display: flex; align-items: center; gap: 6px; padding: 0 2px 4px; }
.sub-toolbar .sort-select { margin-left: 0; }
.side-scroll { flex: 1; overflow-y: auto; padding: 0 6px 12px; }
.sec-row { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.caret { width: 12px; font-size: 10px; color: var(--text-faint); text-align: center; }
.g-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; display: none; }
.sec-name { flex: 1; }
.sec-count { font-size: 11px; color: var(--text-faint); }
.add-btn { display: flex; padding: 2px; border-radius: 4px; color: var(--text-faint); }
.add-btn:hover { background: var(--bg-active); color: var(--text); }
.page-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; border-radius: 6px; cursor: pointer; font-size: 13.5px; position: relative; }
.page-row:hover { background: var(--bg-hover); }
.page-row.active { background: var(--bg-active); font-weight: 500; }
.page-row.selected { background: var(--accent-soft); }
.page-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-icon { color: var(--text-faint); flex-shrink: 0; }
.ingested-flag { font-size: 10px; color: var(--success); border: 1px solid var(--success); border-radius: 8px; padding: 0 5px; flex-shrink: 0; opacity: 0.85; }
.ingested-flag.failed { color: var(--danger); border-color: var(--danger); }
.ingest-progress { font-size: 10px; color: var(--accent); background: var(--accent-soft); border-radius: 8px; padding: 1px 5px; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-actions { display: none; gap: 2px; flex-shrink: 0; }
.page-row:hover .row-actions { display: flex; }
.row-actions button { display: flex; padding: 2px 3px; border-radius: 4px; color: var(--text-faint); }
.row-actions button:hover { background: var(--bg-active); color: var(--text); }
.page-time { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
.page-row:hover .page-time { display: none; }
.page-row .check { width: 14px; height: 14px; flex-shrink: 0; border: 1px solid var(--border-strong); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #fff; opacity: 0; }
.page-row:hover .check, .page-row .check.visible { opacity: 1; }
.page-row .check.on { background: var(--accent); border-color: var(--accent); opacity: 1; }
.none { padding: 2px 22px; margin: 2px 0; }
.divider { height: 1px; background: var(--border); margin: 8px 6px; }
.tags-block { padding: 8px 4px 4px; }
.side-sub { font-size: 11px; color: var(--text-faint); padding: 0 6px 6px; letter-spacing: 0.03em; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 4px; }
.tags .tag { cursor: pointer; }
.tags .tag:hover { background: var(--bg-active); }
.batch-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); background: var(--bg-secondary); }
.batch-count { font-size: 12px; color: var(--text-secondary); flex: 1; }
.batch-btn { font-size: 12px; padding: 4px 10px; border-radius: 6px; background: var(--bg-tertiary); }
.batch-btn:hover { background: var(--bg-active); }
.batch-btn.danger { color: var(--danger); }
.faint-btn { color: var(--text-faint); }
.rise-enter-active, .rise-leave-active { transition: transform 0.15s, opacity 0.15s; }
.rise-enter-from, .rise-leave-to { transform: translateY(8px); opacity: 0; }

/* ===== 方案 A · macOS 分层列表 ===== */
.style-a .side-scroll { padding: 0 8px 12px; }
.style-a .sec-row { padding: 5px 8px; border-radius: 8px; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--text-faint); letter-spacing: 0.02em; }
.style-a .sec-row:hover { background: var(--bg-hover); }
.style-a .sec-count { background: var(--bg-tertiary); border-radius: 9px; padding: 1px 7px; font-weight: 400; }
.style-a .page-row { padding: 5px 8px 5px 20px; border-radius: 8px; }
.style-a .divider { margin: 10px 8px; }

/* ===== 方案 B · iOS 卡片 ===== */
.style-b .side-scroll { padding: 4px 10px 12px; }
.style-b .section { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 4px 6px; margin-top: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
.style-b .sec-row { padding: 6px 8px; font-size: 13px; font-weight: 600; color: var(--text); }
.style-b .g-dot { display: block; width: 9px; height: 9px; margin-right: 2px; }
.style-b .caret { display: none; }
.style-b .sec-count { background: #ff3b30; color: #fff; border-radius: 9px; min-width: 18px; text-align: center; padding: 1px 5px; font-size: 11px; font-weight: 600; }
.style-b .divider { display: none; }
.style-b .page-row { padding: 6px 8px 6px 20px; border-radius: 8px; }
.style-b .tags-block { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; margin-top: 10px; padding: 10px; }

/* ===== 方案 C · 极简文字 ===== */
.style-c .side-search input { background: transparent; border: none; border-bottom: 1px solid var(--border); border-radius: 0; padding-left: 4px; }
.style-c .side-search input:focus { border-bottom-color: var(--accent); }
.style-c .side-scroll { padding: 0 12px 12px; }
.style-c .sec-row { padding: 10px 4px 3px; font-size: 12px; font-weight: 600; color: var(--text-faint); border-radius: 0; letter-spacing: 0.04em; }
.style-c .sec-row:hover { background: none; color: var(--text-secondary); }
.style-c .caret, .style-c .g-dot { display: none; }
.style-c .sec-count { font-weight: 400; }
.style-c .add-btn:hover { background: none; color: var(--text); }
.style-c .page-row { padding: 4px; border-radius: 0; font-size: 13.5px; }
.style-c .page-row:hover { background: none; }
.style-c .page-row:hover .page-title { text-decoration: underline; text-underline-offset: 3px; }
.style-c .page-row.active { background: none; }
.style-c .page-row.active .page-title { font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.style-c .page-row.selected { background: var(--accent-soft); border-radius: 4px; }
.style-c .divider { margin: 10px 4px; }
.style-c .page-row .check { margin-left: 0; }
.style-c .none { padding-left: 4px; }
</style>
