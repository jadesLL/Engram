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
const linkInputEl = ref<HTMLInputElement>();
const linkPopup = ref(false);
const linkQuery = ref('');
const suggestions = ref<any[]>([]);

let vditor: Vditor | null = null;
let ready = false;

function init() {
  vditor = new Vditor(vditorEl.value!, {
    mode: 'ir',
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
      '|', 'undo', 'redo', '|', 'edit-mode', 'preview', 'fullscreen', 'outline',
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
    input: (v) => emit('update:modelValue', markdownLinksToWiki(v)),
    after: () => {
      ready = true;
      bindKeys();
    },
  });
}

function bindKeys() {
  const el = vditorEl.value!;
  el.addEventListener('keydown', (e: KeyboardEvent) => {
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
  // 输入 [[ 时自动弹出补全
  el.addEventListener('keyup', (e: KeyboardEvent) => {
    if (e.key === '[' && justTypedDoubleBracket()) openLinkPopup(true);
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

/** 供父组件调用 */
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
  }
);

defineExpose({ getSelectionText, insertText, getValue });
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
:deep(.vditor-toolbar) { border-bottom: 1px solid var(--border); }
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
</style>
