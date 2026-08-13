<template>
  <div class="editor-view">
    <!-- 文件预览模式（docx 等） -->
    <FilePreview
      v-if="filePath"
      ref="filePreviewRef"
      :path="filePath"
      @context-menu="(request) => showContextMenu(request, 'file')"
    />

    <!-- 页面编辑模式 -->
    <template v-else-if="page">
      <ReadingPreview
        v-if="app.readingMode"
        :markdown="content"
        :title="title"
        :page-type="pageType"
        :tags="tags"
        :updated-at="page.updated_at"
        :dark="isDark"
        :related="related"
        @close="closeReading"
        @open-wikilink="openWikilink"
        @open-related="(id: string) => $router.push(`/page/${id}`)"
        @context-menu="(request) => showContextMenu(request, 'reading')"
      />

      <div v-show="!app.readingMode" class="page-head">
        <input v-model="title" class="title-input" placeholder="无标题" @change="save(true)" />
        <div class="head-meta">
          <select v-model="pageType" @change="save(true)" class="ghost-select">
            <option value="concept">概念</option>
            <option value="person">人物</option>
            <option value="project">项目</option>
            <option value="org">组织</option>
            <option v-if="!['concept','person','project','org'].includes(pageType)" :value="pageType">未分类</option>
          </select>
          <input
            v-model="tagsInput"
            class="tags-input"
            placeholder="添加标签，逗号分隔"
            @change="save(true)"
          />
          <span class="save-state faint small">{{ saveState }}</span>
          <button class="ghost-btn" title="AI 整理（摘要/标签/实体）" @click="organize">
            <Icon name="ai" :size="14" /> 整理
          </button>
          <button
            v-if="evidence?.sources?.length"
            class="ghost-btn"
            title="查看本页来源证据"
            @click="evidenceOpen = !evidenceOpen"
          >
            <Icon name="book-open" :size="14" />
            来源 {{ evidence.sources.length }}
          </button>
          <span
            v-if="synthesisPending"
            class="synthesis-inline small"
            title="来源事实已入账，正在生成整页正文"
          >
            <Icon name="activity" :size="13" />
            综合中
          </span>
          <button class="ghost-btn" title="查看本页图谱" @click="$router.push(`/graph/${page.id}`)">
            <Icon name="graph" :size="14" />
          </button>
        </div>
      </div>

      <!-- AI 写作操作条 -->
      <div v-show="!app.readingMode" class="ai-bar">
        <Icon name="ai" :size="13" class="ai-bar-icon" />
        <button v-for="a in aiActions" :key="a.key" class="ai-action" @click="runAi(a.key)">
          {{ a.label }}
        </button>
        <span class="faint small ai-hint">选中文本后使用，未选中则作用于全文</span>
      </div>

      <div v-show="!app.readingMode" class="editor-area">
        <MarkdownEditor
          ref="editorRef"
          v-model="content"
          :dark="isDark"
          :mode="app.editorMode"
          @save="save(true)"
          @open-wikilink="openWikilink"
          @mode-change="(m: 'ir' | 'sv') => app.setEditorMode(m)"
          @enter-reading="enterReading"
          @context-menu="(request) => showContextMenu(request, 'editor')"
        />
      </div>

      <aside v-if="!app.readingMode && evidenceOpen && evidence" class="evidence-drawer">
        <div class="evidence-head">
          <div>
            <h3>来源证据</h3>
            <p class="faint small">
              {{ evidence.sources.length }} 个资料来源 · {{ evidence.facts.length }} 条事实
            </p>
          </div>
          <button class="icon-btn" title="关闭来源证据" @click="evidenceOpen = false">
            <Icon name="x" :size="18" />
          </button>
        </div>

        <div
          v-if="evidence.synthesis"
          class="synthesis-state small"
          :class="{ warning: evidence.synthesis.manualModified || evidence.synthesis.outdated }"
        >
          <Icon :name="evidence.synthesis.manualModified || evidence.synthesis.outdated ? 'activity' : 'check'" :size="15" />
          <span v-if="evidence.synthesis.manualModified">检测到人工修改，下次资料更新将执行三方合并</span>
          <span v-else-if="evidence.synthesis.outdated">新资料正在等待整页综合</span>
          <span v-else>整页综合已通过证据验证</span>
        </div>
        <div v-else class="synthesis-state warning small">
          <Icon name="activity" :size="15" />
          <span>来源事实已入账，正在等待首次整页综合</span>
        </div>

        <div class="evidence-scroll">
          <section
            v-for="(section, sectionIndex) in evidence.evidenceMap?.sections || []"
            :key="`${section.heading}-${sectionIndex}`"
            class="evidence-section"
          >
            <h4>{{ section.heading || '概述' }}</h4>
            <details
              v-for="(claim, claimIndex) in section.claims"
              :key="`${claim.text}-${claimIndex}`"
              class="claim"
            >
              <summary>{{ claim.text }}</summary>
              <div class="claim-facts">
                <div v-for="fact in factsFor(claim.evidenceIds)" :key="fact.id" class="claim-fact">
                  <button class="source-link" @click="openEvidenceSource(fact.sourcePath)">
                    <Icon name="file" :size="13" />
                    {{ sourceLabel(fact.sourcePath) }}
                  </button>
                  <p>{{ fact.statement }}</p>
                  <blockquote v-for="quote in fact.quotes" :key="`${fact.id}-${quote.chunkId}`">
                    {{ quote.quote }}
                  </blockquote>
                </div>
              </div>
            </details>
          </section>

          <section v-if="evidence.evidenceMap?.timeline?.length" class="evidence-section">
            <h4>时间线证据</h4>
            <details
              v-for="item in evidence.evidenceMap.timeline"
              :key="`${item.date}-${item.event}`"
              class="claim"
            >
              <summary>{{ item.date }}：{{ item.event }}</summary>
              <div class="claim-facts">
                <div v-for="fact in factsFor(item.evidenceIds)" :key="fact.id" class="claim-fact">
                  <button class="source-link" @click="openEvidenceSource(fact.sourcePath)">
                    <Icon name="file" :size="13" />
                    {{ sourceLabel(fact.sourcePath) }}
                  </button>
                  <blockquote v-for="quote in fact.quotes" :key="`${fact.id}-${quote.chunkId}`">
                    {{ quote.quote }}
                  </blockquote>
                </div>
              </div>
            </details>
          </section>

          <section class="evidence-section source-index">
            <h4>全部资料</h4>
            <button
              v-for="source in evidence.sources"
              :key="source.path"
              class="source-row"
              @click="openEvidenceSource(source.path)"
            >
              <Icon name="file" :size="15" />
              <span>{{ sourceLabel(source.path) }}</span>
              <small>{{ source.factIds.length }} 条事实</small>
            </button>
          </section>
        </div>
      </aside>

      <!-- 本页关联 -->
      <div v-if="!app.readingMode && related" class="related">
        <div class="related-title faint small">🔗 本页关联（AI 自动生成）</div>
        <div class="related-items">
          <span
            v-for="n in related.neighbors"
            :key="'n' + n.id"
            class="tag rel-item"
            :title="n.direction === 'out' ? '本页引用了它' : '它引用了本页'"
            @click="$router.push(`/page/${n.id}`)"
          >{{ n.direction === 'out' ? '→' : '←' }} {{ n.title }}</span>
          <span
            v-for="s in related.similar"
            :key="'s' + s.id"
            class="tag rel-item"
            :title="`语义相似 ${(1 - s.distance).toFixed(2)}`"
            @click="$router.push(`/page/${s.id}`)"
          >≈ {{ s.title }}</span>
          <span v-for="e in related.entities" :key="'e' + e.name" class="tag entity">{{ e.name }}</span>
        </div>
      </div>
    </template>

    <!-- 欢迎页 -->
    <div v-else class="welcome">
      <div class="welcome-inner">
        <div class="welcome-logo">W</div>
        <h2>欢迎来到 LLM Wiki</h2>
        <p class="muted">写下的每一页都会被 AI 消化：自动索引、自动关联、随问随答。</p>
        <div class="welcome-actions">
          <button class="btn primary" @click="createFirst">新建页面</button>
          <button class="btn" @click="$router.push('/search')">向知识库提问</button>
          <button class="btn" @click="$router.push('/graph')">知识图谱</button>
        </div>
        <p class="faint small">快捷键：Ctrl+K 搜索 · Ctrl+J AI助手 · Ctrl+N 新建</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useAssistantStore } from '../stores/assistant';
