<template>
  <div class="editor-view">
    <!-- 文件预览模式（docx 等） -->
    <FilePreview v-if="filePath" :path="filePath" />

    <!-- 页面编辑模式 -->
    <template v-else-if="page">
      <div class="page-head">
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
          <button class="ghost-btn" title="查看本页图谱" @click="$router.push(`/graph/${page.id}`)">
            <Icon name="graph" :size="14" />
          </button>
        </div>
      </div>

      <!-- AI 写作操作条 -->
      <div class="ai-bar">
        <Icon name="ai" :size="13" class="ai-bar-icon" />
        <button v-for="a in aiActions" :key="a.key" class="ai-action" @click="runAi(a.key)">
          {{ a.label }}
        </button>
        <span class="faint small ai-hint">选中文本后使用，未选中则作用于全文</span>
      </div>

      <div class="editor-area">
        <MarkdownEditor
          ref="editorRef"
          v-model="content"
          :dark="isDark"
          :mode="app.editorMode"
          :html-mode="app.htmlPreview"
          @save="save(true)"
          @open-wikilink="openWikilink"
          @mode-change="(m: 'ir' | 'sv') => app.setEditorMode(m)"
          @html-change="(on: boolean) => app.toggleHtmlPreview(on)"
        />
      </div>

      <!-- AI 输出面板 -->
      <transition name="fade">
        <div v-if="aiPanel.show" class="ai-panel card">
          <div class="ai-panel-head">
            <b>{{ aiPanel.title }}</b>
            <div>
              <button class="btn small" @click="insertAi">插入光标处</button>
              <button class="btn small" @click="copyAi">复制</button>
              <button class="btn small" @click="aiPanel.show = false">✕</button>
            </div>
          </div>
          <pre class="ai-output">{{ aiPanel.text }}<span v-if="aiPanel.streaming">▍</span></pre>
        </div>
      </transition>

      <!-- 本页关联 -->
      <div v-if="related" class="related">
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ssePost } from '../api';
import { useAppStore } from '../stores/app';
import MarkdownEditor from '../components/MarkdownEditor.vue';
import FilePreview from '../components/FilePreview.vue';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();

const page = ref<any>(null);
const content = ref('');
const title = ref('');
const pageType = ref('note');
const tagsInput = ref('');
const saveState = ref('');
const related = ref<any>(null);
const editorRef = ref<InstanceType<typeof MarkdownEditor>>();

const filePath = computed(() => (route.query.file as string) || '');
const isDark = computed(() => document.documentElement.classList.contains('dark'));

const aiActions = [
  { key: 'continue', label: '续写' },
  { key: 'polish', label: '润色' },
  { key: 'expand', label: '扩写' },
  { key: 'summarize', label: '总结' },
  { key: 'translate', label: '翻译' },
];
const aiPanel = ref({ show: false, title: '', text: '', streaming: false });

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let loading = false; // 加载页面时抑制 content watch
let justSavedAt = 0; // 本地刚保存时间戳，抑制 SSE 回声导致的重复重载

async function loadPage(id: string) {
  const { data } = await api.get(`/api/pages/${id}`);
  loading = true; // 抑制 watch
  page.value = data.meta;
  content.value = data.content;
  // 标题为空时回退到文件名（去掉 .md 后缀）
  title.value = data.meta.title || data.meta.path.split('/').pop()?.replace(/\.md$/i, '') || '无标题';
  pageType.value = data.meta.type;
  tagsInput.value = (data.meta.tags || []).join(', ');
  saveState.value = '';
  dirty = false;
  loading = false;
  loadRelated();
}

async function loadRelated() {
  if (!page.value) return;
  try {
    const { data } = await api.get(`/api/pages/${page.value.id}/related`);
    related.value = data;
  } catch { /* ignore */ }
}

async function save(manual = false) {
  if (!page.value) return;
  const tags = tagsInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  await api.put(`/api/pages/${page.value.id}`, {
    content: editorRef.value?.getValue() ?? content.value,
    title: title.value,
    type: pageType.value,
    tags,
  });
  dirty = false;
  justSavedAt = Date.now(); // 抑制本次保存触发的 SSE 回声
  saveState.value = manual ? '已保存 ✓' : '已自动保存';
  app.bumpSidebar(); // 类型/标题变化后立刻刷新侧栏分区
  setTimeout(() => (saveState.value = ''), 2000);
  loadRelated();
}

