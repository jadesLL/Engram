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

      <!-- 顶部条：目录面包屑 + 常驻保存状态 -->
      <div v-show="!app.readingMode" class="editor-topbar">
        <nav class="crumb">
          <Icon name="folder" :size="13" />
          <template v-if="crumbDirs.length">
            <span v-for="(d, i) in crumbDirs" :key="i" class="crumb-item">
              {{ d }}<span v-if="i < crumbDirs.length - 1" class="crumb-sep">/</span>
            </span>
          </template>
          <span v-else class="crumb-item">根目录</span>
        </nav>
        <div class="spacer"></div>
        <span v-if="saveState" class="save-pill" :class="savePillClass">
          <span class="dot"></span>{{ saveState }}
        </span>
      </div>

      <div v-show="!app.readingMode" class="page-head" :class="{ 'chrome-collapsed': chromeCollapsed }">
        <input v-model="title" class="title-input" placeholder="无标题" @change="save(true)" />
        <!-- 手机端摘要行：折叠时仅此一行（选项切换），桌面隐藏 -->
        <div class="head-summary">
          <button
            type="button"
            class="chrome-toggle"
            :aria-expanded="!chromeCollapsed"
            @click="toggleChrome"
          >
            <Icon name="settings" :size="13" />
            页面选项与 AI 工具
            <Icon :name="chromeCollapsed ? 'chevron-down' : 'chevron-up'" :size="13" />
          </button>
        </div>
        <div class="page-chrome">
          <div class="head-meta">
          <select v-model="pageType" @change="save(true)" class="chip-select">
            <option value="concept">概念</option>
            <option value="person">人物</option>
            <option value="customer">客户</option>
            <option value="org">组织</option>
            <option value="project">项目</option>
            <option value="other">其他</option>
            <option v-if="!['concept','person','customer','org','project','other'].includes(pageType)" :value="pageType">未分类</option>
          </select>
          <div class="tags-chips">
            <span v-for="(t, i) in tags" :key="t" class="chip">
              #{{ t }}
              <button type="button" class="chip-x" aria-label="移除标签" @click="removeTag(i)">×</button>
            </span>
            <input
              v-model="tagDraft"
              class="tag-draft"
              placeholder="+ 标签"
              @keydown.enter.prevent="commitTagDraft"
              @keydown="onTagDraftKey"
              @blur="commitTagDraft"
            />
          </div>
          <span class="meta-date faint">更新于 {{ formatDate(page.updated_at) }}</span>
          </div>
        </div>
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
          <button class="btn icon" v-tooltip="'关闭来源证据'" aria-label="关闭来源证据" @click="evidenceOpen = false">
            <Icon name="x" :size="18" />
          </button>
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

      <!-- 本页关联：默认折叠为一行摘要；与正文同一内容列，不再需要 JS 实测对齐 -->
      <div v-if="!app.readingMode && related" class="related" :class="{ collapsed: relatedCollapsed }">
        <div class="related-inner">
          <button
            type="button"
            class="related-title related-toggle"
            :aria-expanded="!relatedCollapsed"
            @click="toggleRelated"
          >
            本页关联<span class="related-count">{{ relatedCount }}</span>
            <Icon class="related-chev" :name="relatedCollapsed ? 'chevron-down' : 'chevron-up'" :size="13" />
          </button>
          <div class="related-items">
            <span
              v-for="(n, i) in related.neighbors"
              :key="'n' + n.id + '-' + n.rel + '-' + i"
              class="rel-item"
              v-tooltip="n.direction === 'out' ? '本页引用了它' : '它引用了本页'"
              @click="$router.push(`/page/${n.id}`)"
            >{{ n.direction === 'out' ? '→' : '←' }} {{ n.title }}</span>
            <span
              v-for="(s, i) in related.similar"
              :key="'s' + s.id + '-' + i"
              class="rel-item"
              v-tooltip="`语义相似 ${(1 - s.distance).toFixed(2)}`"
              @click="$router.push(`/page/${s.id}`)"
            >≈ {{ s.title }}</span>
            <span
              v-for="(e, i) in related.entities"
              :key="'e' + e.name + '-' + e.rel + '-' + i"
              class="rel-item entity"
            >{{ e.name }}</span>
          </div>
        </div>
      </div>

      <!-- 底部状态栏：字数 / 编辑模式；来源、图谱等低频入口收拢到右下。
           v-if 而非 v-show：阅读模式不挂载，wordCount 大页面全文字数统计不跑 -->
      <div v-if="!app.readingMode" class="statusbar">
        <span class="sb-item">{{ wordCount }} 字</span>
        <span class="sb-item">{{ app.editorMode === 'sv' ? '源码' : '即时渲染' }}</span>
        <div class="spacer"></div>
        <button
          v-if="evidence?.sources?.length"
          type="button"
          class="sb-item sb-btn"
          v-tooltip="'查看本页来源证据'"
          @click="evidenceOpen = !evidenceOpen"
        >
          <Icon name="book-open" :size="12" />
          来源 {{ evidence.sources.length }}
        </button>
        <button
          type="button"
          class="sb-item sb-btn"
          v-tooltip="'查看本页图谱'"
          @click="$router.push(`/graph/${page.id}`)"
        >
          <Icon name="graph" :size="12" />
          页面图谱
        </button>
      </div>
    </template>

    <!-- 页面加载 / 错误状态 -->
    <div v-else-if="pageLoading || pageError" class="page-state">
      <template v-if="pageLoading">
        <AppSpinner :size="18" />
        <span class="muted">正在加载页面…</span>
      </template>
      <template v-else>
        <p class="page-error-text">{{ pageError }}</p>
        <button class="btn" @click="retryLoad">重试</button>
      </template>
    </div>

    <!-- 欢迎页 -->
    <div v-else class="welcome">
      <div class="welcome-inner">
        <div class="welcome-logo" aria-hidden="true">
          <svg viewBox="0 0 100 100" width="56" height="56">
            <defs>
              <linearGradient id="engram-orbit-welcome" gradientUnits="userSpaceOnUse" x1="24" y1="76" x2="76" y2="22">
                <stop offset="0" stop-color="#22D3EE" />
                <stop offset="1" stop-color="#4D8AFF" />
              </linearGradient>
              <linearGradient id="engram-core-welcome" gradientUnits="userSpaceOnUse" x1="39" y1="39" x2="61" y2="61">
                <stop offset="0" stop-color="#4D8AFF" />
                <stop offset="1" stop-color="#245BDB" />
              </linearGradient>
            </defs>
            <ellipse cx="50" cy="50" rx="36" ry="15.5" fill="none" stroke="url(#engram-orbit-welcome)" stroke-width="8.5" transform="rotate(-28 50 50)" />
            <circle cx="74" cy="28.5" r="5" fill="#22D3EE" />
            <circle cx="50" cy="50" r="11" fill="url(#engram-core-welcome)" />
          </svg>
        </div>
        <h2>欢迎来到 Engram</h2>
        <p class="muted">不内置 AI 的知识大脑：导入资料，用你的外部 Agent（ZCode / Codex / Claude Code…）经 MCP 或 CLI 提炼与问答。</p>
        <div class="welcome-actions">
          <button class="btn primary" @click="createFirst">新建页面</button>
          <button class="btn" @click="$router.push('/search')">搜索知识库</button>
          <button class="btn" @click="$router.push('/graph')">知识图谱</button>
        </div>
        <div class="welcome-shortcuts">
          <span class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>K</kbd> 搜索</span>
          <span class="shortcut-item"><kbd>Ctrl</kbd>+<kbd>N</kbd> 新建页面</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
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
import AppSpinner from '../components/ui/AppSpinner.vue';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';

