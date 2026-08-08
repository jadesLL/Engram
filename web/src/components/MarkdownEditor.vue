<template>
  <div class="editor-wrap">
    <div ref="vditorEl" class="vditor-host" />

    <!-- HTML 预览叠加层（美化后的只读渲染） -->
    <!-- 返回按钮是叠加层的兄弟元素，不能用子元素：Vditor.preview() 会 innerHTML= 清空容器 -->
    <button
      v-if="htmlPreview"
      class="html-preview-exit"
      title="返回编辑（Esc）"
      @click="toggleHtmlPreview()"
    >
      ✕ 返回编辑
    </button>
    <div
      v-if="htmlPreview"
      class="html-preview-overlay"
      ref="htmlPreviewEl"
      tabindex="0"
      @keydown.esc="toggleHtmlPreview()"
    />

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
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '../api';
import {
  markdownLinksToWiki,
  markdownWikiLink,
  wikiLinksToMarkdown,
  wikiTargetFromHref,
} from '../lib/wikiLinks';

const props = defineProps<{ modelValue: string; dark: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'ai-action', action: string, text: string): void;
  (e: 'open-wikilink', title: string): void;
}>();

const vditorEl = ref<HTMLElement>();
const htmlPreviewEl = ref<HTMLElement>();
const linkInputEl = ref<HTMLInputElement>();
const linkPopup = ref(false);
const linkQuery = ref('');
const suggestions = ref<any[]>([]);
const htmlPreview = ref(false);

let vditor: Vditor | null = null;
let ready = false;
let composing = false; // IME 组字状态（wysiwyg 下 input 走防抖，组字期间不 emit 防丢字）

function init() {
  vditor = new Vditor(vditorEl.value!, {
    mode: 'wysiwyg',
    height: '100%',
    cache: { enable: false },
    theme: props.dark ? 'dark' : 'classic',
    value: wikiLinksToMarkdown(props.modelValue),
    placeholder: '开始书写… 输入 [[ 插入双链，Ctrl+S 保存',
    link: {
      isOpen: false,
      click: openEditorLink,
    },
    toolbar: [
      'headings', 'bold', 'italic', 'strike', 'quote', 'list', 'ordered-list', 'code', 'inline-code',
      'table', 'link', '|',
      {
        name: 'wikilink',
        tip: '插入双链 [[页面]]',
        icon: '🔗',
        click: () => openLinkPopup(),
      },
      '|', 'undo', 'redo', '|', 'edit-mode', 'fullscreen', 'outline', '|',
      {
        name: 'html',
        tip: 'HTML 预览（再点返回编辑）',
        icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 4l2 16M20 4l-2 16M4 9h12M4 15h12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
        click: () => toggleHtmlPreview(),
      },
    ],
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
      if (composing) return;
      emit('update:modelValue', markdownLinksToWiki(v));
    },
    after: () => {
      ready = true;
      bindKeys();
    },
  });
}

function bindKeys() {
  const el = vditorEl.value!;
  el.addEventListener('keydown', (e: KeyboardEvent) => {
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
      emit('update:modelValue', markdownLinksToWiki(v));
    }
    if (e.key === '[' && justTypedDoubleBracket()) openLinkPopup(true);
  });
  // compositionstart/end 兜底（部分 IME 不触发 isComposing）
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => {
    composing = false;
    const v = vditor?.getValue() || '';
    emit('update:modelValue', markdownLinksToWiki(v));
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
  vditor?.insertValue(markdownWikiLink(title));
  vditor?.focus();
  linkPopup.value = false;
}

// ---------- HTML 预览 ----------

async function toggleHtmlPreview() {
  if (!htmlPreview.value) {
    htmlPreview.value = true;
    await nextTick();
    await renderHtmlPreview();
  } else {
    htmlPreview.value = false;
    nextTick(() => vditor?.focus());
  }
}

async function renderHtmlPreview() {
  const el = htmlPreviewEl.value;
  if (!el || !vditor) return;
  const md = wikiLinksToMarkdown(getValue());
  await Vditor.preview(el, md, {
    mode: props.dark ? 'dark' : 'light',
  });
  applyHeadingNumbers(el);
  applyListMarkers(el);
}