watch(content, () => {
  if (loading || !page.value) return; // 加载阶段不触发
  dirty = true;
  saveState.value = '编辑中…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 2000);
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

async function runAi(action: string) {
  const sel = editorRef.value?.getSelectionText() || '';
  const text = sel || editorRef.value?.getValue() || '';
  if (!text.trim()) return;
  const label = aiActions.find((a) => a.key === action)?.label || action;
  aiPanel.value = { show: true, title: `AI ${label}中…`, text: '', streaming: true };
  try {
    await ssePost('/api/ai/write', { action, text }, {
      onDelta: (d) => (aiPanel.value.text += d),
      onEvent: (ev, data) => {
        if (ev === 'error') aiPanel.value.text += `\n⚠ ${data.message}`;
      },
    });
    aiPanel.value.title = `AI ${label}结果`;
  } catch (e: any) {
    aiPanel.value.text += `\n⚠ ${e.message}`;
  } finally {
    aiPanel.value.streaming = false;
  }
}

function insertAi() {
  editorRef.value?.insertText(aiPanel.value.text);
  aiPanel.value.show = false;
}

function copyAi() {
  navigator.clipboard.writeText(aiPanel.value.text);
}

async function organize() {
  if (!page.value) return;
  await api.post(`/api/ai/organize/${page.value.id}`);
  saveState.value = 'AI 整理已加入队列…';
  setTimeout(() => loadPage(page.value.id), 6000);
}

async function createFirst() {
  const { data } = await api.post('/api/pages', { dir: '', title: '欢迎使用 LLM Wiki' });
  router.push(`/page/${data.meta.id}`);
}

watch(
  () => route.params.id,
  (id, oldId) => {
    // 不置空 page（避免销毁 MarkdownEditor 丢失编辑模式/HTML 预览状态）；
    // 只清关联数据，直接加载新页面。编辑器组件保持存活，内容由 watch(props.modelValue) 更新。
    related.value = null;
    if (id && id !== oldId) loadPage(id as string);
    else if (!id) page.value = null; // 无 id 才回欢迎页
  }
);

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

/* ===== HTML 预览美化（精选子集融合 Notion 风 + 电光蓝点缀） ===== */
.editor-area :deep(.html-preview-overlay) {
  position: absolute;
  inset: 0;
  z-index: 20;
  overflow-y: auto;
  background:
    radial-gradient(600px 420px at 88% -60px, rgba(37, 99, 235, 0.05), transparent 70%),
    radial-gradient(520px 400px at 4% 2%, rgba(59, 130, 246, 0.04), transparent 70%),
    var(--bg);
  padding: 48px 56px 72px;
  font-size: 16px;
  line-height: 1.8;
  color: var(--text);
}
.editor-area :deep(.html-preview-overlay h1),
.editor-area :deep(.html-preview-overlay h2),
.editor-area :deep(.html-preview-overlay h3),
.editor-area :deep(.html-preview-overlay h4) {
  line-height: 1.3;
  color: var(--text);
  position: relative;
}
.editor-area :deep(.html-preview-overlay h1) {
  font-size: 2.1em;
  font-weight: 900;
  letter-spacing: -0.01em;
  margin: 0.6em 0 0.9em;
  padding-bottom: 0.4em;
}
/* h1 电光蓝渐变 signature 下划线 */
.editor-area :deep(.html-preview-overlay h1::after) {
  content: "";
  position: absolute;
  left: 0;
  bottom: 0;
  width: 120px;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(to right, rgba(37, 99, 235, 0.55), rgba(59, 130, 246, 0.25));
}
.editor-area :deep(.html-preview-overlay h2) {
  font-size: 1.55em;
  font-weight: 700;
  margin: 1.6em 0 0.7em;
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--border);
}
.editor-area :deep(.html-preview-overlay h3) {
  font-size: 1.2em;
  font-weight: 700;
  margin: 1.4em 0 0.6em;
}
.editor-area :deep(.html-preview-overlay h4) {
  font-size: 1em;
  font-weight: 600;
  margin: 1.3em 0 0.5em;
}
/* 章节编号：电光蓝渐变文字 */
.editor-area :deep(.html-preview-overlay h1::before),
.editor-area :deep(.html-preview-overlay h2::before),
.editor-area :deep(.html-preview-overlay h3::before) {
  content: attr(data-md-num);
  margin-right: 0.45em;
  background: linear-gradient(to right, var(--accent), #4d7cff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-weight: 700;
}
.editor-area :deep(.html-preview-overlay p) { margin: 0 0 1em; }
.editor-area :deep(.html-preview-overlay a) {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.editor-area :deep(.html-preview-overlay a:hover) { text-decoration: underline; }
.editor-area :deep(.html-preview-overlay ul:not(.contains-task-list)),
.editor-area :deep(.html-preview-overlay ol:not(.contains-task-list)) {
  list-style: none;
  margin: 0 0 1em;
  padding-left: 2em;
}
.editor-area :deep(.html-preview-overlay li > p:first-child) { display: inline; }
.editor-area :deep(.html-preview-overlay li > p:first-child + ul),
.editor-area :deep(.html-preview-overlay li > p:first-child + ol) { margin-top: 0.35em; }
.editor-area :deep(.html-preview-overlay li) { margin: 0.35em 0; }
/* 引用块：电光蓝渐变竖线 */
.editor-area :deep(.html-preview-overlay blockquote) {
  margin: 0 0 1em;
  padding: 0.7em 1.3em;
  border-left: 4px solid var(--accent);
  border-image: linear-gradient(to bottom, var(--accent), #4d7cff) 1;
  background: var(--bg-secondary);
  border-radius: 0 8px 8px 0;
  color: var(--text-secondary);
}
.editor-area :deep(.html-preview-overlay blockquote p:last-child) { margin-bottom: 0; }
/* 代码 */
.editor-area :deep(.html-preview-overlay pre) {
  padding: 16px 20px;
  border-radius: 12px;
  margin: 0 0 1em;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  overflow-x: auto;
}
.editor-area :deep(.html-preview-overlay code) {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  border-radius: 6px;
  padding: 0.15em 0.45em;
  font-size: 0.85em;
  background: var(--accent-soft);
  color: var(--accent);
}
.editor-area :deep(.html-preview-overlay pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}
/* 表格：斑马纹 + 表头底色 */
.editor-area :deep(.html-preview-overlay table) {
  border-collapse: collapse;
  margin: 0 0 1.2em;
  width: 100%;
  display: block;
  overflow-x: auto;
  font-variant-numeric: tabular-nums;
}
.editor-area :deep(.html-preview-overlay th) {
  background: var(--bg-tertiary);
  color: var(--text);
  font-weight: 600;
  text-align: left;
  padding: 11px 12px;
  border-bottom: 2px solid var(--accent);
}
.editor-area :deep(.html-preview-overlay td) {
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
}
.editor-area :deep(.html-preview-overlay tr:nth-child(even) td) { background: var(--bg-secondary); }
.editor-area :deep(.html-preview-overlay tr:hover td) { background: var(--bg-hover); }
/* 图片 */
.editor-area :deep(.html-preview-overlay img) {
  display: block;
  max-width: 100%;
  margin: 1em auto;
  border-radius: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
}
/* 分割线 */
.editor-area :deep(.html-preview-overlay hr) {
  margin: 2.2em 0;
  border: none;
  height: 2px;
  border-radius: 1px;
  background: linear-gradient(to right, transparent, var(--border) 20%, var(--border) 80%, transparent);
}
/* 列表徽章（JS 注入的 span 标记） */
.editor-area :deep(.html-preview-overlay .mdht-ul-marker),
.editor-area :deep(.html-preview-overlay .mdht-ol-marker) {
  box-sizing: border-box;
}
/* 无序列表使用接近原生排版的小圆点：标记净占宽为 0，仅保留 0.55em 的正文间距 */
.editor-area :deep(.html-preview-overlay .mdht-ul-marker) {
  display: inline-block;
  margin-left: -0.97em;
  margin-right: 0.55em;
  vertical-align: 0.08em;
}
.editor-area :deep(.html-preview-overlay .mdht-ul-l1) {
  width: 0.42em; height: 0.42em; border-radius: 50%; background: var(--accent);
}
.editor-area :deep(.html-preview-overlay .mdht-ul-l2) {
  width: 0.42em; height: 0.42em; border-radius: 50%; background: transparent; border: 0.09em solid var(--accent);
}
.editor-area :deep(.html-preview-overlay .mdht-ul-l3) {
  width: 0.32em; height: 0.32em; border-radius: 1px; background: var(--accent);
  margin-left: -0.87em;
  vertical-align: 0.12em;
}
.editor-area :deep(.html-preview-overlay .mdht-ol-marker) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin-left: -1.75em;
  margin-right: 0.65em;
  width: 1em;
  height: 1em;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), #4d7cff);
  color: #fff;
  box-shadow: 0 1px 4px rgba(37, 99, 235, 0.28);
  vertical-align: 0.1em;
  text-align: center;
}
.editor-area :deep(.html-preview-overlay .mdht-ol-num) {
  display: block;
  font-size: 0.66em;
  font-weight: 700;
  line-height: 1;
}
@media (max-width: 768px) {
  .editor-area :deep(.html-preview-overlay) { padding: 24px 16px 40px; }
  .editor-area :deep(.html-preview-overlay h1) { font-size: 1.7em; }
  .editor-area :deep(.html-preview-overlay h2) { font-size: 1.35em; }
}

.ai-panel {
  position: absolute;
  right: 24px;
  bottom: 80px;
  width: min(480px, 90vw);
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  z-index: 50;
}
.ai-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.ai-output {
  flex: 1;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
  margin: 0;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

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
}
</style>