import {
  canReadClipboard,
  copyText,
  openContextMenu,
  type ContextMenuItem,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import MarkdownEditor from '../components/MarkdownEditor.vue';
import ReadingPreview from '../components/ReadingPreview.vue';
import FilePreview from '../components/FilePreview.vue';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const assistant = useAssistantStore();

const page = ref<any>(null);
const content = ref('');
const title = ref('');
const pageType = ref('note');
const tagsInput = ref('');
const saveState = ref('');
const related = ref<any>(null);
const evidence = ref<any>(null);
const evidenceOpen = ref(false);
const editorRef = ref<InstanceType<typeof MarkdownEditor>>();
const filePreviewRef = ref<InstanceType<typeof FilePreview>>();

const filePath = computed(() => (route.query.file as string) || '');
const isDark = computed(() => app.dark);
const tags = computed(() =>
  tagsInput.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
);
const synthesisPending = computed(() =>
  Boolean(evidence.value?.sources?.length) &&
  (!evidence.value?.synthesis || evidence.value.synthesis.outdated)
);

type WriterPreset = 'continue' | 'polish' | 'expand' | 'summarize' | 'translate';

const aiActions: { key: WriterPreset; label: string }[] = [
  { key: 'continue', label: '续写' },
  { key: 'polish', label: '润色' },
  { key: 'expand', label: '扩写' },
  { key: 'summarize', label: '总结' },
  { key: 'translate', label: '翻译' },
];

const contextAiActions: Array<{ key: WriterPreset; label: string; icon: string }> = [
  { key: 'summarize', label: '总结', icon: 'sort' },
  { key: 'polish', label: '润色', icon: 'ai' },
  { key: 'expand', label: '扩写', icon: 'plus' },
  { key: 'translate', label: '翻译', icon: 'languages' },
];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let loading = false; // 加载页面时抑制 content watch
let justSavedAt = 0; // 本地刚保存时间戳，抑制 SSE 回声导致的重复重载
let loadedContentKey = '';

function visibleContentKey(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*(?:ingest:|contribution:|synthesis:)[^>]*-->/g, '')
    .replace(/\[(?:managed)?\]\(#ingest-preserved-[A-Za-z0-9_-]+\)/g, '')
    .trim();
}

async function loadPage(id: string) {
  const { data } = await api.get(`/api/pages/${id}`);
  loading = true; // 抑制 watch
  page.value = data.meta;
  content.value = data.content;
  loadedContentKey = visibleContentKey(data.content);
  // 标题为空时回退到文件名（去掉 .md 后缀）
  title.value = data.meta.title || data.meta.path.split('/').pop()?.replace(/\.md$/i, '') || '无标题';
  pageType.value = data.meta.type;
  tagsInput.value = (data.meta.tags || []).join(', ');
  saveState.value = '';
  dirty = false;
  loading = false;
  syncAssistantContext();
  loadRelated();
  loadEvidence();
}

async function loadRelated() {
  if (!page.value) return;
  try {
    const { data } = await api.get(`/api/pages/${page.value.id}/related`);
    related.value = data;
  } catch { /* ignore */ }
}

async function loadEvidence() {
  if (!page.value || !['person', 'project', 'org'].includes(pageType.value)) {
    evidence.value = null;
    evidenceOpen.value = false;
    return;
  }
  try {
    const { data } = await api.get(`/api/pages/${page.value.id}/evidence`);
    evidence.value = data;
  } catch {
    evidence.value = null;
    evidenceOpen.value = false;
  }
}

function factsFor(ids: string[]) {
  const wanted = new Set(ids || []);
  return (evidence.value?.facts || []).filter((fact: any) => wanted.has(fact.id));
}

function sourceLabel(path: string) {
  return path.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') || path;
}

function openEvidenceSource(path: string) {
  const source = (evidence.value?.sources || []).find((item: any) => item.path === path);
  if (source?.pageId) {
    router.push(`/page/${source.pageId}`);
    return;
  }
  router.push({ path: route.path, query: { ...route.query, file: path } });
}

function enterReading() {
  const current = editorRef.value?.getValue();
  if (current !== undefined && current !== content.value) content.value = current;
  evidenceOpen.value = false;
  app.setReadingMode(true);
}

function closeReading() {
  app.setReadingMode(false);
  nextTick(() => editorRef.value?.focus());
}

async function save(manual = false) {
  if (!page.value) return;
  const tags = tagsInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  const contentToSave = editorRef.value?.getValue() ?? content.value;
  const { data } = await api.put(`/api/pages/${page.value.id}`, {
    content: contentToSave,
    title: title.value,
    type: pageType.value,
    tags,
  });
  page.value = data.meta;
  loadedContentKey = visibleContentKey(contentToSave);
  dirty = false;
  justSavedAt = Date.now(); // 抑制本次保存触发的 SSE 回声
  saveState.value = manual ? '已保存 ✓' : '已自动保存';
  app.bumpSidebar(); // 类型/标题变化后立刻刷新侧栏分区
  setTimeout(() => (saveState.value = ''), 2000);
  loadRelated();
  loadEvidence();
  syncAssistantContext();
}

watch(content, () => {
  if (loading || !page.value) return; // 加载阶段不触发
  if (visibleContentKey(content.value) === loadedContentKey) {
    dirty = false;
    saveState.value = '';
    return;
  }
  dirty = true;
  saveState.value = '编辑中…';
  if (saveTimer) clearTimeout(saveTimer);
  const scheduledPageId = page.value.id;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (page.value?.id === scheduledPageId) save();
  }, 2000);
});

