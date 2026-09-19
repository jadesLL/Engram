<template>
  <div ref="wrapEl" class="editor-wrap">
    <div ref="vditorEl" class="vditor-host" />

    <!-- 双链插入弹窗（跟随光标，↑↓ 选择） -->
    <div
      v-if="linkPopup"
      class="link-popup card"
      :style="{ top: linkPos.top + 'px', left: linkPos.left + 'px' }"
      @keydown.stop
    >
      <input
        ref="linkInputEl"
        v-model="linkQuery"
        placeholder="输入页面标题，回车插入双链"
        @input="searchLinks"
        @keydown.down.prevent="moveLinkSelection(1)"
        @keydown.up.prevent="moveLinkSelection(-1)"
        @keydown.enter.prevent="confirmLinkSelection"
        @keydown.esc="linkPopup = false"
      />
      <div v-if="suggestions.length" class="link-list">
        <div
          v-for="(s, i) in suggestions"
          :key="s.id"
          class="link-item"
          :class="{ sel: i === activeLinkIndex }"
          @click="insertLink(s.title)"
          @mouseenter="activeLinkIndex = i"
        >
          📄 {{ s.title }} <span class="faint small">{{ s.path }}</span>
        </div>
      </div>
      <div class="link-popup-foot faint">
        <span><kbd>↑↓</kbd> 选择</span>
        <span><kbd>⏎</kbd> 插入</span>
        <span><kbd>esc</kbd> 关闭</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch } from 'vue';
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

const wrapEl = ref<HTMLElement>();
const vditorEl = ref<HTMLElement>();
const linkInputEl = ref<HTMLInputElement>();
const linkPopup = ref(false);
const linkQuery = ref('');
const suggestions = ref<any[]>([]);
const linkPos = ref({ top: 52, left: 24 });
const activeLinkIndex = ref(0);

let vditor: Vditor | null = null;
let ready = false;
let composing = false; // IME 组字状态（wysiwyg 下 input 走防抖，组字期间不 emit 防丢字）
let syncingModelValue = true;
let lastProgrammaticValue = '';
let userInputPending = false;
let modelSyncReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let placeholderHideTimer: ReturnType<typeof setTimeout> | null = null;
let modeObserver: MutationObserver | null = null;
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
  modeObserver = new MutationObserver(() => {
    if (!vditor) return;
    const cur = vditor.getCurrentMode();
    if (cur !== last && (cur === 'ir' || cur === 'sv')) {
      last = cur;
      emit('mode-change', cur);
    }
  });
  modeObserver.observe(vditorEl.value, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-mode'],
  });
}

/* ---------- 统一工具栏图标（描边 1.9 lucide 风，与应用 Icon.vue 同源） ----------
 * Vditor 内置按钮自带 svg sprite，初始化后按 data-type 整枚替换，行为不变。 */