const route = useRoute();
const router = useRouter();
const app = useAppStore();

const page = ref<any>(null);
const content = ref('');
const title = ref('');
const pageType = ref('note');
const tags = ref<string[]>([]);
const tagDraft = ref('');
const saveState = ref('');
const related = ref<any>(null);
/* 本页关联折叠：默认收起为一行摘要（关联属页脚参考信息，不该抢正文空间）。
 * 用户点开/收起的选择写入 localStorage 跨会话保留，未操作过时跟随默认收起。 */
const RELATED_STORE_KEY = 'engram.related.expanded';
const relatedCollapsed = ref(localStorage.getItem(RELATED_STORE_KEY) !== '1');
const relatedCount = computed(() =>
  (related.value?.neighbors?.length || 0) +
  (related.value?.similar?.length || 0) +
  (related.value?.entities?.length || 0)
);
function toggleRelated() {
  relatedCollapsed.value = !relatedCollapsed.value;
  localStorage.setItem(RELATED_STORE_KEY, relatedCollapsed.value ? '0' : '1');
}
/* 手机端页头操作区（类型/标签）折叠：
 * 这些是低频操作，手机上铺开占上半屏，正文反而看不到。默认收起，桌面始终展开。 */
const chromeMobile = window.matchMedia('(max-width: 768px)');
const chromeCollapsed = ref(chromeMobile.matches);
let chromeUserTouched = false;
chromeMobile.addEventListener('change', (e) => {
  if (!chromeUserTouched) chromeCollapsed.value = e.matches;
});
function toggleChrome() {
  chromeUserTouched = true;
  chromeCollapsed.value = !chromeCollapsed.value;
}
const evidence = ref<any>(null);
const evidenceOpen = ref(false);
const pageLoading = ref(false);
const pageError = ref('');
const editorRef = ref<InstanceType<typeof MarkdownEditor>>();
const filePreviewRef = ref<InstanceType<typeof FilePreview>>();