async function openWikilink(wikiTitle: string) {
  try {
    const { data } = await api.get(`/api/pages/by-title/${encodeURIComponent(wikiTitle)}`);
    router.push(`/page/${data.id}`);
  } catch {
    if (confirm(`页面「${wikiTitle}」不存在，是否创建？`)) {
      const { data } = await api.post('/api/pages', { dir: '', title: wikiTitle });
      router.push(`/page/${data.meta.id}`);
    }
  }
}

async function runAi(action: WriterPreset) {
  const sel = editorRef.value?.getSelectionText() || '';
  const text = sel || editorRef.value?.getValue() || '';
  if (!text.trim()) return;
  const label = aiActions.find((a) => a.key === action)?.label || action;
  if (dirty) await save(true);
  const context = pageAssistantContext(sel, action, text);
  await assistant.openWith(`请${label}以下${sel ? '选中内容' : '页面内容'}。`, context, true);
}

function fileAssistantContext(
  selection = '',
  preset?: WriterPreset,
  presetText?: string,
) {
  return {
    route: route.fullPath,
    currentFile: filePath.value ? {
      path: filePath.value,
      name: filePath.value.split('/').pop(),
    } : undefined,
    selection: selection || undefined,
    preset,
    presetText,
  };
}

function activeAssistantContext(
  selection = '',
  preset?: WriterPreset,
  presetText?: string,
) {
  return filePath.value
    ? fileAssistantContext(selection, preset, presetText)
    : pageAssistantContext(selection, preset, presetText);
}