const TOOLBAR_ICONS: Record<string, string[]> = {
  headings: ['M6 4v16', 'M18 4v16', 'M6 12h12'],
  bold: ['M14 12a4 4 0 0 0 0-8H6v8', 'M15 20a4 4 0 0 0 0-8H6v8'],
  italic: ['M19 4h-9', 'M14 20H5', 'M15 4 9 20'],
  strike: ['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16'],
  quote: [
    'M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4',
    'M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4',
  ],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  'ordered-list': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
  check: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  'inline-code': ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  code: ['m10 9-2 3 2 3', 'm14 9 2 3-2 3', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
  table: ['M12 3v18', 'M3 9h18', 'M3 15h18', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  redo: ['M21 7v6h-6', 'M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13'],
  'edit-mode': ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  fullscreen: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  outline: ['M21 12h-8', 'M21 6H8', 'M21 18h-8', 'M3 6v4c0 1.1.9 2 2 2h3', 'M3 10v6c0 1.1.9 2 2 2h3'],
};

function toolbarIconSvg(paths: string[]): string {
  const body = paths.map((d) => `<path d="${d}"/>`).join('');
  return `<svg class="eg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function overrideToolbarIcons() {
  if (!vditorEl.value) return;
  for (const [type, paths] of Object.entries(TOOLBAR_ICONS)) {
    const svg = vditorEl.value
      .querySelector(`.vditor-toolbar button[data-type="${type}"]`)
      ?.querySelector('svg');
    if (!svg) continue;
    /* Vditor 样式表对工具栏 svg 写了 fill: currentColor，会盖掉表现属性
     * fill="none"，使描边图标被填充成实心块；加 eg-icon class 用 CSS 压回去 */
    svg.classList.add('eg-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = paths.map((d) => `<path d="${d}"/>`).join('');
  }
}

const wikilinkToolbarItem = {
  name: 'wikilink',
  tip: '插入双链 [[页面]]',
  icon: toolbarIconSvg(['M9 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2', 'M15 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2', 'M9.5 12h5']),
  click: () => openLinkPopup(),
};
const readingToolbarItem = {
  name: 'reading',
  tip: '沉浸阅读',
  icon: toolbarIconSvg(['M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z', 'M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z']),
  click: () => emit('enter-reading'),
};
// 手机端精简到一行（390px 视口最多放 10 个按钮），完整工具栏桌面不变
const mobileToolbar = [
  'headings', 'bold', 'italic', 'list', 'ordered-list',
  wikilinkToolbarItem,
  'link', 'undo', 'edit-mode', readingToolbarItem,
];
// UI 2.0：按「格式 / 段落 / 插入 / 历史 / 视图」分组，18 个图标收敛视觉主次
const desktopToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'quote', 'list', 'ordered-list', 'check', '|',
  'inline-code', 'code', 'table', 'link', wikilinkToolbarItem, '|',
  'undo', 'redo', '|',
  'edit-mode', 'fullscreen', 'outline', '|',
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
      overrideToolbarIcons();
      observeWikiLinks();
      bindKeys();
      releaseModelSyncSoon();
      scheduleHideManagedPlaceholders();
    },
  });
}

let wikiTagObserver: MutationObserver | null = null;
let wikiTagRaf = 0;

/** IR 模式下 Vditor 把链接渲染成 span[data-type="a"]（DOM 上无 href 属性），
 * CSS 无法区分双链；通过 marker 文本识别 #wiki/ 目标并打 eg-wikilink class，
 * 虚线下划线样式即可在编辑态生效（预览/阅读态走 a[href^="#wiki/"]） */
function tagWikiLinks() {
  const root = vditorEl.value?.querySelector('.vditor-ir');
  if (!root) return;
  for (const node of root.querySelectorAll('span[data-type="a"]')) {
    const href = node.querySelector('.vditor-ir__marker--link')?.textContent || '';
    node.classList.toggle('eg-wikilink', href.startsWith('#wiki/'));
  }
}

function scheduleTagWikiLinks() {
  if (wikiTagRaf) return;
  wikiTagRaf = requestAnimationFrame(() => {
    wikiTagRaf = 0;
    tagWikiLinks();
  });
}

function observeWikiLinks() {
  const root = vditorEl.value?.querySelector('.vditor-ir');
  if (!root) return;
  tagWikiLinks();
  // IR 每次输入都会重建所在块（childList 变化）；只监听 childList，
  // 打标的 classList.toggle 是属性变更，不会自触发
  wikiTagObserver = new MutationObserver(scheduleTagWikiLinks);
  wikiTagObserver.observe(root, { childList: true, subtree: true });
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

/** 弹窗跟随光标：取 caret 的视口坐标换算到 editor-wrap 内；取不到时回退左上角 */
function positionLinkPopup() {
  const wrap = wrapEl.value;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  let caretRect: DOMRect | null = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    caretRect = rect && (rect.x || rect.y)
      ? rect
      : (range.getClientRects()[0] as DOMRect | undefined) || null;
  }
  if (!caretRect || !vditorEl.value?.contains(sel?.anchorNode || null)) {
    linkPos.value = { top: 52, left: 24 };
    return;
  }
  const popupWidth = Math.min(320, wrapRect.width - 16);
  const left = Math.max(8, Math.min(caretRect.left - wrapRect.left, wrapRect.width - popupWidth - 8));
  linkPos.value = { top: caretRect.bottom - wrapRect.top + 6, left };
}

function openLinkPopup(removeTrigger = false) {
  if (removeTrigger) {
    document.execCommand('delete');
    document.execCommand('delete');
  }
  positionLinkPopup();
  linkPopup.value = true;
  linkQuery.value = '';
  activeLinkIndex.value = 0;
  searchLinks();
  setTimeout(() => linkInputEl.value?.focus(), 50);
}

async function searchLinks() {
  activeLinkIndex.value = 0;
  const { data } = await api.get('/api/pages/suggest', { params: { q: linkQuery.value } });
  suggestions.value = data.suggestions;
}

function moveLinkSelection(delta: number) {
  const count = suggestions.value.length;
  if (!count) return;
  activeLinkIndex.value = (activeLinkIndex.value + delta + count) % count;
  nextTick(() => {
    wrapEl.value
      ?.querySelector('.link-item.sel')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function confirmLinkSelection() {
  const picked = suggestions.value[activeLinkIndex.value] || suggestions.value[0];
  insertLink(picked?.title || linkQuery.value);
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

let pendingHiddenSync = false;

/** 阅读模式下编辑器被 v-show 隐藏：跳过整页重渲染（大页面可省约一半卡顿），恢复显示时由 syncIfPending 补一次。 */
function editorHidden(): boolean {
  return (wrapEl.value?.offsetParent ?? 1) === null;
}

function applyModelValue(v: string) {
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

watch(
  () => props.modelValue,
  (v) => {
    if (!ready || !vditor) return;
    if (editorHidden()) {
      pendingHiddenSync = true;
      return;
    }
    pendingHiddenSync = false;
    applyModelValue(v);
  }
);

function syncIfPending() {
  if (!pendingHiddenSync || editorHidden()) return;
  pendingHiddenSync = false;
  applyModelValue(props.modelValue);
}
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
  if (wikiTagRaf) cancelAnimationFrame(wikiTagRaf);
  wikiTagObserver?.disconnect();
  modeObserver?.disconnect();
  vditor?.destroy();
});

defineExpose({
  getSelectionText,
  insertText,
  getValue,
  getCurrentMode,
  focus,
  syncIfPending,
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

/* ---------- 工具栏换肤：分组气泡按钮，跟随应用设计令牌 ---------- */
/* Vditor 对工具栏 svg 预置 fill: currentColor，我们的描边图标必须压回 fill:none */
:deep(.vditor-toolbar .eg-icon),
:deep(.vditor-toolbar .eg-icon path) {
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.9 !important;
  stroke-linecap: round !important;
  stroke-linejoin: round !important;
}
:deep(.vditor-toolbar) {
  /* 工具栏不带灰色染色：纯白 + 柔和投影浮在正文之上 */
  background: var(--paper-toolbar-bg, transparent);
  border-bottom: none;
  box-shadow: var(--paper-toolbar-shadow);
  position: relative;
  z-index: 2;
  padding: 4px 10px;
  gap: 1px;
  /* 阅读按钮右对齐到工具栏最右端 */
  & .vditor-tooltipped[data-type="reading"] {
    margin-left: auto;
  }
}
:deep(.vditor-toolbar .vditor-toolbar__item) { padding: 0 1px; }
:deep(.vditor-toolbar button) {
  width: 30px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
:deep(.vditor-toolbar button:hover) { background: var(--bg-hover); color: var(--text); }
:deep(.vditor-toolbar button.vditor-menu--current) {
  color: var(--accent);
  background: var(--accent-soft);
}
:deep(.vditor-toolbar .vditor-toolbar__divider) {
  margin: 0 6px;
  height: 16px;
  border-left-color: var(--border-strong);
  opacity: 0.55;
}
/* 双链 / 沉浸阅读作为强调入口 */
:deep(.vditor-toolbar button[data-type="wikilink"]),
:deep(.vditor-toolbar button[data-type="reading"]) { color: var(--accent); }
:deep(.vditor-toolbar button[data-type="wikilink"]:hover),
:deep(.vditor-toolbar button[data-type="reading"]:hover) {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 隐藏 edit-mode 下拉里的 wysiwyg 选项（即时渲染已覆盖所见即所得场景，只保留源码+即时渲染两态） */
:deep(.vditor-toolbar button[data-mode="wysiwyg"]) { display: none !important; }
/* edit-mode 下拉等 .vditor-hint 面板挂在工具栏 DOM 内，上面的按钮皮肤会污染面板项，恢复 vditor 原生布局 */
:deep(.vditor-toolbar .vditor-hint button) {
  display: block;
  width: 100%;
  height: auto;
  padding: 3px 10px;
  border-radius: 0;
  text-align: left;
  line-height: 20px;
  white-space: nowrap;
  color: var(--toolbar-icon-color, var(--text));
}
:deep(.vditor-toolbar .vditor-hint button:hover) {
  background: var(--bg-hover);
  color: var(--text);
}
/* 桌面端无边框窗口顶部 36px 是标题栏拖拽区（几何判定不看 z-index），全屏编辑器必须避开，否则工具栏点击被窗口拖拽吞掉 */
:deep(.vditor--fullscreen) {
  top: var(--win-titlebar-h, 0px);
  height: calc(100vh - var(--win-titlebar-h, 0px)) !important;
}
/* 手机端压缩工具栏按钮内边距，保证精简后的按钮单行放下 */
@media (max-width: 768px) {
  :deep(.vditor-toolbar) { padding: 4px !important; }
  :deep(.vditor-toolbar .vditor-toolbar__item) { padding: 0 !important; }
  :deep(.vditor-toolbar button) { width: 28px; }
  :deep(.vditor-toolbar .vditor-toolbar__divider) { margin: 0 3px !important; }
}

:deep(.vditor-ir), :deep(.vditor-wysiwyg), :deep(.vditor-sv) {
  background: var(--paper-bg, var(--bg));
  color: var(--text);
}
/* 双链：虚线下划线柔和样式（替代刺眼的实色块） */
:deep(a[href^="#wiki/"]) {
  color: var(--accent);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
  border-radius: 3px;
  padding: 0 1px;
}
:deep(a[href^="#wiki/"]:hover) {
  background: var(--accent-soft);
  text-decoration-style: solid;
}
/* IR 编辑态：双链节点由 observeWikiLinks 打 eg-wikilink class（Vditor 不输出 href） */
:deep(.vditor-ir__node.eg-wikilink .vditor-ir__link) {
  color: var(--accent);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
  border-radius: 3px;
}
:deep(.vditor-ir__node.eg-wikilink:hover .vditor-ir__link) {
  background: var(--accent-soft);
  text-decoration-style: solid;
}
.link-popup {
  position: absolute;
  top: 52px;
  left: 24px;
  z-index: var(--z-popup);
  width: min(320px, calc(100vw - 48px));
  padding: 8px;
  box-shadow: var(--shadow);
}
.link-popup input { width: 100%; }
.link-list { margin-top: 6px; max-height: 220px; overflow-y: auto; }
.link-item {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.link-item .faint { margin-left: auto; font-size: 11px; }
.link-item:hover { background: var(--bg-hover); }
.link-item.sel,
.link-item.sel:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.link-popup-foot {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  padding: 6px 8px 1px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
.link-popup-foot kbd {
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  font-family: inherit;
  font-size: 10.5px;
}
</style>