const filePath = computed(() => (route.query.file as string) || '');
const isDark = computed(() => app.dark);

/** 面包屑：页面路径去掉文件名后的目录段 */
const crumbDirs = computed(() =>
  String(page.value?.path || '').split('/').slice(0, -1).filter(Boolean)
);

/** 保存状态点的三态样式 */
const savePillClass = computed(() => {
  if (saveState.value === '保存失败') return 'failed';
  if (saveState.value === '编辑中…') return 'dirty';
  return 'ok';
});

/** 字数统计：CJK 按字、拉丁按词；剔除代码块与注释 */
const wordCount = computed(() => {
  const text = content.value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`~|()[\]!:-]/g, ' ');
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return (cjk + latin).toLocaleString();
});

function formatDate(value: string | number | undefined): string {
  if (!value) return '';
  let d: Date;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    d = new Date(String(n).length === 10 ? n * 1000 : n);
  } else {
    d = new Date(String(value).replace(' ', 'T'));
  }
  if (isNaN(d.getTime())) return String(value);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function commitTagDraft() {
  const parts = tagDraft.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  if (!parts.length) {
    tagDraft.value = '';
    return;
  }
  let changed = false;
  for (const t of parts) {
    if (!tags.value.includes(t)) {
      tags.value.push(t);
      changed = true;
    }
  }
  tagDraft.value = '';
  if (changed) save(true);
}

function onTagDraftKey(e: KeyboardEvent) {
  if (e.key === ',' || e.key === '，') {
    e.preventDefault();
    commitTagDraft();
  }
}

function removeTag(index: number) {
  tags.value.splice(index, 1);
  save(true);
}

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
  pageLoading.value = true;
  pageError.value = '';
  loading = true; // 抑制 watch
  try {
    const { data } = await api.get(`/api/pages/${id}`);
    page.value = data.meta;
    content.value = data.content;
    loadedContentKey = visibleContentKey(data.content);
    // 标题为空时回退到文件名（去掉 .md 后缀）
    title.value = data.meta.title || data.meta.path.split('/').pop()?.replace(/\.md$/i, '') || '无标题';
    pageType.value = data.meta.type;
    tags.value = [...(data.meta.tags || [])];
    tagDraft.value = '';
    saveState.value = '';
    dirty = false;
    loadRelated();
    loadEvidence();
  } catch (error: any) {
    pageError.value = error?.response?.data?.error || '页面加载失败';
    notify.error(pageError.value);
  } finally {
    loading = false;
    pageLoading.value = false;
  }
}

function retryLoad() {
  const id = route.params.id as string;
  if (id) loadPage(id);
}

async function loadRelated() {
  if (!page.value) return;
  try {
    const { data } = await api.get(`/api/pages/${page.value.id}/related`);
    related.value = data;
  } catch { /* ignore */ }
}

async function loadEvidence() {
  if (!page.value || !['concept', 'person', 'customer', 'org', 'project', 'other'].includes(pageType.value)) {
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
  // 阅读期间可能已切换/重载过页面：编辑器隐藏时跳过了同步，恢复显示后补一次
  nextTick(() => {
    editorRef.value?.syncIfPending();
    editorRef.value?.focus();
  });
}

async function save(manual = false) {
  if (!page.value) return;
  const contentToSave = editorRef.value?.getValue() ?? content.value;
  try {
    const { data } = await api.put(`/api/pages/${page.value.id}`, {
      content: contentToSave,
      title: title.value,
      type: pageType.value,
      tags: tags.value,
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
  } catch (error: any) {
    // dirty 保持 true：beforeunload 会继续提醒，下次编辑/手动保存可重试
    saveState.value = '保存失败';
    notify.error(error?.response?.data?.error || '保存失败，请稍后重试');
  }
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
    const ok = await confirmDialog({
      title: '创建页面',
      message: `页面「${wikiTitle}」不存在，是否创建？`,
      confirmText: '创建',
    });
    if (ok) {
      const { data } = await api.post('/api/pages', { dir: '', title: wikiTitle });
      router.push(`/page/${data.meta.id}`);
    }
  }
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
  ];
}

function pageContextItems(separatorBefore = false): ContextMenuItem[] {
  return [
    {
      id: 'page-graph',
      label: '查看页面图谱',
      icon: 'graph',
      separatorBefore,
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
        if (!pasted) notify.info('浏览器未允许读取剪贴板，请使用 Ctrl+V 粘贴');
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

async function createFirst() {
  const { data } = await api.post('/api/pages', { dir: '', title: '欢迎使用 Engram' });
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
      pageError.value = '';
    }
  }
);

// 服务端 SSE 推送：当前页内容被任意来源（本会话/Dream/MCP/多标签）改动时即时重载
watch(
  () => app.pageVersion,
  () => {
    const ev = app.lastPageEvent;
    if (!page.value || !ev) return;
        const myPath = page.value.path;
        // 当前页被任意来源删除（含其他端同步）：编辑页跟随关闭（本端侧栏删除同款跳转），
        // 否则侧栏树已删、编辑页仍显示已删内容
        if (ev.type === 'page-deleted' && ev.path === myPath) {
          page.value = null;
          router.push('/page');
          return;
        }
        // 只在当前页内容变化或被移动时重载
        const matchChanged = ev.type === 'page-changed' && ev.path === myPath;
    const matchMoved = ev.type === 'page-moved' && (ev.oldPath === myPath || ev.newPath === myPath);
    if (!matchChanged && !matchMoved) return;
    if (dirty) return; // 用户正在编辑，不覆盖未保存内容
    if (Date.now() - justSavedAt < 1500) return; // 自己刚保存的回声，忽略
    loadPage(page.value.id);
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
});
</script>

<style scoped>
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  /* 内容列：页头 / 正文 / 关联区统一 760px 居中，vditor 内联 padding 被下方 !important 覆盖 */
  --editor-max: 100%;
  --content-col: 760px;
}

/* ---------- 顶部条：面包屑 + 保存状态 ---------- */
.editor-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 20px;
  font-size: 12.5px;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border);
}
.crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.crumb-item {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb-sep { color: var(--text-faint); margin-left: 6px; }
.editor-topbar .spacer,
.statusbar .spacer { flex: 1; }
.save-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
}
.save-pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success, #107c10);
}
.save-pill.dirty .dot { background: var(--warning); animation: save-pulse 1.2s infinite; }
.save-pill.failed { color: var(--danger); }
.save-pill.failed .dot { background: var(--danger); }
@keyframes save-pulse { 50% { opacity: 0.35; } }

/* ---------- 页头：标题 + 元信息 chips，与正文列对齐 ---------- */
.page-head {
  flex: none;
  width: 100%;
  padding: 28px max(24px, calc((100% - var(--content-col)) / 2)) 0;
}
.title-input {
  width: 100%;
  border: none;
  font-size: 32px;
  font-weight: 700;
  padding: 4px 0;
  background: transparent;
}
.title-input::placeholder { color: var(--text-faint); }
/* 手机端摘要行：桌面隐藏；折叠区 page-chrome 桌面始终显示 */
.head-summary { display: none; }
.chrome-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
}
.chrome-toggle:hover { color: var(--text); background: var(--bg-hover); }
.head-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-bottom: 12px;
  flex-wrap: wrap;
}
.chip-select {
  border: 1px solid transparent;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 999px;
}
.chip-select:hover { border-color: var(--accent); }
.tags-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 160px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.chip-x {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  padding: 0 1px;
}
.chip-x:hover { color: var(--danger); }
.tag-draft {
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 3px 4px;
  min-width: 64px;
  flex: 0 1 110px;
}
.tag-draft:hover { background: var(--bg-hover); border-radius: 4px; }
.meta-date {
  margin-left: auto;
  font-size: 12px;
  white-space: nowrap;
}
.synthesis-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--warning);
  white-space: nowrap;
}
.synthesis-inline.failed { color: var(--danger); }

.editor-area { flex: 1; min-height: 0; }
.page-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.page-error-text { margin: 0; color: var(--danger); }
.editor-area :deep(.vditor) {
  max-width: var(--editor-max);
  width: 100% !important;
  margin: 0 !important;
}
.editor-area :deep(.vditor-toolbar) { max-width: 100%; }
/* 正文文字列与页头/关联区同一内容列：覆盖 vditor JS 写入的居中内联 padding */
.editor-area :deep(.vditor-reset) {
  padding-left: max(24px, calc((100% - var(--content-col)) / 2)) !important;
  padding-right: max(24px, calc((100% - var(--content-col)) / 2)) !important;
}
/* 工具栏内联 padding-left 同样来自 vditor 的 820px 居中公式，同步对齐到内容列 */
.editor-area :deep(.vditor-toolbar) {
  padding-left: max(24px, calc((100% - var(--content-col)) / 2)) !important;
  padding-right: max(10px, calc((100% - var(--content-col)) / 2)) !important;
}

/* 排版精修（Typora/Obsidian 风可读宽行，三种编辑模式统一）
 * 正文用 rem：桌面 root 16px 时 1rem=16px 与原值一致；
 * 手机端在 media query 里放大到 1.14rem（root 14px 基准下仍为 16px），
 * 两端都随浏览器/系统字体设置等比缩放 */
.editor-area :deep(.vditor-ir),
.editor-area :deep(.vditor-wysiwyg),
.editor-area :deep(.vditor-sv) {
  font-size: 1rem;
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
  z-index: var(--z-subpanel);
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
.synthesis-state.warning { color: var(--warning); }
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
  border-radius: 4px;
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

/* ---------- 本页关联：与正文同一内容列，胶囊卡片 ---------- */
.related {
  flex: none;
  padding: 0 max(24px, calc((100% - var(--content-col)) / 2)) 26px;
}
.related-inner {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.related-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.related-toggle:hover { color: var(--text); background: transparent; }
.related-count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.related-chev { color: var(--text-faint); }
.related-items { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.related.collapsed .related-items { display: none; }
.rel-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.rel-item:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.rel-item.entity { color: var(--accent); border-color: transparent; background: var(--accent-soft); }

/* ---------- 底部状态栏 ---------- */
.statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 4px 20px;
  font-size: 12px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}
.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sb-btn {
  border: none;
  background: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-faint);
  font-size: 12px;
}
.sb-btn:hover { background: var(--bg-hover); color: var(--text); }

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
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-inner h2 { font-weight: 600; }
.welcome-actions { display: flex; gap: 10px; justify-content: center; margin: 20px 0; flex-wrap: wrap; }
.welcome-shortcuts {
  display: flex;
  justify-content: center;
  gap: 14px;
  margin-top: 18px;
  flex-wrap: wrap;
}
.shortcut-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-faint);
  font-size: 11px;
}
.shortcut-item kbd {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
}

@media (max-width: 768px) {
  .editor-topbar { padding: 6px 14px; }
  .page-head { padding: 20px 20px 0; }
  .related { padding: 0 20px 20px; }
  .editor-area :deep(.vditor-reset) {
    padding-left: 20px !important;
    padding-right: 20px !important;
  }
  .editor-area :deep(.vditor-toolbar) {
    padding-left: 8px !important;
    padding-right: 8px !important;
  }
  .title-input { font-size: 26px; }
  .meta-date { display: none; }
  .evidence-drawer { width: 100%; border-left: 0; }
  .statusbar { padding: 4px 14px; gap: 10px; }

  /* 页头操作区折叠：摘要行显示、折叠区随状态隐藏 */
  .head-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .page-chrome { padding-top: 8px; }
  .page-head.chrome-collapsed .page-chrome { display: none; }
}
</style>