async function runSelectionAi(action: WriterPreset, selection: string) {
  const label = aiActions.find((item) => item.key === action)?.label || action;
  if (!selection.trim()) return;
  if (!filePath.value && dirty) await save(true);
  await assistant.openWith(
    `请${label}以下选中内容。`,
    activeAssistantContext(selection, action, selection),
    true,
  );
}

async function askAboutSelection(selection: string) {
  if (!selection.trim()) return;
  if (!filePath.value && dirty) await save(true);
  await assistant.openWith(
    '关于这段选中内容，我想问：',
    activeAssistantContext(selection),
    false,
  );
}

async function askAboutCurrentPage() {
  if (!page.value) return;
  if (dirty) await save(true);
  await assistant.openWith(
    '关于当前页面，我想问：',
    pageAssistantContext(),
    false,
  );
}

async function askAboutCurrentFile() {
  if (!filePath.value) return;
  await assistant.openWith(
    '关于当前文件，我想问：',
    fileAssistantContext(),
    false,
  );
}

function searchSelection(selection: string) {
  router.push({
    path: '/search',
    query: { q: selection.trim().slice(0, 1000) },
  });
}

function selectionBusinessItems(selection: string): ContextMenuItem[] {
  return [
    {
      id: 'search-selection',
      label: '在知识库中搜索',
      icon: 'search',
      separatorBefore: true,
      action: () => searchSelection(selection),
    },
    {
      id: 'ask-selection',
      label: '询问 AI',
      icon: 'ai',
      action: () => askAboutSelection(selection),
    },
    {
      id: 'ai-selection',
      label: 'AI 处理',
      icon: 'ai',
      children: contextAiActions.map((item) => ({
        id: `ai-${item.key}`,
        label: item.label,
        icon: item.icon,
        action: () => runSelectionAi(item.key, selection),
      })),
    },
  ];
}

