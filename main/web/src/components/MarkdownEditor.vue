<template>
  <div class="editor-wrap">
    <div ref="vditorEl" class="vditor-host" />

    <!-- 双链插入弹窗 -->
    <div v-if="linkPopup" class="link-popup card" @keydown.stop>
      <input
        ref="linkInputEl"
        v-model="linkQuery"
        placeholder="输入页面标题，回车插入双链"
        @input="searchLinks"
        @keydown.enter.prevent="insertLink(suggestions[0]?.title || linkQuery)"
        @keydown.esc="linkPopup = false"
      />
      <div v-if="suggestions.length" class="link-list">
        <div
          v-for="s in suggestions"
          :key="s.id"
          class="link-item"
          @click="insertLink(s.title)"
        >
          📄 {{ s.title }} <span class="faint small">{{ s.path }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '../api';
import { VDITOR_CDN } from '../lib/vditorPreview';
import {
  copyText,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import {
  markdownLinksToWiki,
  markdownWikiLink,
  wikiLinksToMarkdown,
  wikiTargetFromHref,
} from '../lib/wikiLinks';

const props = defineProps<{ modelValue: string; dark: boolean; mode?: 'ir' | 'sv' }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'ai-action', action: string, text: string): void;
  (e: 'open-wikilink', title: string): void;
  (e: 'mode-change', mode: 'ir' | 'sv'): void;
  (e: 'enter-reading'): void;
  (e: 'context-menu', request: SelectionContextMenuRequest): void;
}>();

const vditorEl = ref<HTMLElement>();
const linkInputEl = ref<HTMLInputElement>();
const linkPopup = ref(false);
const linkQuery = ref('');
const suggestions = ref<any[]>([]);

let vditor: Vditor | null = null;
let ready = false;
let composing = false; // IME 组字状态（wysiwyg 下 input 走防抖，组字期间不 emit 防丢字）
let syncingModelValue = true;
let lastProgrammaticValue = '';
let userInputPending = false;
let modelSyncReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let placeholderHideTimer: ReturnType<typeof setTimeout> | null = null;
let modeObserver: MutationObserver | null = null;
let lastEmittedMode: 'ir' | 'sv' = 'ir';
let savedSelectionRange: Range | null = null;
let savedSelectionText = '';

/** AI 管理注释：证据标记与贡献区段边界都不应出现在编辑界面。 */
const MANAGED_COMMENT_RE = /<!--\s*(?:ingest:|contribution:|synthesis:)[^>]*-->/g;
const INGEST_PLACEHOLDER_RE = /\[(?:managed)?\]\(#ingest-preserved-([A-Za-z0-9_-]+)\)/g;

function encodeManagedComment(comment: string): string {
  return btoa(comment)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeManagedComment(encoded: string): string {
  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return atob(base64);
}

/** 用零宽占位链接隐藏证据标记，同时保留它在正文中的准确位置。 */
function stripIngestComments(md: string): string {
  return md.replace(INGEST_PLACEHOLDER_RE, '').replace(
    MANAGED_COMMENT_RE,
    (comment) => `[managed](#ingest-preserved-${encodeManagedComment(comment)})`,
  );
}

/** 保存时优先原位还原；编辑器若意外清除了占位符，再降级追加原标记。 */
function restoreIngestComments(md: string): string {
  if (!vditor) return md;
  let restoredAny = false;
  const restoredComments = new Set<string>();
  const restored = md.replace(INGEST_PLACEHOLDER_RE, (_full, encoded: string) => {
    try {
      restoredAny = true;
      const comment = decodeManagedComment(encoded);
      if (restoredComments.has(comment)) return '';
      restoredComments.add(comment);
      return comment;
    } catch {
      return '';
    }
  });
  if (restoredAny) return restored;

  const raw = props.modelValue;
  const comments = raw.match(MANAGED_COMMENT_RE);
  if (!comments || comments.length === 0) return md;
  if (MANAGED_COMMENT_RE.test(md)) { MANAGED_COMMENT_RE.lastIndex = 0; return md; }
  MANAGED_COMMENT_RE.lastIndex = 0;
  return md.trimEnd() + '\n' + comments.join('\n');
}

function comparableMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(INGEST_PLACEHOLDER_RE, '')
    .replace(MANAGED_COMMENT_RE, '')
    .trim();
}

function hideManagedPlaceholders() {
  if (!vditorEl.value) return;
  const inlineLinks = vditorEl.value.querySelectorAll<HTMLElement>('span[data-type="a"]');
  for (const link of inlineLinks) {
    const target = link.querySelector<HTMLElement>('.vditor-ir__marker--link')?.textContent || '';
    if (target.startsWith('#ingest-preserved-')) {
      link.classList.add('managed-placeholder');
    }
  }
  const paragraphs = vditorEl.value.querySelectorAll<HTMLElement>('p[data-block]');
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent?.trim() || '';
    if (
      paragraph.querySelector('a[href^="#ingest-preserved-"]') ||
      text.startsWith('[](#ingest-preserved-') ||
      text.startsWith('[managed](#ingest-preserved-')
    ) {
      paragraph.classList.add('managed-placeholder');
    }
  }
}