/** 为 h1-h3 计算章节号，写入 data-md-num（CSS 用 attr() 显示渐变色编号） */
function applyHeadingNumbers(root: HTMLElement) {
  const counters = [0, 0, 0, 0, 0, 0];
  for (const child of Array.from(root.children)) {
    const el = child as HTMLElement;
    const level = headingLevel(el);
    if (level === 0 || level > 3) continue;
    counters[level - 1]++;
    for (let k = level; k < 6; k++) counters[k] = 0;
    let start = 0;
    while (start < level - 1 && counters[start] === 0) start++;
    el.setAttribute('data-md-num', counters.slice(start, level).join('.') + '.');
  }
}

function headingLevel(el: HTMLElement): number {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m ? parseInt(m[1], 10) : 0;
}

/** 为无序列表注入圆点标记 span（实心/空心/方块按层级） */
function applyListMarkers(container: HTMLElement) {
  for (const ul of Array.from(container.querySelectorAll('ul:not(.contains-task-list)'))) {
    const level = Math.min(listDepth(ul, 'UL'), 3);
    for (const li of Array.from(ul.children)) {
      if (!(li instanceof HTMLElement) || li.tagName !== 'LI') continue;
      const marker = document.createElement('span');
      marker.className = `mdht-ul-marker mdht-ul-l${level}`;
      prependMarker(li, marker);
    }
  }
  for (const ol of Array.from(container.querySelectorAll('ol:not(.contains-task-list)'))) {
    const level = Math.min(listDepth(ol, 'OL'), 3);
    const start = parseInt(ol.getAttribute('start') ?? '1', 10) || 1;
    let index = start;
    for (const li of Array.from(ol.children)) {
      if (!(li instanceof HTMLElement) || li.tagName !== 'LI') continue;
      const badge = document.createElement('span');
      badge.className = `mdht-ol-marker mdht-ol-l${level}`;
      const num = document.createElement('span');
      num.className = 'mdht-ol-num';
      num.textContent = String(index);
      badge.appendChild(num);
      prependMarker(li, badge);
      index++;
    }
  }
}

function listDepth(list: Element, tag: 'UL' | 'OL'): number {
  let depth = 1;
  let node = list.parentElement;
  while (node) {
    if (node.tagName === tag) depth++;
    node = node.parentElement;
  }
  return depth;
}

function prependMarker(li: HTMLElement, marker: HTMLElement) {
  li.insertBefore(marker, li.firstChild);
}

// ---------- 对外接口 ----------

function getSelectionText(): string {
  return vditor?.getSelection() || '';
}
function insertText(text: string) {
  vditor?.insertValue(wikiLinksToMarkdown(text));
  vditor?.focus();
}
function getValue(): string {
  return markdownLinksToWiki(vditor?.getValue() || '');
}
function getCurrentMode(): 'sv' | 'wysiwyg' | 'ir' {
  return vditor?.getCurrentMode() || 'wysiwyg';
}

watch(
  () => props.modelValue,
  (v) => {
    if (!ready || !vditor) return;
    const editorValue = wikiLinksToMarkdown(v);
    if (editorValue !== vditor.getValue()) vditor.setValue(editorValue);
  }
);
watch(
  () => props.dark,
  (d) => {
    if (!ready) return;
    vditor?.setTheme(d ? 'dark' : 'classic', d ? 'dark' : 'light');
    if (htmlPreview.value) renderHtmlPreview();
  }
);

defineExpose({ getSelectionText, insertText, getValue, getCurrentMode, toggleHtmlPreview });
onMounted(init);
onUnmounted(() => vditor?.destroy());
</script>

<style scoped>
.editor-wrap {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.vditor-host { flex: 1; min-height: 0; }
:deep(.vditor-toolbar) {
  border-bottom: 1px solid var(--border);
  /* HTML 预览按钮右对齐到工具栏最右端 */
  & .vditor-tooltipped[data-type="html"] {
    margin-left: auto;
  }
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
  z-index: 60;
  width: 340px;
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
}
.link-item:hover { background: var(--bg-hover); }

/* HTML 预览的「返回编辑」按钮（叠加层兄弟元素，绝对定位浮在右上角） */
.html-preview-exit {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  box-shadow: var(--shadow);
  cursor: pointer;
  transition: all 0.15s;
}
.html-preview-exit:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