function pageContextItems(separatorBefore = false): ContextMenuItem[] {
  return [
    {
      id: 'ask-page',
      label: '询问当前页面',
      icon: 'ai',
      separatorBefore,
      action: askAboutCurrentPage,
    },
    {
      id: 'organize-page',
      label: '整理当前页面',
      icon: 'sort',
      action: organize,
    },
    {
      id: 'page-graph',
      label: '查看页面图谱',
      icon: 'graph',
      action: () => page.value && router.push(`/graph/${page.value.id}`),
    },
    {
      id: 'copy-page-link',
      label: '复制页面链接',
      icon: 'link',
      action: () => copyText(window.location.href),
    },
  ];
}

function fileContextItems(): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: 'ask-file',
      label: '询问当前文件',
      icon: 'ai',
      action: askAboutCurrentFile,
    },
    {
      id: 'download-file',
      label: '下载文件',
      icon: 'download',
      action: () => filePreviewRef.value?.downloadFile(),
    },
  ];
  if ((window as any).wikiDesktop || (window as any).__TAURI__) {
    items.push({
      id: 'open-file-external',
      label: '用系统程序打开',
      icon: 'external',
      action: () => filePreviewRef.value?.openExternal(),
    });
  }
  return items;
}

function editorBaseItems(selection: string): ContextMenuItem[] {
  const hasSelection = Boolean(selection);
  const pasteAvailable = canReadClipboard();
  return [
    {
      id: 'editor-undo',
      label: '撤销',
      icon: 'undo',
      shortcut: 'Ctrl+Z',
      action: () => editorRef.value?.undo(),
    },
    {
      id: 'editor-redo',
      label: '重做',
      icon: 'redo',
      shortcut: 'Ctrl+Y',
      action: () => editorRef.value?.redo(),
    },
    {
      id: 'editor-cut',
      label: '剪切',
      icon: 'scissors',
      shortcut: 'Ctrl+X',
      disabled: !hasSelection,
      separatorBefore: true,
      action: () => editorRef.value?.cutSelection(),
    },
    {
      id: 'editor-copy',
      label: '复制',
      icon: 'copy',
      shortcut: 'Ctrl+C',
      disabled: !hasSelection,
      action: () => editorRef.value?.copySelection(),
    },
    {
      id: 'editor-paste',
      label: '粘贴',
      icon: 'clipboard',
      shortcut: pasteAvailable ? 'Ctrl+V' : undefined,
      hint: pasteAvailable ? undefined : '请使用 Ctrl+V',
      disabled: !pasteAvailable,
      action: async () => {
        const pasted = await editorRef.value?.pasteClipboard();
        if (!pasted) alert('浏览器未允许读取剪贴板，请使用 Ctrl+V 粘贴');
      },
    },
    {
      id: 'editor-select-all',
      label: '全选',
      icon: 'select-all',
      shortcut: 'Ctrl+A',
      action: () => editorRef.value?.selectAll(),
    },
  ];
}

function showContextMenu(
  request: SelectionContextMenuRequest,
  source: 'editor' | 'reading' | 'file',
) {
  const selection = request.selection.trim();
  let items: ContextMenuItem[];
  if (source === 'editor') {
    items = editorBaseItems(selection);
    items.push(...(selection ? selectionBusinessItems(selection) : pageContextItems(true)));
  } else if (selection) {
    items = [
      {
        id: `${source}-copy`,
        label: '复制',
        icon: 'copy',
        shortcut: 'Ctrl+C',
        action: () => copyText(selection),
      },
      ...selectionBusinessItems(selection),
    ];
  } else {
    items = source === 'reading' ? pageContextItems() : fileContextItems();
  }
  openContextMenu({ x: request.x, y: request.y, items });
}

async function organize() {
  if (!page.value) return;
  if (dirty) await save(true);
  await assistant.openWith(
    '请整理当前页面，生成摘要并抽取实体关系。先展示将执行的动作，等待我确认后加入后台队列。',
    pageAssistantContext(),
    true
  );
}