function scheduleHideManagedPlaceholders() {
  if (placeholderHideTimer) clearTimeout(placeholderHideTimer);
  placeholderHideTimer = setTimeout(() => {
    placeholderHideTimer = null;
    hideManagedPlaceholders();
  }, 0);
}

function releaseModelSyncSoon() {
  if (modelSyncReleaseTimer) clearTimeout(modelSyncReleaseTimer);
  modelSyncReleaseTimer = setTimeout(() => {
    syncingModelValue = false;
    modelSyncReleaseTimer = null;
  }, 500);
}

function beginUserEditing() {
  if (modelSyncReleaseTimer) clearTimeout(modelSyncReleaseTimer);
  modelSyncReleaseTimer = null;
  syncingModelValue = false;
}

/** 监听 Vditor edit-mode 切换（DOM class 变化），emit mode-change 让父组件持久化 */
function observeEditMode() {
  if (!vditorEl.value) return;
  // Vditor 切模式会给 toolbar button 加 vditor-menu--current，并改 vditor 容器 class
  // 更可靠的是直接轮询 vditor.getCurrentMode()
  let last = vditor?.getCurrentMode() || 'ir';
  lastEmittedMode = last as 'ir' | 'sv';
  modeObserver = new MutationObserver(() => {
    if (!vditor) return;
    const cur = vditor.getCurrentMode();
    if (cur !== last && (cur === 'ir' || cur === 'sv')) {
      last = cur;
      lastEmittedMode = cur;
      emit('mode-change', cur);
    }
  });
  modeObserver.observe(vditorEl.value, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-mode'],
  });
}

const readingToolbarItem = {
  name: 'reading',
  tip: '沉浸阅读',
  icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  click: () => emit('enter-reading'),
};
// 手机端精简到一行（390px 视口最多放 10 个按钮），完整工具栏桌面不变
const mobileToolbar = [
  'headings', 'bold', 'italic', 'list', 'ordered-list',
  {
    name: 'wikilink',
    tip: '插入双链 [[页面]]',
    icon: '🔗',
    click: () => openLinkPopup(),
  },
  'link', 'undo', 'edit-mode', readingToolbarItem,
];
const desktopToolbar = [
  'headings', 'bold', 'italic', 'strike', 'quote', 'list', 'ordered-list', 'code', 'inline-code',
  'table', 'link', '|',
  {
    name: 'wikilink',
    tip: '插入双链 [[页面]]',
    icon: '🔗',
    click: () => openLinkPopup(),
  },
  '|', 'undo', 'redo', '|', 'edit-mode', 'fullscreen', 'outline', '|',
  readingToolbarItem,
];

