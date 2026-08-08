<template>
  <div class="editor-view" :class="{ 'read-mode': app.editorRead }">
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
          <button
            class="ghost-btn"
            :class="{ active: app.editorRead }"
            :title="app.editorRead ? '阅读窄栏 · 点击切宽幅画布' : '宽幅画布 · 点击切阅读窄栏'"
            @click="app.toggleEditorRead()"
          >{{ app.editorRead ? '窄栏' : '宽幅' }}</button>
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
          @save="save(true)"
          @open-wikilink="openWikilink"
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
  (id) => {
    page.value = null;
    related.value = null;
    if (id) loadPage(id as string);
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
.editor-view.read-mode { --editor-max: min(760px, 92vw); }
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
.ghost-btn.active { color: var(--accent); background: var(--accent-soft); }
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

/* 排版精修（Typora/Obsidian 风可读宽行） */
.editor-area :deep(.vditor-ir) {
  font-size: 16px;
  line-height: 1.8;
  color: var(--text);
}
.editor-area :deep(.vditor-ir h1),
.editor-area :deep(.vditor-ir h2),
.editor-area :deep(.vditor-ir h3),
.editor-area :deep(.vditor-ir h4),
.editor-area :deep(.vditor-ir h5),
.editor-area :deep(.vditor-ir h6) {
  font-weight: 700;
  line-height: 1.3;
  margin: 1.6em 0 0.6em;
}
.editor-area :deep(.vditor-ir h1) { font-size: 1.9em; margin-top: 0.2em; }
.editor-area :deep(.vditor-ir h2) { font-size: 1.5em; font-weight: 650; }
.editor-area :deep(.vditor-ir h3) { font-size: 1.25em; font-weight: 600; }
.editor-area :deep(.vditor-ir h4) { font-size: 1.05em; font-weight: 600; }
.editor-area :deep(.vditor-ir h5),
.editor-area :deep(.vditor-ir h6) { font-size: 0.95em; color: var(--text-secondary); }
.editor-area :deep(.vditor-ir p) { margin: 0.75em 0; }
.editor-area :deep(.vditor-ir a) { color: var(--accent); }
.editor-area :deep(.vditor-ir a:hover) { text-decoration: underline; text-underline-offset: 2px; }
.editor-area :deep(.vditor-ir blockquote) {
  margin: 0.9em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-secondary);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
}
.editor-area :deep(.vditor-ir blockquote p) { margin: 0.3em 0; }
.editor-area :deep(.vditor-ir code) {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.88em;
  padding: 0.15em 0.4em;
  border-radius: 4px;
  background: var(--bg-tertiary);
}
.editor-area :deep(.vditor-ir pre) {
  margin: 0.9em 0;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-x: auto;
}
.editor-area :deep(.vditor-ir pre code) {
  padding: 0;
  background: transparent;
  font-size: 0.86em;
  line-height: 1.6;
}
.editor-area :deep(.vditor-ir table) {
  border-collapse: collapse;
  margin: 0.9em 0;
  width: 100%;
  font-size: 0.92em;
}
.editor-area :deep(.vditor-ir th),
.editor-area :deep(.vditor-ir td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.editor-area :deep(.vditor-ir th) { background: var(--bg-tertiary); font-weight: 600; }
.editor-area :deep(.vditor-ir ul),
.editor-area :deep(.vditor-ir ol) { margin: 0.6em 0; padding-left: 1.6em; }
.editor-area :deep(.vditor-ir li) { margin: 0.25em 0; }
.editor-area :deep(.vditor-ir hr) { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }
.editor-area :deep(.vditor-ir img) { max-width: 100%; border-radius: var(--radius); }

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