function pageAssistantContext(
  selection = '',
  preset?: WriterPreset,
  presetText?: string
) {
  return {
    route: route.fullPath,
    currentPage: page.value ? {
      id: page.value.id,
      title: title.value,
      path: page.value.path,
      updatedAt: page.value.updated_at,
    } : undefined,
    selection: selection || undefined,
    preset,
    presetText,
  };
}

function syncAssistantContext() {
  if (filePath.value) {
    assistant.setContext({
      route: route.fullPath,
      currentFile: { path: filePath.value, name: filePath.value.split('/').pop() },
    });
  } else if (page.value) {
    assistant.setContext(pageAssistantContext());
  } else {
    assistant.clearContext();
  }
}

async function createFirst() {
  const { data } = await api.post('/api/pages', { dir: '', title: '欢迎使用 LLM Wiki' });
  router.push(`/page/${data.meta.id}`);
}

watch(
  () => route.params.id,
  (id, oldId) => {
    // 不置空 page（避免销毁 MarkdownEditor 丢失编辑模式/阅读状态）；
    // 只清关联数据，直接加载新页面。编辑器组件保持存活，内容由 watch(props.modelValue) 更新。
    related.value = null;
    evidence.value = null;
    evidenceOpen.value = false;
    if (id && id !== oldId) loadPage(id as string);
    else if (!id) {
      page.value = null; // 无 id 才回欢迎页
      syncAssistantContext();
    }
  }
);

watch(filePath, syncAssistantContext);

// 服务端 SSE 推送：当前页内容被任意来源（本会话/Dream/MCP/多标签）改动时即时重载
watch(
  () => app.pageVersion,
  () => {
    const ev = app.lastPageEvent;
    if (!page.value || !ev) return;
    const myPath = page.value.path;
    // 只在当前页内容变化或被移动时重载；删除不重载（避免 404，侧栏已处理树）
    const matchChanged = ev.type === 'page-changed' && ev.path === myPath;
    const matchMoved = ev.type === 'page-moved' && (ev.oldPath === myPath || ev.newPath === myPath);
    if (!matchChanged && !matchMoved) return;
    if (dirty) return; // 用户正在编辑，不覆盖未保存内容
    if (Date.now() - justSavedAt < 1500) return; // 自己刚保存的回声，忽略
    loadPage(page.value.id).catch(() => {});
  }
);

function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty) e.preventDefault();
}

onMounted(() => {
  if (route.params.id) loadPage(route.params.id as string);
  window.addEventListener('beforeunload', beforeUnload);
});
onUnmounted(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  if (saveTimer) clearTimeout(saveTimer);
  assistant.clearContext();
});
</script>