function init() {
  const initialValue = stripIngestComments(wikiLinksToMarkdown(props.modelValue));
  lastProgrammaticValue = initialValue;
  vditor = new Vditor(vditorEl.value!, {
    cdn: VDITOR_CDN,
    mode: props.mode ?? 'ir',
    height: '100%',
    cache: { enable: false },
    theme: props.dark ? 'dark' : 'classic',
    value: initialValue,
    placeholder: '开始书写… 输入 [[ 插入双链，Ctrl+S 保存',
    preview: { mode: 'both' },
    link: {
      isOpen: false,
      click: openEditorLink,
    },
    toolbar: window.matchMedia('(max-width: 768px)').matches ? mobileToolbar : desktopToolbar,
    toolbarConfig: { pin: true },
    upload: {
      url: '/api/files/upload',
      fieldName: 'files',
      multiple: false,
      extraData: { dir: 'assets' },
      format(_files, responseText) {
        const res = JSON.parse(responseText);
        const saved = res.saved?.[0];
        if (!saved) return JSON.stringify({ msg: '上传失败', code: 1 });
        const url = `/api/files/raw?path=${encodeURIComponent(saved.path)}`;
        return JSON.stringify({
          msg: '', code: 0,
          data: { errFiles: [], succMap: { [saved.name]: url } },
        });
      },
    },
    input: (v) => {
      // IME 组字期间不 emit，避免 wysiwyg 防抖重渲染打断输入
      if (!ready || composing || syncingModelValue || !userInputPending) return;
      userInputPending = false;
      if (v === lastProgrammaticValue) return;
      lastProgrammaticValue = v;
      const nextValue = restoreIngestComments(markdownLinksToWiki(v));
      if (comparableMarkdown(nextValue) === comparableMarkdown(props.modelValue)) return;
      emit('update:modelValue', nextValue);
    },
    after: () => {
      ready = true;
      lastProgrammaticValue = vditor?.getValue() || initialValue;
      bindKeys();
      releaseModelSyncSoon();
      scheduleHideManagedPlaceholders();
    },
  });
}

function bindKeys() {
  const el = vditorEl.value!;
  el.addEventListener('input', (e: Event) => {
    if (e.isTrusted && !syncingModelValue) userInputPending = true;
  }, true);
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    beginUserEditing();
    if ((e.target as HTMLElement).closest('.vditor-toolbar button')) {
      userInputPending = true;
    }
  }, true);
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isTrusted) beginUserEditing();
    if (e.isComposing) { composing = true; return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      emit('save');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const title = wikilinkAtCursor();
      if (title) {
        e.preventDefault();
        emit('open-wikilink', title);
      }
    }
  });
  // keyup 时解除组字锁，并补发一次 input（把组字期间积攒的内容同步出去）
  el.addEventListener('keyup', (e: KeyboardEvent) => {
    if (composing && !e.isComposing) {
      composing = false;
      const v = vditor?.getValue() || '';
      emit('update:modelValue', restoreIngestComments(markdownLinksToWiki(v)));
    }
    if (e.key === '[' && justTypedDoubleBracket()) openLinkPopup(true);
  });
  // compositionstart/end 兜底（部分 IME 不触发 isComposing）
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => {
    composing = false;
    const v = vditor?.getValue() || '';
    emit('update:modelValue', restoreIngestComments(markdownLinksToWiki(v)));
  });
  el.addEventListener('contextmenu', handleEditorContextMenu, true);
  // 监听 edit-mode 切换（Vditor 内部 setEditMode 改 currentMode 但无事件，轮询 DOM class）
  observeEditMode();
}

function captureEditorSelection() {
  savedSelectionText = vditor?.getSelection() || '';
  savedSelectionRange = null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !vditorEl.value) return;
  const range = selection.getRangeAt(0);
  if (!vditorEl.value.contains(range.commonAncestorContainer)) return;
  savedSelectionRange = range.cloneRange();
}

function restoreEditorSelection() {
  const range = savedSelectionRange;
  if (!range) {
    vditor?.focus();
    return;
  }
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  start?.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function handleEditorContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest('.vditor-toolbar, .vditor-panel, .link-popup')) return;
  event.preventDefault();
  captureEditorSelection();
  emit('context-menu', {
    x: event.clientX,
    y: event.clientY,
    selection: savedSelectionText.trim(),
  });
}

function openEditorLink(element: Element) {
  const href = element.getAttribute('href') || element.textContent?.trim() || '';
  const title = wikiTargetFromHref(href);
  if (title) {
    emit('open-wikilink', title);
    return;
  }
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

function justTypedDoubleBracket(): boolean {
  const sel = window.getSelection();
  if (!sel?.anchorNode?.textContent) return false;
  const text = sel.anchorNode.textContent.slice(0, sel.anchorOffset);
  return text.endsWith('[[');
}

/** 获取光标处的 [[wikilink]] 标题 */
function wikilinkAtCursor(): string | null {
  const sel = window.getSelection();
  if (!sel?.anchorNode?.textContent) return null;
  const anchorElement = sel.anchorNode instanceof Element
    ? sel.anchorNode
    : sel.anchorNode.parentElement;
  const link = anchorElement?.closest<HTMLAnchorElement>('a[href]');
  const linkedTitle = wikiTargetFromHref(link?.getAttribute('href') || '');
  if (linkedTitle) return linkedTitle;

  const text = sel.anchorNode.textContent;
  const offset = sel.anchorOffset;
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (offset >= m.index && offset <= m.index + m[0].length) {
      return m[1].split('|')[0].trim();
    }
  }
  return null;
}

function openLinkPopup(removeTrigger = false) {
  if (removeTrigger) {
    document.execCommand('delete');
    document.execCommand('delete');
  }
  linkPopup.value = true;
  linkQuery.value = '';
  searchLinks();
  setTimeout(() => linkInputEl.value?.focus(), 50);
}

async function searchLinks() {
  const { data } = await api.get('/api/pages/suggest', { params: { q: linkQuery.value } });
  suggestions.value = data.suggestions;
}

function insertLink(title: string) {
  if (!title) return;
  userInputPending = true;
  vditor?.insertValue(markdownWikiLink(title));
  vditor?.focus();
  linkPopup.value = false;
}

// ---------- 对外接口 ----------

function getSelectionText(): string {
  return vditor?.getSelection() || '';
}
function insertText(text: string) {
  userInputPending = true;
  vditor?.insertValue(wikiLinksToMarkdown(text));
  vditor?.focus();
}
function getValue(): string {
  return restoreIngestComments(markdownLinksToWiki(vditor?.getValue() || ''));
}
function getCurrentMode(): 'sv' | 'wysiwyg' | 'ir' {
  return vditor?.getCurrentMode() || 'ir';
}
function focus() {
  vditor?.focus();
}

function executeHistoryCommand(command: 'undo' | 'redo'): boolean {
  restoreEditorSelection();
  beginUserEditing();
  const button = vditorEl.value?.querySelector<HTMLButtonElement>(
    `.vditor-toolbar button[data-type="${command}"]`,
  );
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

async function copySelection(): Promise<boolean> {
  if (!savedSelectionText) return false;
  return copyText(savedSelectionText);
}

async function cutSelection(): Promise<boolean> {
  if (!savedSelectionText) return false;
  const copied = await copyText(savedSelectionText);
  restoreEditorSelection();
  beginUserEditing();
  userInputPending = true;
  document.execCommand('delete');
  return copied;
}

async function pasteClipboard(): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard?.readText) return false;
  const text = await navigator.clipboard.readText();
  restoreEditorSelection();
  beginUserEditing();
  userInputPending = true;
  vditor?.insertValue(wikiLinksToMarkdown(text));
  return true;
}

function selectAll(): boolean {
  const surface = vditorEl.value?.querySelector<HTMLElement>(
    '.vditor-ir [contenteditable="true"], .vditor-sv [contenteditable="true"], .vditor-wysiwyg [contenteditable="true"]',
  );
  surface?.focus({ preventScroll: true });
  return document.execCommand('selectAll');
}