<style scoped>
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  /* 宽幅：占满主内容区，仅靠 padding 留呼吸空间（Typora/Obsidian 全屏式） */
  --editor-max: 100%;
}
.page-head {
  max-width: var(--editor-max);
  margin: 0 auto;
  width: 100%;
  padding: 36px 48px 0;
}
.title-input {
  width: 100%;
  border: none;
  font-size: 34px;
  font-weight: 700;
  padding: 4px 0;
  background: transparent;
}
.title-input::placeholder { color: var(--text-faint); }
.head-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  padding-bottom: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
}
.ghost-select {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 3px 4px;
}
.ghost-select:hover { background: var(--bg-hover); }
.tags-input {
  flex: 1;
  min-width: 140px;
  border: none;
  background: transparent;
  padding: 3px 4px;
  font-size: 13px;
  color: var(--text-secondary);
}
.tags-input:hover { background: var(--bg-hover); }
.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: 5px;
}
.ghost-btn:hover { background: var(--bg-hover); color: var(--text); }
.synthesis-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--warning, #b45309);
  white-space: nowrap;
}
.ai-bar {
  max-width: var(--editor-max);
  margin: 0 auto;
  width: 100%;
  padding: 6px 48px;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.ai-bar-icon { color: var(--text-faint); margin-right: 2px; }
.ai-action {
  font-size: 12px;
  color: var(--text-faint);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  transition: all 0.12s;
}
.ai-action:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.ai-hint { margin-left: auto; }
.editor-area { flex: 1; min-height: 0; }
.editor-area :deep(.vditor) {
  max-width: var(--editor-max);
  width: 100% !important;
  margin: 0 !important;
}
.editor-area :deep(.vditor-toolbar) { max-width: 100%; }

/* 排版精修（Typora/Obsidian 风可读宽行，三种编辑模式统一） */
.editor-area :deep(.vditor-ir),
.editor-area :deep(.vditor-wysiwyg),
.editor-area :deep(.vditor-sv) {
  font-size: 16px;
  line-height: 1.8;
  color: var(--text);
}
.editor-area :deep(.vditor-ir h1),
.editor-area :deep(.vditor-ir h2),
.editor-area :deep(.vditor-ir h3),
.editor-area :deep(.vditor-ir h4),
.editor-area :deep(.vditor-ir h5),
.editor-area :deep(.vditor-ir h6),
.editor-area :deep(.vditor-wysiwyg h1),
.editor-area :deep(.vditor-wysiwyg h2),
.editor-area :deep(.vditor-wysiwyg h3),
.editor-area :deep(.vditor-wysiwyg h4),
.editor-area :deep(.vditor-wysiwyg h5),
.editor-area :deep(.vditor-wysiwyg h6),
.editor-area :deep(.vditor-sv h1),
.editor-area :deep(.vditor-sv h2),
.editor-area :deep(.vditor-sv h3),
.editor-area :deep(.vditor-sv h4),
.editor-area :deep(.vditor-sv h5),
.editor-area :deep(.vditor-sv h6) {
  font-weight: 700;
  line-height: 1.3;
  margin: 1.6em 0 0.6em;
}
.editor-area :deep(.vditor-ir h1),
.editor-area :deep(.vditor-wysiwyg h1),
.editor-area :deep(.vditor-sv h1) { font-size: 1.9em; margin-top: 0.2em; }
.editor-area :deep(.vditor-ir h2),
.editor-area :deep(.vditor-wysiwyg h2),
.editor-area :deep(.vditor-sv h2) { font-size: 1.5em; font-weight: 650; }
.editor-area :deep(.vditor-ir h3),
.editor-area :deep(.vditor-wysiwyg h3),
.editor-area :deep(.vditor-sv h3) { font-size: 1.25em; font-weight: 600; }
.editor-area :deep(.vditor-ir h4),
.editor-area :deep(.vditor-wysiwyg h4),
.editor-area :deep(.vditor-sv h4) { font-size: 1.05em; font-weight: 600; }
.editor-area :deep(.vditor-ir h5),
.editor-area :deep(.vditor-ir h6),
.editor-area :deep(.vditor-wysiwyg h5),
.editor-area :deep(.vditor-wysiwyg h6),
.editor-area :deep(.vditor-sv h5),
.editor-area :deep(.vditor-sv h6) { font-size: 0.95em; color: var(--text-secondary); }
.editor-area :deep(.vditor-ir p),
.editor-area :deep(.vditor-wysiwyg p),
.editor-area :deep(.vditor-sv p) { margin: 0.75em 0; }
.editor-area :deep(.vditor-ir a),
.editor-area :deep(.vditor-wysiwyg a),
.editor-area :deep(.vditor-sv a) { color: var(--accent); }
.editor-area :deep(.vditor-ir a:hover),
.editor-area :deep(.vditor-wysiwyg a:hover),
.editor-area :deep(.vditor-sv a:hover) { text-decoration: underline; text-underline-offset: 2px; }
.editor-area :deep(.vditor-ir blockquote),
.editor-area :deep(.vditor-wysiwyg blockquote),
.editor-area :deep(.vditor-sv blockquote) {
  margin: 0.9em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-secondary);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
}
.editor-area :deep(.vditor-ir blockquote p),
.editor-area :deep(.vditor-wysiwyg blockquote p),
.editor-area :deep(.vditor-sv blockquote p) { margin: 0.3em 0; }
.editor-area :deep(.vditor-ir code),
.editor-area :deep(.vditor-wysiwyg code),
.editor-area :deep(.vditor-sv code) {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.88em;
  padding: 0.15em 0.4em;
  border-radius: 4px;
  background: var(--bg-tertiary);
}
.editor-area :deep(.vditor-ir pre),
.editor-area :deep(.vditor-wysiwyg pre),
.editor-area :deep(.vditor-sv pre) {
  margin: 0.9em 0;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-x: auto;
}
.editor-area :deep(.vditor-ir pre code),
.editor-area :deep(.vditor-wysiwyg pre code),
.editor-area :deep(.vditor-sv pre code) {
  padding: 0;
  background: transparent;
  font-size: 0.86em;
  line-height: 1.6;
}
.editor-area :deep(.vditor-ir table),
.editor-area :deep(.vditor-wysiwyg table),
.editor-area :deep(.vditor-sv table) {
  border-collapse: collapse;
  margin: 0.9em 0;
  width: 100%;
  font-size: 0.92em;
}
.editor-area :deep(.vditor-ir th),
.editor-area :deep(.vditor-ir td),
.editor-area :deep(.vditor-wysiwyg th),
.editor-area :deep(.vditor-wysiwyg td),
.editor-area :deep(.vditor-sv th),
.editor-area :deep(.vditor-sv td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.editor-area :deep(.vditor-ir th),
.editor-area :deep(.vditor-wysiwyg th),
.editor-area :deep(.vditor-sv th) { background: var(--bg-tertiary); font-weight: 600; }
.editor-area :deep(.vditor-ir ul),
.editor-area :deep(.vditor-ir ol),
.editor-area :deep(.vditor-wysiwyg ul),
.editor-area :deep(.vditor-wysiwyg ol),
.editor-area :deep(.vditor-sv ul),
.editor-area :deep(.vditor-sv ol) { margin: 0.6em 0; padding-left: 1.6em; }
.editor-area :deep(.vditor-ir li),
.editor-area :deep(.vditor-wysiwyg li),
.editor-area :deep(.vditor-sv li) { margin: 0.25em 0; }
.editor-area :deep(.vditor-ir hr),
.editor-area :deep(.vditor-wysiwyg hr),
.editor-area :deep(.vditor-sv hr) { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }
.editor-area :deep(.vditor-ir img),
.editor-area :deep(.vditor-wysiwyg img),
.editor-area :deep(.vditor-sv img) { max-width: 100%; border-radius: var(--radius); }

.evidence-drawer {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: 30;
  width: min(390px, 100%);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 28px rgba(0, 0, 0, 0.1);
}
.evidence-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.evidence-head h3 { margin: 0 0 3px; font-size: 17px; }
.evidence-head p { margin: 0; }
.synthesis-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}
.synthesis-state.warning { color: var(--warning, #b45309); }
.evidence-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 20px 28px;
}
.evidence-section {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.evidence-section:last-child { border-bottom: 0; }
.evidence-section h4 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
}
.claim { padding: 8px 0; }
.claim + .claim { border-top: 1px dashed var(--border); }
.claim summary {
  cursor: pointer;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
}
.claim-facts { padding: 8px 0 2px 14px; }
.claim-fact + .claim-fact { margin-top: 12px; }
.claim-fact p {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.claim-fact blockquote {
  margin: 6px 0;
  padding: 6px 9px;
  border-left: 2px solid var(--border);
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.55;
}
.source-link,
.source-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  color: var(--accent);
  font-size: 12px;
  text-align: left;
}
.source-link:hover { text-decoration: underline; }
.source-index { display: flex; flex-direction: column; gap: 2px; }
.source-row {
  padding: 7px 6px;
  border-radius: 5px;
  color: var(--text-secondary);
}
.source-row:hover { background: var(--bg-hover); color: var(--text); }
.source-row span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-row small { color: var(--text-faint); }

.related {
  max-width: var(--editor-max);
  margin: 0 auto;
  width: 100%;
  padding: 10px 48px 24px;
  border-top: 1px dashed var(--border);
}
.related-title { margin-bottom: 6px; }
.related-items { display: flex; flex-wrap: wrap; gap: 6px; }
.rel-item { cursor: pointer; }
.rel-item:hover { background: var(--bg-active); }
.entity { background: var(--accent-soft); color: var(--accent); }

.welcome {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-inner { text-align: center; max-width: 420px; }
.welcome-logo {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
  border-radius: 14px;
  background: var(--text);
  color: var(--bg);
  font-size: 28px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-inner h2 { font-weight: 600; }
.welcome-actions { display: flex; gap: 10px; justify-content: center; margin: 20px 0; flex-wrap: wrap; }

@media (max-width: 768px) {
  .page-head, .ai-bar, .related { padding-left: 20px; padding-right: 20px; }
  .page-head { padding-top: 20px; }
  .title-input { font-size: 26px; }
  .ai-hint { display: none; }
  .evidence-drawer { width: 100%; border-left: 0; }
}
</style>