watch(
  () => props.modelValue,
  (v) => {
    if (!ready || !vditor) return;
    const editorValue = stripIngestComments(wikiLinksToMarkdown(v));
    if (editorValue !== vditor.getValue()) {
      syncingModelValue = true;
      vditor.setValue(editorValue);
      lastProgrammaticValue = vditor.getValue();
      releaseModelSyncSoon();
      scheduleHideManagedPlaceholders();
    } else {
      lastProgrammaticValue = editorValue;
    }
  }
);
watch(
  () => props.dark,
  (d) => {
    if (!ready) return;
    vditor?.setTheme(d ? 'dark' : 'classic', d ? 'dark' : 'light');
  }
);
// 父组件传入模式变化（切换页面后恢复持久化模式）
watch(
  () => props.mode,
  (m) => {
    if (!ready || !vditor || !m) return;
    const cur = vditor.getCurrentMode();
    if (cur !== m) {
      // 通过点击 edit-mode 下拉里对应按钮切换（Vditor 无公开 changeMode API）
      const btn = vditorEl.value?.querySelector<HTMLElement>(`button[data-mode="${m}"]`);
      btn?.click();
    }
  }
);
onUnmounted(() => {
  if (modelSyncReleaseTimer) clearTimeout(modelSyncReleaseTimer);
  if (placeholderHideTimer) clearTimeout(placeholderHideTimer);
  modeObserver?.disconnect();
  vditor?.destroy();
});

defineExpose({
  getSelectionText,
  insertText,
  getValue,
  getCurrentMode,
  focus,
  undo: () => executeHistoryCommand('undo'),
  redo: () => executeHistoryCommand('redo'),
  cutSelection,
  copySelection,
  pasteClipboard,
  selectAll,
});
onMounted(init);
</script>

<style scoped>
.editor-wrap {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.vditor-host { flex: 1; min-height: 0; }
.vditor-host :deep(.managed-placeholder),
.vditor-host :deep(a[href^="#ingest-preserved-"]),
.vditor-host :deep(p:has(a[href^="#ingest-preserved-"])) {
  display: none !important;
}
:deep(.vditor-toolbar) {
  border-bottom: 1px solid var(--border);
  /* 阅读按钮右对齐到工具栏最右端 */
  & .vditor-tooltipped[data-type="reading"] {
    margin-left: auto;
  }
}
/* 隐藏 edit-mode 下拉里的 wysiwyg 选项（即时渲染已覆盖所见即所得场景，只保留源码+即时渲染两态） */
:deep(.vditor-toolbar button[data-mode="wysiwyg"]) { display: none !important; }
/* 手机端压缩工具栏按钮内边距，保证精简后的按钮单行放下 */
@media (max-width: 768px) {
  :deep(.vditor-toolbar) { padding: 0 4px !important; }
  :deep(.vditor-toolbar .vditor-toolbar__item) { padding: 0 2px !important; }
  :deep(.vditor-toolbar button) { padding: 0 3px !important; }
  :deep(.vditor-toolbar .vditor-splitter) { margin: 0 2px !important; }
}
:deep(.vditor-ir), :deep(.vditor-wysiwyg), :deep(.vditor-sv) {
  background: var(--bg);
  color: var(--text);
}
:deep(a[href^="#wiki/"]) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
  text-decoration: none;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
:deep(a[href^="#wiki/"]:hover) {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.link-popup {
  position: absolute;
  top: 52px;
  left: 24px;
  z-index: var(--z-popup);
  width: min(340px, calc(100vw - 48px));
  padding: 8px;
  box-shadow: var(--shadow);
}
.link-popup input { width: 100%; }
.link-list { margin-top: 6px; max-height: 220px; overflow-y: auto; }
.link-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}
.link-item:hover { background: var(--bg-hover); }
</style>
