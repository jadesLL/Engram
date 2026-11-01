<template>
  <div ref="wrapEl" class="editor-wrap">
    <div ref="vditorEl" class="vditor-host" />

    <!-- 表格增删行列：光标落进表格时浮在表格上方（ir 是真实 DOM 表，sv 是源码块） -->
    <EditorTableBar
      v-if="tableBar"
      ref="tableBarRef"
      :top="tableBar.top"
      :left="tableBar.left"
      :row="tableBar.row"
      @action="applyTableAction"
      @more="openTableMore"
    />

    <!-- 手机档选中文字浮动格式条：fixed 视口坐标 + translate(-50%,-100%) 贴在选区上方，
         不放得下就翻到选区下方；点空白 / 滚动 / 选区消失都会收起（见 bindSelectionTools）。
         按钮一律 mousedown.prevent：保住选区再执行命令，点按钮不会把选中弄丢。 -->
    <div
      v-if="selectionBar"
      ref="selectionBarEl"
      class="sel-bar"
      :class="{ 'is-below': selectionBar.below }"
      :style="{ top: selectionBar.top + 'px', left: selectionBar.left + 'px' }"
      role="toolbar"
      aria-label="选中文字格式"
      @mousedown.prevent
    >
      <button type="button" class="sel-btn sel-bold" aria-label="加粗" @click="runSelectionAction('bold')">B</button>
      <button type="button" class="sel-btn sel-italic" aria-label="斜体" @click="runSelectionAction('italic')">I</button>
      <button type="button" class="sel-btn" aria-label="高亮" @click="runSelectionAction('highlight')">
        <Icon name="lightbulb" :size="19" />
      </button>
      <span class="sel-div" aria-hidden="true" />
      <button type="button" class="sel-btn" aria-label="插入链接" @click="runSelectionAction('link')">
        <Icon name="link" :size="19" />
      </button>
      <button type="button" class="sel-btn" aria-label="复制选中文字" @click="runSelectionAction('copy')">
        <Icon name="copy" :size="18" />
      </button>
      <span class="sel-div" aria-hidden="true" />
      <button type="button" class="sel-btn" aria-label="更多格式" @click="runSelectionAction('more')">
        <Icon name="more" :size="20" />
      </button>
    </div>

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

    <!-- 手机档工具栏尾部「插入」打开的分组底部面板：遮罩 + 抓柄 + 22px 顶圆角 + 44px 行高。
         动作全部落到 Vditor 自己的插入/面板上（insertValue / 链接面板 / 双链弹窗），不另造编辑器状态。 -->
    <Teleport to="body">
      <template v-if="insertOpen">
        <div class="insert-mask" @click="closeInsertPanel()" />
        <section
          ref="insertSheetRef"
          class="insert-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="插入"
          tabindex="-1"
          @keydown="onInsertSheetKeydown"
        >
          <span class="insert-grab" aria-hidden="true" />
          <header class="insert-head">
            <h2>插入</h2>
            <button type="button" class="insert-x" aria-label="关闭插入面板" @click="closeInsertPanel()">
              <Icon name="x" :size="16" />
            </button>
          </header>
          <p class="insert-sub">选中的内容会插入到光标位置</p>
          <div class="insert-body">
            <section v-for="group in INSERT_GROUPS" :key="group.label" class="insert-group">
              <h3 class="insert-group-title">{{ group.label }}</h3>
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="insert-row"
                :disabled="Boolean(insertBusy)"
                @click="runInsertAction(item.key)"
              >
                <span class="insert-row-icon"><Icon :name="item.icon" :size="18" /></span>
                <span class="insert-row-text">
                  <b>{{ item.label }}</b>
                  <small>{{ insertBusy === item.key ? '处理中…' : item.hint }}</small>
                </span>
                <Icon name="chevron-right" :size="15" class="insert-row-chevron" />
              </button>
            </section>
          </div>
        </section>
      </template>
    </Teleport>

    <!-- 通用「更多操作」底部面板：表格整表操作（上方/下方插行、左右插列、删行删列、删整表）
         与选中文字的更多格式（删除线 / 行内代码 / 引用 / 复制 / 全选）。
         只从手机档入口打开，样式复用上面的 insert-sheet 一套（遮罩 + 抓柄 + 22px 圆角 + 44px 行）。 -->
    <Teleport to="body">
      <template v-if="actionsSheet">
        <div class="insert-mask" @click="closeActionsSheet()" />
        <section
          ref="actionsSheetRef"
          class="insert-sheet"
          role="dialog"
          aria-modal="true"
          :aria-label="actionsSheetTitle"
          tabindex="-1"
          @keydown="onActionsSheetKeydown"
        >
          <span class="insert-grab" aria-hidden="true" />
          <header class="insert-head">
            <h2>{{ actionsSheetTitle }}</h2>
            <button type="button" class="insert-x" aria-label="关闭面板" @click="closeActionsSheet()">
              <Icon name="x" :size="16" />
            </button>
          </header>
          <p class="insert-sub">{{ actionsSheetSub }}</p>
          <div class="insert-body">
            <section v-for="group in actionsSheetGroups" :key="group.label" class="insert-group">
              <h3 class="insert-group-title">{{ group.label }}</h3>
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="insert-row"
                :disabled="item.disabled"
                @click="runActionsSheetAction(item.key)"
              >
                <span class="insert-row-icon"><Icon :name="item.icon" :size="18" /></span>
                <span class="insert-row-text">
                  <b>{{ item.label }}</b>
                  <small>{{ item.hint }}</small>
                </span>
                <Icon name="chevron-right" :size="15" class="insert-row-chevron" />
              </button>
            </section>
          </div>
        </section>
      </template>
    </Teleport>

    <!-- 两个隐藏的原生文件选择器：图片走页面资产上传，文件走原始资料上传 -->
    <input ref="insertImageInput" class="insert-file-input" type="file" accept="image/*" @change="onInsertImagePicked" />
    <input ref="insertFileInput" class="insert-file-input" type="file" @change="onInsertFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch, type ComponentPublicInstance } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '../api';
import { registerBackHandler } from '../lib/androidBack';
import { BP_MOBILE } from '../lib/layoutBreakpoints';
import { notify } from '../lib/notify';
import EditorTableBar from './EditorTableBar.vue';
import Icon from './Icon.vue';
import { VDITOR_CDN } from '../lib/vditorPreview';
import {
  cellStartOffset,
  columnIndexAt,
  findTableBlocks,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  replaceTableBlock,
  serializeTable,
  splitTableRow,
  tableColumnCount,
  tablePrefix,
  tableRowCount,
  type MarkdownTable,
  type TableEditAction,
} from '../lib/markdownTable';
import { createEditorModelSync } from '../lib/editorModelSync';
import { decideModelSync, stableEditorMarkdown } from '../lib/editorComposition';
import {
  copyText,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import { bindDelegatedTooltips } from '../directives/tooltip';
import {
  markdownLinksToWiki,
  markdownWikiLink,
  wikiLinksToMarkdown,
  wikiTargetFromHref,
} from '../lib/wikiLinks';

const props = defineProps<{
  modelValue: string;
  dark: boolean;
  mode?: 'ir' | 'sv';
  /** 当前页面的 id：粘贴/拖入的图片会存成这个页面的私有资产（见 lib/pageAssets.ts） */
  pageId?: string;
  /** 全屏编辑状态：由父级持有（要连同页头/状态栏一起让位），这里只负责图标与提示 */
  fullscreen?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'ai-action', action: string, text: string): void;
  (e: 'open-wikilink', title: string): void;
  (e: 'mode-change', mode: 'ir' | 'sv'): void;
  (e: 'enter-reading'): void;
  (e: 'toggle-fullscreen'): void;
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

/* 手机档「插入」底部面板：面板本身是 Teleport 到 body 的弹层，状态留在编辑器里 */
const mobileViewport = window.matchMedia('(max-width: ' + BP_MOBILE + 'px)');
const insertOpen = ref(false);
const insertSheetRef = ref<HTMLElement>();
const insertImageInput = ref<HTMLInputElement>();
const insertFileInput = ref<HTMLInputElement>();
/** 正在上传的动作 key（'image' / 'file'）：上传期间禁掉面板里的其它动作 */
const insertBusy = ref('');
/** 安卓返回键：插入面板 / 更多面板开着时先关面板 */
let unregisterInsertBack: (() => void) | null = null;

/* ---------- 手机档：选中文字浮动格式条 ----------
 * 选区非空且落在编辑器内时，在选区上方（放不下则下方）浮出 加粗 / 斜体 / 高亮 / 链接 / 复制 / 更多。
 * 位置用视口坐标（fixed + translate），点空白、滚动、选区消失都会收起；按钮 mousedown.prevent 保住选区。 */
const selectionBar = ref<{ top: number; left: number; below: boolean } | null>(null);
const selectionBarEl = ref<HTMLElement>();
/** 浮条弹出时记下的选区/文本：点按钮时先把选区放回去再执行命令 */
let selectionBarText = '';
let selectionBarFrame = 0;
let selectionToolsBound = false;

/* ---------- 手机档：通用「更多操作」面板（表格整表操作 / 选中文字更多格式） ---------- */
type TableSheetAction = TableEditAction | 'table-remove';
type SelectionSheetAction = 'strike' | 'inline-code' | 'quote' | 'copy' | 'select-all';
const actionsSheet = ref<'table' | 'selection' | null>(null);
const actionsSheetRef = ref<HTMLElement>();
/** 打开面板那一刻的表格目标：面板抢走焦点后 selectionchange 会清掉 tableTarget */
const tableSheetTarget = ref<TableTarget | null>(null);

let vditor: Vditor | null = null;
let ready = false;
let composing = false; // IME 组字状态（组字期间 Vditor 活值含未提交拼音：不 emit、不重建、不保存）
let syncingModelValue = true;
let lastProgrammaticValue = '';
/** 最近一次稳定（非组字）的编辑器原始 Markdown（编辑器内部形态，未做 wiki 转换） */
let committedMarkdown = '';
let userInputPending = false;
let modelSyncReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let placeholderHideTimer: ReturnType<typeof setTimeout> | null = null;
let modeObserver: MutationObserver | null = null;
let savedSelectionRange: Range | null = null;
/** 最近一次 pointerdown 的视口坐标：用来区分「拖选结束的那次 click」和普通单击 */
let pointerDownAt: { x: number; y: number } | null = null;
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

/** 编辑器里「稳定可当正文」的原始 Markdown：组字期间取最近一次稳定快照，不把未提交拼音算进去。 */
function stableEditorValue(): string {
  return stableEditorMarkdown(composing, vditor?.getValue() || '', committedMarkdown);
}

/** 同步比较键：双链的百分号转义差异、AI 管理注释占位都不算正文差异，避免父级回显被误判成
 *  「外部改动」而 setValue 重排整个编辑器（那会打断组字、把光标甩走）。
 *  没有双链的文档走轻量比较（绝大多数输入路径），不额外做一遍全文双链转换。 */
function syncKey(md: string): string {
  if (!md.includes('#wiki/') && !md.includes('[[')) return comparableMarkdown(md);
  return comparableMarkdown(markdownLinksToWiki(md));
}

/** 把一次稳定的编辑器原始值同步给父级（v-model）；与模型等价时不 emit，避免无意义脏标记。 */
function emitStableEditorValue(raw: string) {
  committedMarkdown = raw;
  if (!ready || syncingModelValue) return;
  lastProgrammaticValue = raw;
  const nextValue = restoreIngestComments(markdownLinksToWiki(raw));
  if (comparableMarkdown(nextValue) === comparableMarkdown(props.modelValue)) return;
  emit('update:modelValue', nextValue);
}

/** 组字结束（compositionend / keyup 兜底）：一次性同步稳定值，再补判断组字期间被推迟的外部更新。
 *  组字期间任何回显/外部值都不许 setValue（会重建 DOM 打断输入法）；这里等 emit 引发的 watcher
 *  落定后再对一次——自家回显等价则是 no-op，只有父级最终值仍是真正的外部改动才会写入。 */
function finishComposition() {
  if (!composing) return;
  composing = false;
  emitStableEditorValue(vditor?.getValue() || '');
  nextTick(() => {
    if (!ready || composing || !vditor) return;
    applyModelValue(props.modelValue, false);
  });
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
      hideTableBar();
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
  // 自定义项（engram-fullscreen）由 Custom 直接塞进 menuItem.icon，本身已是 eg-icon；
  // 这里只按类型重写内置项的图标路径
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
  // 全屏按钮的提示与图标随状态切换（父级持有状态，这里同步给按钮）
  const fullscreenButton = vditorEl.value.querySelector<HTMLElement>(
    '.vditor-toolbar button[data-type="engram-fullscreen"]'
  );
  if (fullscreenButton) {
    const active = Boolean(props.fullscreen);
    const tip = active ? '退出全屏（Esc）' : '全屏编辑';
    fullscreenButton.setAttribute('aria-label', tip);
    fullscreenButton.classList.toggle('vditor-menu--current', active);
    const paths = active
      ? ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3']
      : TOOLBAR_ICONS.fullscreen;
    const svg = fullscreenButton.querySelector('svg');
    if (svg) svg.innerHTML = paths.map((d) => `<path d="${d}"/>`).join('');
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
/**
 * 全屏编辑：不用 Vditor 内置的 fullscreen 项——它只给 .vditor 加 vditor--fullscreen
 * （fixed + z-index）并锁 body 滚动，而 Engram 的编辑页是扁平布局（页头/工具栏/正文
 * 同层铺在灰底上、编辑器背景透明），加类之后页头仍留在原位，两层内容直接叠在一起。
 * 这里交给父级持有全屏状态，连同页头/状态栏一起让位。
 */
const fullscreenToolbarItem = {
  name: 'engram-fullscreen',
  tip: '全屏编辑',
  icon: toolbarIconSvg(TOOLBAR_ICONS.fullscreen),
  click: () => emit('toggle-fullscreen'),
};
/**
 * 手机档「插入」入口：Vditor 自定义工具栏项（与 readingToolbarItem / fullscreenToolbarItem 同一注册方式）。
 * 只挂在 mobileToolbar 上——桌面工具栏没有这一项，桌面上也就不会出现这个按钮和面板。
 */
const insertToolbarItem = {
  name: 'engram-insert',
  tip: '插入（图片 / 文件 / 表格…）',
  icon: toolbarIconSvg(['M12 5v14', 'M5 12h14']),
  click: () => openInsertPanel(),
};

// 手机端精简到一行（390px 视口最多放 10 个按钮），完整工具栏桌面不变
const mobileToolbar = [
  'headings', 'bold', 'italic', 'list', 'ordered-list',
  wikilinkToolbarItem,
  'link', 'undo', 'edit-mode', readingToolbarItem,
  insertToolbarItem,
];
// UI 2.0 mockup 4.3：按「格式 / 段落 / 插入 / 历史」四段分组；
// 双链、源码切换、全屏、大纲、沉浸阅读是 Engram 专有入口，收在末尾同一段里
const desktopToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'quote', 'list', 'ordered-list', 'check', '|',
  'inline-code', 'code', 'table', 'link', wikilinkToolbarItem, '|',
  'undo', 'redo', '|',
  'edit-mode', fullscreenToolbarItem, 'outline', readingToolbarItem,
];

/**
 * 把 data:base64 内联图落成当前页面的图片资产，返回 /media/... 引用。
 * 失败时原样返回 data URL——宁可正文里留一段 base64，也不要吞掉用户粘贴的图。
 */
async function persistDataUrl(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith('data:image/') || !props.pageId) return dataUrl;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const fd = new FormData();
    fd.append('parent', props.pageId);
    fd.append('files', new File([blob], `粘贴图片.${ext}`, { type: blob.type }));
    const { data } = await api.post('/api/assets/upload', fd);
    return data.saved?.[0]?.url || dataUrl;
  } catch {
    return dataUrl;
  }
}

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
    toolbar: mobileViewport.matches ? mobileToolbar : desktopToolbar,
    toolbarConfig: { pin: true },
    upload: {
      // 图片是当前页面的私有资产：上传时必须带父项页面 id（走 setHeaders，每次上传前重新取，
      // 这样切换页面不用重建编辑器）。裸图上传会被服务端拒绝——图片只能插进某个内容里。
      url: '/api/assets/upload',
      fieldName: 'files',
      multiple: false,
      accept: 'image/*',
      setHeaders: () => ({ 'X-Engram-Parent': props.pageId || '' }),
      format(_files, responseText) {
        let res: any;
        try {
          res = JSON.parse(responseText);
        } catch {
          return JSON.stringify({ msg: '上传失败：服务端返回无法解析', code: 1 });
        }
        const saved = res.saved?.[0];
        if (!saved) {
          return JSON.stringify({ msg: res.error || '上传失败', code: 1 });
        }
        // succMap 的键会被 Vditor 当作图注（alt），去掉内容哈希前缀更干净
        const label = String(saved.name).replace(/^[0-9a-f]{8}-/, '');
        return JSON.stringify({
          msg: '', code: 0,
          data: { errFiles: [], succMap: { [label]: saved.url } },
        });
      },
      // 从 Word / 网页复制的图文里常带 data:base64 内联图：直接落成页面资产，
      // 否则整段 base64 会写进 .md 正文（体积暴涨且不参与同步的图片链路）
      base64ToLink: ((src: string) => persistDataUrl(src)) as unknown as (responseText: string) => string,
    },
    input: (v) => {
      // 组字期间 Vditor 的活值含未提交拼音：等 compositionend 一次性同步，中途不 emit
      if (!ready || composing || syncingModelValue || !userInputPending) return;
      userInputPending = false;
      if (v === lastProgrammaticValue) {
        committedMarkdown = v;
        return;
      }
      emitStableEditorValue(v);
    },
    after: () => {
      ready = true;
      lastProgrammaticValue = vditor?.getValue() || initialValue;
      committedMarkdown = lastProgrammaticValue;
      // Vditor 初始化是异步的：这期间切过页，不能继续显示构造时抓到的旧正文。
      modelSync.setEnvironment(true, !editorHidden());
      overrideToolbarIcons();
      adoptVditorTooltips();
      bindToolbarHintOverlay();
      observeWikiLinks();
      bindKeys();
      bindTableBarEvents();
      bindSelectionTools();
      releaseModelSyncSoon();
      scheduleHideManagedPlaceholders();
    },
  });
}

let wikiTagObserver: MutationObserver | null = null;
let wikiTagRaf = 0;
/** Vditor 工具栏/面板提示的自建替换（Vditor 自带提示不避让，长文案会压住旁边按钮） */
let unbindVditorTooltips: (() => void) | null = null;

/**
 * Vditor 的提示走自带 tooltipped 类（CSS ::after 读 aria-label，固定贴按钮一侧、不做避让），
 * 长文案会直接压住旁边的工具栏按钮。这里统一换成自建提示：
 *  - 文案取按钮上的 aria-label（Vditor 按 tip 写入，全屏按钮的文案随状态更新，取用时现读）；
 *  - 工具栏按钮贴下边（上方是悬浮顶栏与页头，压住更难看），面板/代码块等其余按钮走默认四边避让；
 *  - 自带伪元素提示由样式表关掉（见文件末尾），aria-label 保留给读屏。
 */
function adoptVditorTooltips() {
  if (!vditorEl.value || unbindVditorTooltips) return;
  unbindVditorTooltips = bindDelegatedTooltips(
    vditorEl.value,
    '.vditor-tooltipped[aria-label]',
    (el) => el.getAttribute('aria-label') || '',
    (el) => (el.closest('.vditor-toolbar') ? { placement: 'bottom' } : {}),
  );
}

/* ---------- 手机端工具栏横滚：Vditor 工具栏里的下拉菜单不能被滚动的工具条裁掉 ----------
 * 手机档工具栏改成单行横滚（见文件末尾 max-width 样式）。Vditor 的 .vditor-hint 菜单
 *（标题 H1–H6、编辑模式）是工具栏项里的绝对定位子节点：父级一旦成为横向滚动容器，菜单就会
 * 被 overflow 裁掉——「标题」「编辑模式」两个入口点开看不到选项。
 * 这里只在菜单真正可见时，把它临时改成 position: fixed、贴到所属按钮下方；菜单收起就还原。
 * 结构变化、检测不到菜单时什么都不做，保持 Vditor 原行为。 */
const floatingHints = new Set<HTMLElement>();
let floatingHintRaf = 0;
let floatingHintCleanup: (() => void) | null = null;

/** 菜单当前是否真的显示着：display / visibility / 实际盒都有才算 */
function hintIsOpen(hint: HTMLElement): boolean {
  const style = window.getComputedStyle(hint);
  return style.display !== 'none' && style.visibility !== 'hidden' && hint.getClientRects().length > 0;
}

/** 菜单挂在哪个按钮上：优先工具栏项里的按钮，退回到前一个兄弟按钮 */
function hintAnchor(hint: HTMLElement): HTMLElement | null {
  const item = hint.closest('.vditor-toolbar__item');
  const inItem = item?.querySelector<HTMLElement>('button');
  if (inItem) return inItem;
  const prev = hint.previousElementSibling;
  return prev instanceof HTMLElement && prev.tagName === 'BUTTON' ? prev : null;
}

function resetFloatingHint(hint: HTMLElement) {
  floatingHints.delete(hint);
  hint.classList.remove('eg-hint-floating');
  for (const prop of ['position', 'top', 'left', 'z-index', 'margin']) hint.style.removeProperty(prop);
}

function placeFloatingHints() {
  floatingHintRaf = 0;
  const host = vditorEl.value;
  if (!host) return;
  // 手机档工具栏固定是横向滚动容器（即使按钮刚好放得下，overflow 仍会裁剪绝对定位菜单），
  // 因此只按断点判断是否接管，不要求「此刻真的能滚」。
  const active = window.matchMedia('(max-width: 768px)').matches;
  for (const hint of Array.from(host.querySelectorAll<HTMLElement>('.vditor-toolbar .vditor-hint'))) {
    if (!active || !hintIsOpen(hint)) {
      if (floatingHints.has(hint)) resetFloatingHint(hint);
      continue;
    }
    const anchor = hintAnchor(hint);
    if (!anchor) continue;
    // 只在首次接管时补固定定位；后续只更新坐标，重复写同样的值会自触发下面的 observer
    if (!floatingHints.has(hint)) {
      floatingHints.add(hint);
      hint.classList.add('eg-hint-floating');
      hint.style.setProperty('position', 'fixed');
      hint.style.setProperty('margin', '0');
      hint.style.setProperty('z-index', 'var(--z-popup)');
    }
    // 菜单宽度由内容决定：先切成 fixed 再量，才能把菜单夹在视口内
    const anchorRect = anchor.getBoundingClientRect();
    const width = hint.offsetWidth;
    const height = hint.offsetHeight;
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8));
    let top = anchorRect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchorRect.top - height - 6);
    const nextLeft = `${Math.round(left)}px`;
    const nextTop = `${Math.round(top)}px`;
    if (hint.style.left !== nextLeft) hint.style.setProperty('left', nextLeft);
    if (hint.style.top !== nextTop) hint.style.setProperty('top', nextTop);
  }
}

function scheduleFloatingHints() {
  if (floatingHintRaf) return;
  floatingHintRaf = requestAnimationFrame(placeFloatingHints);
}

/** 菜单显隐由 Vditor 自己的 hover / click / 延迟弹出处理：
 *  用 MutationObserver 盯工具栏里的 class/style 变化（Vditor 靠类名或内联 display 控制显隐），
 *  另外在工具栏滚动、页面滚动与窗口尺寸变化时重算位置（菜单开着时按钮会跟着滚走）。 */
function bindToolbarHintOverlay() {
  if (floatingHintCleanup || !vditorEl.value) return;
  const toolbar = vditorEl.value.querySelector<HTMLElement>('.vditor-toolbar');
  const observer = new MutationObserver(scheduleFloatingHints);
  observer.observe(toolbar ?? vditorEl.value, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  window.addEventListener('scroll', scheduleFloatingHints, true);
  window.addEventListener('resize', scheduleFloatingHints);
  vditorEl.value.addEventListener('scroll', scheduleFloatingHints, true);
  floatingHintCleanup = () => {
    observer.disconnect();
    window.removeEventListener('scroll', scheduleFloatingHints, true);
    window.removeEventListener('resize', scheduleFloatingHints);
    vditorEl.value?.removeEventListener('scroll', scheduleFloatingHints, true);
    if (floatingHintRaf) {
      cancelAnimationFrame(floatingHintRaf);
      floatingHintRaf = 0;
    }
    for (const hint of Array.from(floatingHints)) resetFloatingHint(hint);
    floatingHintCleanup = null;
  };
}

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

/* 表格浮条跟随：光标位置（selectionchange）、正文滚动、窗口尺寸都会改它的落点。
 * selectionchange 触发很密，统一收敛到一个 rAF 里算。 */
function bindTableBarEvents() {
  document.addEventListener('selectionchange', scheduleTableBarSync);
  window.addEventListener('resize', scheduleTableBarSync);
  vditorEl.value?.addEventListener('scroll', scheduleTableBarSync, true);
}

function unbindTableBarEvents() {
  document.removeEventListener('selectionchange', scheduleTableBarSync);
  window.removeEventListener('resize', scheduleTableBarSync);
  vditorEl.value?.removeEventListener('scroll', scheduleTableBarSync, true);
  if (tableBarRaf) {
    cancelAnimationFrame(tableBarRaf);
    tableBarRaf = 0;
  }
}

/** 拖选结束的那次 click 是不是「拖着选的」：单击（没位移）不算，照旧让 Vditor 收拢选区、进入编辑。 */
function draggedSelection(event: MouseEvent): boolean {
  if (!pointerDownAt) return false;
  return Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) >= 4;
}

/** 代码块预览里拖选文字后，Vditor 的 click 处理会把光标重置到源码块开头、选区当场清空——
 *  于是「在代码块里选字」永远选不中（鼠标一松，选区没了，块还被展开成源码态）。捕获阶段
 *  拦下这次 click：选区非空、是拖出来的、且和某个代码块相交时不交给 Vditor，选中的文字
 *  保留、块也不展开，接着就能复制/剪切；单击则保持原行为（收拢选区或进入编辑）。 */
function keepCodeBlockSelection(event: MouseEvent) {
  const root = vditorEl.value;
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.toString().trim()) return;
  if (!draggedSelection(event)) return;
  if (!selection.anchorNode || !root.contains(selection.anchorNode)) return;
  if (selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  let touchesCodeBlock = false;
  for (const block of root.querySelectorAll('.vditor-ir__node[data-type="code-block"]')) {
    try {
      if (range.intersectsNode(block)) { touchesCodeBlock = true; break; }
    } catch {
      /* 选区跨越了不同文档（极少数 iframe 场景）：当作不相交 */
    }
  }
  if (!touchesCodeBlock) return;
  event.preventDefault();
  event.stopPropagation();
}

function bindKeys() {
  const el = vditorEl.value!;
  el.addEventListener('input', (e: Event) => {
    if (e.isTrusted && !syncingModelValue) userInputPending = true;
  }, true);
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    beginUserEditing();
    pointerDownAt = { x: e.clientX, y: e.clientY };
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
  // keyup 兜底（部分 IME 的 compositionend 不冒泡/不触发）：组字结束补一次稳定值同步
  el.addEventListener('keyup', (e: KeyboardEvent) => {
    if (composing && !e.isComposing) finishComposition();
    if (e.key === '[' && justTypedDoubleBracket()) openLinkPopup(true);
  });
  // compositionstart/end 兜底（部分 IME 不触发 isComposing）
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => { finishComposition(); });
  el.addEventListener('contextmenu', handleEditorContextMenu, true);
  // 代码块预览里的拖选要在 mouseup 的 click 之前保住（见 keepCodeBlockSelection）
  el.addEventListener('click', keepCodeBlockSelection, true);
  // 监听 edit-mode 切换（Vditor 内部 setEditMode 改 currentMode 但无事件，轮询 DOM class）
  observeEditMode();
}

/* ---------- 表格增删行列 ----------
 * Vditor 自带的表格面板只挂在被隐藏的 wysiwyg 模式上（引擎里 table popover 只往
 * vditor.wysiwyg.popover 塞按钮），Engram 只开「即时渲染 + 源码」两态，所以行列增删自己接：
 *  - ir：光标在真实 <table> 里，直接改 DOM，再派发一次 input 让 Vditor 归一化并写回
 *    Markdown——不整篇重渲染，撤销栈也记下这一步；
 *  - sv：光标在 [data-type="table"] 的源码块里，改 Markdown 文本后 setValue 回写。
 * 面板只在光标落进表格时浮在表格上方（与 Vditor 自己表格面板的落点一致）。 */

interface IrTableTarget {
  mode: 'ir';
  element: HTMLTableElement;
  row: number;
  column: number;
  rows: number;
  columns: number;
}

interface SourceTableTarget {
  mode: 'sv';
  element: HTMLElement;
  /** 在全文里的第几张表（0 起），回写时用来定位源码块 */
  blockIndex: number;
  row: number;
  column: number;
  rows: number;
  columns: number;
}

type TableTarget = IrTableTarget | SourceTableTarget;

const tableBar = ref<{ top: number; left: number; row: number } | null>(null);
const tableBarRef = ref<ComponentPublicInstance | null>(null);
let tableTarget: TableTarget | null = null;
let tableBarAnchor: { top: number; bottom: number; left: number; caretTop: number; caretBottom: number } | null = null;
let tableBarRaf = 0;

function selectionRangeInEditor(): Range | null {
  const host = vditorEl.value;
  const selection = window.getSelection();
  if (!host || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.commonAncestorContainer)) return null;
  return range;
}

function selectionElement(range: Range): HTMLElement | null {
  const node = range.startContainer;
  if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  return node.parentElement;
}

/** ir：光标所在单元格 → 第几行、第几列 */
function irTableTarget(range: Range): IrTableTarget | null {
  const ir = vditor?.vditor.ir;
  const element = selectionElement(range);
  if (!ir || !element || !ir.element.contains(element)) return null;
  const table = element.closest('table');
  if (!(table instanceof HTMLTableElement) || !ir.element.contains(table)) return null;
  const cell = element.closest('td, th');
  const rowElement = cell?.closest('tr');
  if (!cell || !rowElement) return null;
  const rows = Array.from(table.rows);
  const rowIndex = rows.indexOf(rowElement as HTMLTableRowElement);
  return {
    mode: 'ir',
    element: table,
    row: Math.max(0, rowIndex),
    column: Math.max(0, (cell as HTMLTableCellElement).cellIndex),
    rows: rows.length,
    columns: rows[0]?.cells.length ?? 0,
  };
}

/** sv：光标所在源码块 → 第几张表、第几行、第几列（块文本就是 Markdown 源码） */
function sourceTableTarget(range: Range): SourceTableTarget | null {
  const sv = vditor?.vditor.sv;
  const element = selectionElement(range);
  if (!sv || !element || !sv.element.contains(element)) return null;
  const block = element.closest('[data-type="table"]');
  if (!(block instanceof HTMLElement) || !sv.element.contains(block)) return null;
  const spans = Array.from(sv.element.querySelectorAll<HTMLElement>('[data-type="table"]'));
  const blockIndex = spans.indexOf(block);
  if (blockIndex < 0) return null;
  const lines = (block.textContent || '').replace(/\n+$/, '').split('\n');
  if (lines.length < 2) return null;
  const prefix = tablePrefix(lines[0]) ?? '';
  const columns = splitTableRow(lines[0], prefix).length;
  const rows = lines.length - 1;
  if (!columns || rows < 1) return null;
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const beforeLines = before.toString().split('\n');
  const lineIndex = Math.max(0, beforeLines.length - 1);
  const fullLine = lines[Math.min(lineIndex, lines.length - 1)] ?? '';
  return {
    mode: 'sv',
    element: block,
    blockIndex,
    row: Math.min(Math.max(0, lineIndex - 1), rows - 1),
    column: Math.min(columnIndexAt(fullLine, (beforeLines[lineIndex] || '').length, prefix), columns - 1),
    rows,
    columns,
  };
}

function hideTableBar() {
  tableTarget = null;
  tableBarAnchor = null;
  if (tableBar.value) tableBar.value = null;
}

function placeTableBar() {
  const wrap = wrapEl.value;
  const panel = tableBarRef.value?.$el as HTMLElement | undefined;
  if (!wrap || !panel || !tableBar.value || !tableBarAnchor) return;
  const wrapRect = wrap.getBoundingClientRect();
  const width = panel.offsetWidth || 210;
  const height = panel.offsetHeight || 31;
  // 表格上半部分滚出视野时贴着光标所在行走，免得浮条跑到屏幕外
  const useCaret = tableBarAnchor.top < wrapRect.top + 8;
  const anchorTop = useCaret ? tableBarAnchor.caretTop : tableBarAnchor.top;
  const anchorBottom = useCaret ? tableBarAnchor.caretBottom : tableBarAnchor.bottom;
  let top = anchorTop - wrapRect.top - height - 6;
  if (top < 2) top = anchorBottom - wrapRect.top + 6;
  top = Math.max(2, Math.min(top, wrapRect.height - height - 2));
  const left = Math.max(4, Math.min(tableBarAnchor.left - wrapRect.left, wrapRect.width - width - 4));
  const next = { top: Math.round(top), left: Math.round(left), row: tableBar.value.row };
  if (tableBar.value.top === next.top && tableBar.value.left === next.left) return;
  tableBar.value = next;
}

function syncTableBar() {
  if (!vditor || !ready || insertOpen.value || actionsSheet.value) {
    hideTableBar();
    return;
  }
  const range = selectionRangeInEditor();
  if (!range) {
    hideTableBar();
    return;
  }
  const target = vditor.getCurrentMode() === 'sv' ? sourceTableTarget(range) : irTableTarget(range);
  if (!target || !target.columns || !target.rows) {
    hideTableBar();
    return;
  }
  tableTarget = target;
  const rect = target.element.getBoundingClientRect();
  const caretRect = range.getBoundingClientRect();
  tableBarAnchor = {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    caretTop: caretRect.height ? caretRect.top : rect.top,
    caretBottom: caretRect.height ? caretRect.bottom : rect.bottom,
  };
  if (!tableBar.value) {
    tableBar.value = {
      top: Math.max(2, rect.top - (wrapEl.value?.getBoundingClientRect().top ?? 0) - 36),
      left: Math.max(4, rect.left - (wrapEl.value?.getBoundingClientRect().left ?? 0)),
      row: target.row,
    };
  } else if (tableBar.value.row !== target.row) {
    tableBar.value = { ...tableBar.value, row: target.row };
  }
  nextTick(placeTableBar);
}

function scheduleTableBarSync() {
  if (tableBarRaf) return;
  tableBarRaf = requestAnimationFrame(() => {
    tableBarRaf = 0;
    syncTableBar();
  });
}

function placeIrCaret(table: HTMLTableElement, row: number, column: number) {
  const rows = Array.from(table.rows);
  const rowElement = rows[Math.max(0, Math.min(row, rows.length - 1))];
  const cells = rowElement ? Array.from(rowElement.cells) : [];
  const cell = cells[Math.max(0, Math.min(column, cells.length - 1))];
  if (!cell) return;
  vditor?.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** ir 改完 DOM 后派发一次 input：走 Vditor 自己的归一化 + 撤销栈 + 模型回写，不另起一套 */
function emitAfterIrMutation() {
  const ir = vditor?.vditor.ir;
  if (!ir) return;
  userInputPending = true;
  ir.element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 删掉整张表（最后一列被删）：光标退到上一块末尾或下一块开头，再让 Vditor 归一化 */
function removeIrTable(table: HTMLTableElement) {
  const previous = table.previousElementSibling as HTMLElement | null;
  const next = table.nextElementSibling as HTMLElement | null;
  const host = previous ?? next;
  if (host) {
    vditor?.focus();
    const range = document.createRange();
    range.selectNodeContents(host);
    range.collapse(!previous);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    table.remove();
    return;
  }
  const paragraph = document.createElement('p');
  paragraph.setAttribute('data-block', '0');
  paragraph.textContent = '\u200b';
  table.replaceWith(paragraph);
  vditor?.focus();
  const range = document.createRange();
  const textNode = paragraph.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, (textNode as Text).data.length);
  } else {
    range.selectNodeContents(paragraph);
    range.collapse(false);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function applyIrTableAction(action: TableEditAction, target: IrTableTarget) {
  const table = target.element;
  const ir = vditor?.vditor.ir;
  if (!ir || !table.isConnected) return;
  const rows = Array.from(table.rows);
  const columns = rows[0]?.cells.length ?? 0;
  if (!rows.length || !columns) return;
  const row = Math.min(target.row, rows.length - 1);
  const column = Math.min(target.column, columns - 1);
  let caretRow = row;
  let caretColumn = column;

  if (action === 'row-above' || action === 'row-below') {
    const body = table.tBodies[0] ?? table.createTBody();
    const newRow = document.createElement('tr');
    for (let index = 0; index < columns; index++) newRow.appendChild(document.createElement('td'));
    const visualRow = row <= 0 ? 1 : action === 'row-above' ? row : row + 1;
    body.insertBefore(newRow, body.rows[visualRow - 1] ?? null);
    caretRow = visualRow;
  } else if (action === 'row-remove') {
    if (row <= 0) return;
    rows[row].remove();
    caretRow = row - 1;
  } else if (action === 'col-left' || action === 'col-right') {
    const insertAt = action === 'col-left' ? column : column + 1;
    const referenceAlign = rows[0].cells[column]?.getAttribute('align');
    for (const rowElement of rows) {
      const cell = document.createElement(rowElement === rows[0] ? 'th' : 'td');
      // 新列沿用参照列的对齐方式，出来就是同一档排版
      if (referenceAlign) cell.setAttribute('align', referenceAlign);
      rowElement.insertBefore(cell, rowElement.cells[insertAt] ?? null);
    }
    caretColumn = insertAt;
  } else {
    if (columns <= 1) {
      removeIrTable(table);
      emitAfterIrMutation();
      return;
    }
    for (const rowElement of rows) rowElement.cells[column]?.remove();
    caretColumn = Math.max(0, column - 1);
  }
  placeIrCaret(table, caretRow, caretColumn);
  emitAfterIrMutation();
}

/** 源码模式：把新表格块写回全文，光标按目标单元格的字符偏移落回 */
function lineStartOffset(markdown: string, lineIndex: number): number {
  const lines = markdown.split('\n');
  let offset = 0;
  for (let index = 0; index < Math.min(lineIndex, lines.length); index++) offset += lines[index].length + 1;
  return offset;
}

function sourceCaretOffset(markdown: string, startLine: number, table: MarkdownTable, row: number, column: number): number {
  const lines = serializeTable(table);
  const lineIndex = row <= 0 ? 0 : Math.min(row + 1, lines.length - 1);
  return lineStartOffset(markdown, startLine + lineIndex) + table.prefix.length + cellStartOffset(table, row, column);
}

function restoreSourceCaret(offset: number) {
  const sv = vditor?.vditor.sv;
  if (!sv) return;
  vditor?.focus();
  const walker = document.createTreeWalker(sv.element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (remaining <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  const range = document.createRange();
  range.selectNodeContents(sv.element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function emitEditorValue() {
  if (!vditor || !ready) return;
  // 程序化 setValue 期间禁了 emit；这里先恢复用户编辑态，再走 main 的稳定值通道
  // （IME 保护、双链比较键、AI 管理注释都在那个函数里，不另起一套）
  beginUserEditing();
  emitStableEditorValue(vditor.getValue());
}

function applySourceTableAction(action: TableEditAction, target: SourceTableTarget) {
  if (!vditor) return;
  const markdown = vditor.getValue();
  const block = findTableBlocks(markdown)[target.blockIndex];
  if (!block) return;
  const table = block.table;
  const row = Math.min(target.row, tableRowCount(table) - 1);
  const column = Math.min(target.column, tableColumnCount(table) - 1);
  let next: MarkdownTable | null = table;
  let caretRow = row;
  let caretColumn = column;

  switch (action) {
    case 'row-above':
      next = insertRow(table, row, 'before');
      caretRow = row <= 0 ? 1 : row;
      break;
    case 'row-below':
      next = insertRow(table, row, 'after');
      caretRow = row <= 0 ? 1 : row + 1;
      break;
    case 'row-remove':
      next = removeRow(table, row);
      caretRow = Math.max(0, row - 1);
      break;
    case 'col-left':
      next = insertColumn(table, column, 'before');
      break;
    case 'col-right':
      next = insertColumn(table, column, 'after');
      caretColumn = column + 1;
      break;
    case 'col-remove':
      next = removeColumn(table, column);
      caretColumn = Math.max(0, column - 1);
      break;
  }
  if (next === table) return;

  const nextMarkdown = replaceTableBlock(markdown, block, next);
  const caretOffset = next
    ? sourceCaretOffset(nextMarkdown, block.startLine, next, caretRow, caretColumn)
    : lineStartOffset(nextMarkdown, block.startLine);
  syncingModelValue = true;
  vditor.setValue(nextMarkdown, false);
  lastProgrammaticValue = vditor.getValue();
  releaseModelSyncSoon();
  restoreSourceCaret(caretOffset);
  emitEditorValue();
}

/** 把一次表格编辑落到当前模式（ir 改 DOM / sv 改 Markdown 块） */
function applyTableActionTo(action: TableEditAction, target: TableTarget) {
  if (target.mode === 'ir') {
    applyIrTableAction(action, target);
  } else {
    applySourceTableAction(action, target);
  }
}

function applyTableAction(action: TableEditAction) {
  const target = tableTarget;
  if (!vditor || !target) return;
  beginUserEditing();
  applyTableActionTo(action, target);
  scheduleTableBarSync();
}

/** 删除整张表：ir 走 removeIrTable（光标退到相邻块），sv 直接把表格块从 Markdown 里抹掉 */
function removeTableAction(target: TableTarget) {
  if (!vditor) return;
  if (target.mode === 'ir') {
    if (!target.element.isConnected) return;
    removeIrTable(target.element);
    emitAfterIrMutation();
    return;
  }
  const markdown = vditor.getValue();
  const block = findTableBlocks(markdown)[target.blockIndex];
  if (!block) return;
  const nextMarkdown = replaceTableBlock(markdown, block, null);
  syncingModelValue = true;
  vditor.setValue(nextMarkdown, false);
  lastProgrammaticValue = vditor.getValue();
  releaseModelSyncSoon();
  restoreSourceCaret(lineStartOffset(nextMarkdown, block.startLine));
  emitEditorValue();
}

/* ---------- 手机档「表格更多」面板 ----------
 * 浮条只放得下「行 / 列」六个高频按钮；「更多」把整表级操作收进底部面板：
 * 上方 / 下方插入行、左侧 / 右侧插入列、删除行 / 删除列、删除整张表。
 * 打开面板会抢走焦点、selectionchange 随之清空 tableTarget，所以先把目标存进 tableSheetTarget。 */
const tableSheetGroups = computed(() => {
  const target = tableSheetTarget.value;
  const row = target?.row ?? 0;
  const columns = target?.columns ?? 0;
  const items: Array<{ key: TableSheetAction; label: string; hint: string; icon: string; disabled?: boolean }> = [
    { key: 'row-above', label: '在上方插入行', hint: '在当前单元格上方新增一行', icon: 'chevron-up' },
    { key: 'row-below', label: '在下方插入行', hint: '在当前单元格下方新增一行', icon: 'chevron-down' },
    { key: 'row-remove', label: '删除当前行', hint: row <= 0 ? '表头行不能删除' : '删除光标所在这一行', icon: 'trash', disabled: row <= 0 },
    { key: 'col-left', label: '在左侧插入列', hint: '在当前单元格左侧新增一列', icon: 'chevron-left' },
    { key: 'col-right', label: '在右侧插入列', hint: '在当前单元格右侧新增一列', icon: 'chevron-right' },
    { key: 'col-remove', label: '删除当前列', hint: columns <= 1 ? '只剩一列时会直接删掉整张表' : '删除光标所在这一列', icon: 'trash' },
    { key: 'table-remove', label: '删除整张表格', hint: '删错了可用工具栏「撤销」找回', icon: 'trash' },
  ];
  return [
    { label: '行', items: items.filter((item) => item.key.startsWith('row')) },
    { label: '列', items: items.filter((item) => item.key.startsWith('col')) },
    { label: '整表', items: items.filter((item) => item.key === 'table-remove') },
  ];
});

/** 选中文字「更多」：浮条放不下的低频格式与操作 */
const selectionSheetEntries: Array<{
  key: SelectionSheetAction;
  label: string;
  hint: string;
  icon: string;
  disabled?: boolean;
}> = [
  { key: 'strike', label: '删除线', hint: '给选中文字加删除线', icon: 'minus' },
  { key: 'inline-code', label: '行内代码', hint: '把选中文字变成行内代码', icon: 'markdown' },
  { key: 'quote', label: '引用', hint: '把选中段落变成引用块', icon: 'book-open' },
  { key: 'copy', label: '复制文字', hint: '复制到系统剪贴板', icon: 'copy' },
  { key: 'select-all', label: '全选正文', hint: '选中整篇文档', icon: 'select-all' },
];

const actionsSheetTitle = computed(() => (actionsSheet.value === 'table' ? '表格' : '选中文字'));
const actionsSheetSub = computed(() => (
  actionsSheet.value === 'table'
    ? '对当前单元格所在的表格生效；内联的「行 / 列」按钮照旧可用'
    : '对刚才选中的文字生效；面板打开期间选区会保留'
));
const actionsSheetGroups = computed(() => (
  actionsSheet.value === 'table'
    ? tableSheetGroups.value
    : [{ label: '格式与操作', items: selectionSheetEntries }]
));

/** 打开表格「更多」面板（只有手机档浮条上有这个入口） */
function openTableMore() {
  if (!mobileViewport.matches || !tableTarget) return;
  tableSheetTarget.value = tableTarget;
  hideTableBar();
  actionsSheet.value = 'table';
  void nextTick(() => actionsSheetRef.value?.focus({ preventScroll: true }));
}

/** 打开选中文字「更多」面板 */
function openSelectionSheet() {
  if (!selectionBarText.trim()) return;
  actionsSheet.value = 'selection';
  hideSelectionBar();
  void nextTick(() => actionsSheetRef.value?.focus({ preventScroll: true }));
}

/** 关面板；restore=true 时把焦点还回编辑器，表格面板关掉后按当前选区重算浮条 */
function closeActionsSheet(restore = true) {
  if (!actionsSheet.value) return;
  const wasTable = actionsSheet.value === 'table';
  actionsSheet.value = null;
  tableSheetTarget.value = null;
  if (!restore) return;
  vditor?.focus();
  if (wasTable) scheduleTableBarSync();
}

/** 面板内的 Tab 循环 + Esc 关闭（Teleport 到 body 后不在编辑器 DOM 里） */
function onActionsSheetKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeActionsSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  const root = actionsSheetRef.value;
  if (!root) return;
  const focusables = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (!active || active === first || active === root) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 执行「更多」面板里的动作：先关面板（不抢焦点），再按动作类型走表格或选区 */
async function runActionsSheetAction(key: TableSheetAction | SelectionSheetAction): Promise<void> {
  if (actionsSheet.value === 'table') {
    const target = tableSheetTarget.value;
    closeActionsSheet(false);
    await nextTick();
    if (!vditor || !target) return;
    beginUserEditing();
    if (key === 'table-remove') removeTableAction(target);
    else applyTableActionTo(key as TableEditAction, target);
    scheduleTableBarSync();
    return;
  }
  closeActionsSheet(false);
  await nextTick();
  if (key === 'copy') {
    void copyText(selectionBarText).then((ok) => {
      if (ok) notify.success('已复制');
    });
    return;
  }
  if (key === 'select-all') {
    selectAll();
    return;
  }
  restoreEditorSelection();
  if (key === 'strike') applySelectionWrap('~~');
  else if (key === 'inline-code') applySelectionWrap('\u0060');
  else if (key === 'quote') applySelectionQuote();
  vditor?.focus();
}

/** 把编辑器滚到与 text 同名的小标题：编辑「格式」面板的目录项用（桌面端不调用） */
function scrollToHeadingByText(text: string): boolean {
  const root = vditorEl.value?.querySelector<HTMLElement>('.vditor-ir, .vditor-wysiwyg, .vditor-sv');
  if (!root) return false;
  const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, '').trim();
  const wanted = normalize(text);
  if (!wanted) return false;
  const heading = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .find((item) => normalize(item.textContent) === wanted);
  if (!heading) return false;
  heading.scrollIntoView({ block: 'center' });
  return true;
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
  // 面板/文件选择器期间编辑器可能被重建：range 已脱离文档时只把焦点还回去
  if (!range || !range.startContainer.isConnected) {
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

/* ---------- 手机档：选中文字浮动格式条（定位 / 显隐 / 命令） ---------- */
const SELECTION_BAR_WIDTH = 300;
const SELECTION_BAR_HEIGHT = 52;

function hideSelectionBar() {
  if (selectionBarFrame) {
    cancelAnimationFrame(selectionBarFrame);
    selectionBarFrame = 0;
  }
  if (selectionBar.value) selectionBar.value = null;
}

/** 选区变化很密：收敛到一个 rAF 里算位置；不满足条件就收起 */
function updateSelectionBar() {
  selectionBarFrame = 0;
  if (!ready || !mobileViewport.matches || composing) {
    hideSelectionBar();
    return;
  }
  if (insertOpen.value || actionsSheet.value || linkPopup.value) {
    hideSelectionBar();
    return;
  }
  const range = selectionRangeInEditor();
  if (!range || range.collapsed) {
    hideSelectionBar();
    return;
  }
  const text = (window.getSelection()?.toString() || '').trim();
  if (!text) {
    hideSelectionBar();
    return;
  }
  const anchorNode = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  if (anchorNode?.closest('.vditor-toolbar, .link-popup, .table-bar, .insert-sheet')) {
    hideSelectionBar();
    return;
  }
  // 多行选区用第一行的矩形：浮条贴着选区上沿，不会被后面的行顶走
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const box = rects[0] || range.getBoundingClientRect();
  if (!box || (!box.width && !box.height)) {
    hideSelectionBar();
    return;
  }
  const half = Math.min(SELECTION_BAR_WIDTH, window.innerWidth - 16) / 2;
  const center = box.left + box.width / 2;
  const left = Math.max(8 + half, Math.min(center, window.innerWidth - 8 - half));
  // 上方放不下（贴到内容区顶部 / 键盘上方）就翻到选区下方，仍然不盖住选中的字
  const below = box.top - 10 - SELECTION_BAR_HEIGHT < 8;
  selectionBarText = text;
  captureEditorSelection();
  selectionBar.value = { left, top: below ? box.bottom + 10 : box.top - 10, below };
}

function scheduleSelectionBarSync() {
  if (selectionBarFrame) return;
  selectionBarFrame = requestAnimationFrame(updateSelectionBar);
}

/** 用新文本替换当前选区（高亮 / 删除线 / 行内代码 / 引用都走这里）：
 *  先恢复浮条弹出时记下的选区，execCommand 走浏览器原生替换 + input 事件，
 *  Vditor 自己的 input 通道会把它收进正文与撤销栈。 */
function replaceSelectionWith(next: string) {
  restoreEditorSelection();
  userInputPending = true;
  let applied = false;
  try {
    applied = document.execCommand('insertText', false, next);
  } catch {
    applied = false;
  }
  if (!applied) vditor?.insertValue(next);
  vditor?.focus();
}

function applySelectionWrap(prefix: string, suffix = prefix) {
  const text = selectionBarText;
  if (!text) return;
  replaceSelectionWith(prefix + text + suffix);
}

function applySelectionQuote() {
  const text = selectionBarText;
  if (!text) return;
  const quoted = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? '> ' + line : '>'))
    .join('\n');
  replaceSelectionWith(quoted);
}

/** 浮条上的六个按钮：加粗 / 斜体 / 高亮 / 链接 / 复制 / 更多 */
function runSelectionAction(action: 'bold' | 'italic' | 'highlight' | 'link' | 'copy' | 'more') {
  const text = selectionBarText.trim();
  if (!text) {
    hideSelectionBar();
    return;
  }
  if (action === 'copy') {
    void copyText(text).then((ok) => {
      if (ok) notify.success('已复制');
    });
    hideSelectionBar();
    return;
  }
  if (action === 'more') {
    openSelectionSheet();
    return;
  }
  if (action === 'bold' || action === 'italic' || action === 'link') {
    // 复用 Vditor 工具栏按钮：加粗 / 斜体 / 链接面板都按当前选区执行，不另造一套命令
    restoreEditorSelection();
    triggerVditorToolbar(action);
    hideSelectionBar();
    return;
  }
  if (action === 'highlight') applySelectionWrap('==');
  hideSelectionBar();
}

/** 点在浮条与编辑器之外（工具栏、底栏、页面留白）即收起；点在编辑器里交给 selectionchange 判断 */
function onSelectionPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.closest('.sel-bar')) return;
  if (vditorEl.value?.contains(target)) return;
  hideSelectionBar();
}

function onSelectionViewportChange(event: MediaQueryListEvent) {
  if (!event.matches) hideSelectionBar();
}

function bindSelectionTools() {
  if (selectionToolsBound) return;
  selectionToolsBound = true;
  document.addEventListener('selectionchange', scheduleSelectionBarSync);
  window.addEventListener('scroll', hideSelectionBar, true);
  window.addEventListener('resize', hideSelectionBar);
  vditorEl.value?.addEventListener('scroll', hideSelectionBar, true);
  document.addEventListener('pointerdown', onSelectionPointerDown, true);
  document.addEventListener('compositionstart', hideSelectionBar, true);
  mobileViewport.addEventListener('change', onSelectionViewportChange);
}

function unbindSelectionTools() {
  if (!selectionToolsBound) return;
  selectionToolsBound = false;
  document.removeEventListener('selectionchange', scheduleSelectionBarSync);
  window.removeEventListener('scroll', hideSelectionBar, true);
  window.removeEventListener('resize', hideSelectionBar);
  vditorEl.value?.removeEventListener('scroll', hideSelectionBar, true);
  document.removeEventListener('pointerdown', onSelectionPointerDown, true);
  document.removeEventListener('compositionstart', hideSelectionBar, true);
  mobileViewport.removeEventListener('change', onSelectionViewportChange);
  if (selectionBarFrame) {
    cancelAnimationFrame(selectionBarFrame);
    selectionBarFrame = 0;
  }
}

/* ---------- 手机档「插入」面板 ----------
 * 九项动作各自落到 Vditor 已有的入口上：块级内容用 insertValue 插 Markdown 片段；
 * 外部链接复用工具栏自带的 link 面板（链接地址校验/编辑都在那里）；双链复用 [[ 候选弹窗；
 * 图片/文件走服务端已有的上传接口，成功后把 Markdown 片段插回光标处。
 * 打开面板会把焦点移走，所以先 captureEditorSelection()，每个动作前再 restoreEditorSelection()。 */

/** 插入动作 key（面板里一项一个） */
type InsertKey = 'image' | 'file' | 'table' | 'code' | 'quote' | 'todo' | 'hr' | 'wikilink' | 'link';

interface InsertEntry {
  key: InsertKey;
  label: string;
  hint: string;
  icon: string;
}

/** 面板分组：素材（上传）/ 块（直接插入）/ 关联（弹窗或链接面板） */
const INSERT_GROUPS: Array<{ label: string; items: InsertEntry[] }> = [
  {
    label: '素材',
    items: [
      { key: 'image', label: '图片', hint: '选图后存成这一页的图片资产', icon: 'image' },
      { key: 'file', label: '文件', hint: '上传到「原始资料/文档」再插入链接', icon: 'attach' },
    ],
  },
  {
    label: '块',
    items: [
      { key: 'table', label: '表格', hint: '插入 2×2 表格', icon: 'board' },
      { key: 'code', label: '代码块', hint: '插入围栏代码块', icon: 'markdown' },
      { key: 'quote', label: '引用', hint: '插入引用块', icon: 'book-open' },
      { key: 'todo', label: '待办', hint: '插入待办项', icon: 'check' },
      { key: 'hr', label: '分割线', hint: '插入一条分割线', icon: 'minus' },
    ],
  },
  {
    label: '关联',
    items: [
      { key: 'wikilink', label: '双链', hint: '搜索页面标题，插入 [[双链]]', icon: 'hash' },
      { key: 'link', label: '链接', hint: '插入外部链接', icon: 'link' },
    ],
  },
];

const INSERT_TABLE = '\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n';
const INSERT_CODE = '\n```\n\n```\n';
const INSERT_QUOTE = '\n> 引用\n';
const INSERT_TODO = '\n- [ ] 待办\n';
const INSERT_HR = '\n\n---\n\n';

function openInsertPanel(): void {
  if (insertBusy.value) return;
  // 打开面板会移走焦点：先把光标位置记下来，动作执行前再放回去
  captureEditorSelection();
  hideSelectionBar();
  insertOpen.value = true;
  void nextTick(() => insertSheetRef.value?.focus({ preventScroll: true }));
}

/** 面板/文件选择器结束后把焦点与光标还给编辑器 */
function restoreInsertFocus(): void {
  void nextTick(() => {
    restoreEditorSelection();
    vditor?.focus();
  });
}

/** 关面板；restore=true 时把焦点与光标还给编辑器（点动作后由动作自己接管） */
function closeInsertPanel(restore = true): void {
  if (!insertOpen.value) return;
  insertOpen.value = false;
  if (!restore) return;
  restoreInsertFocus();
}

/** 在光标处插入 Markdown 片段：先恢复打开面板前的选区，避免插入到面板按钮上 */
function insertSnippet(snippet: string): void {
  restoreEditorSelection();
  userInputPending = true;
  vditor?.insertValue(snippet);
  vditor?.focus();
}

/** 点 Vditor 自带工具栏项（链接面板）：手机工具栏里有这个按钮，直接复用它的交互 */
function triggerVditorToolbar(type: string): boolean {
  const button = vditorEl.value?.querySelector<HTMLButtonElement>(
    '.vditor-toolbar button[data-type="' + type + '"]',
  );
  if (!button) return false;
  button.click();
  return true;
}

/** 面板内的 Tab 循环 + Esc 关闭：Teleport 到 body 后不在编辑器 DOM 里，键盘事件要自己接 */
function onInsertSheetKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeInsertPanel();
    return;
  }
  if (event.key !== 'Tab') return;
  const root = insertSheetRef.value;
  if (!root) return;
  const focusables = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (!active || active === first || active === root) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 图片名带内容哈希前缀，图注用去掉前缀的原名（与 Vditor 上传格式化同一口径） */
function insertAssetLabel(name: string): string {
  return String(name || '').replace(/^[0-9a-f]{8}-/, '') || '图片';
}

async function runInsertAction(key: InsertKey): Promise<void> {
  if (insertBusy.value) return;
  if (key === 'image') {
    closeInsertPanel(false);
    insertImageInput.value?.click();
    return;
  }
  if (key === 'file') {
    closeInsertPanel(false);
    insertFileInput.value?.click();
    return;
  }
  closeInsertPanel(false);
  await nextTick();
  if (key === 'wikilink') {
    restoreEditorSelection();
    openLinkPopup();
    return;
  }
  if (key === 'link') {
    restoreEditorSelection();
    if (triggerVditorToolbar('link')) return;
    insertSnippet('[链接](https://)');
    return;
  }
  if (key === 'table') insertSnippet(INSERT_TABLE);
  else if (key === 'code') insertSnippet(INSERT_CODE);
  else if (key === 'quote') insertSnippet(INSERT_QUOTE);
  else if (key === 'todo') insertSnippet(INSERT_TODO);
  else insertSnippet(INSERT_HR);
}

function pickedFiles(event: Event): File[] {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  // 取消选择（个别浏览器 change 事件带空列表）：把焦点与光标还给编辑器，别让键盘/光标停在 body
  if (!files.length) restoreInsertFocus();
  return files;
}

/** 图片：走编辑器同一套 /api/assets/upload（父项 = 当前页面），上传成功再插 ![]() */
async function onInsertImagePicked(event: Event): Promise<void> {
  const files = pickedFiles(event);
  if (!files.length) return;
  const pageId = props.pageId;
  if (!pageId) {
    notify.error('页面还没保存好，稍后再插入图片');
    return;
  }
  insertBusy.value = 'image';
  try {
    const fd = new FormData();
    fd.append('parent', pageId);
    for (const file of files) fd.append('files', file);
    const { data } = await api.post('/api/assets/upload', fd);
    const saved: Array<{ name?: string; url?: string }> = Array.isArray(data?.saved) ? data.saved : [];
    const usable = saved.filter((asset) => typeof asset?.url === 'string' && asset.url);
    if (!usable.length) throw new Error(data?.error || '图片上传失败');
    insertSnippet(usable.map((asset) => '![' + insertAssetLabel(asset.name || '') + '](' + asset.url + ')').join('\n'));
    notify.success('已插入 ' + usable.length + ' 张图片');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '图片上传失败');
  } finally {
    insertBusy.value = '';
  }
}

/** 文件：复用侧栏的 /api/files/upload（落「原始资料/文档」）；md 产物插双链，其余插下载链接 */
async function onInsertFilePicked(event: Event): Promise<void> {
  const files = pickedFiles(event);
  if (!files.length) return;
  insertBusy.value = 'file';
  try {
    const fd = new FormData();
    fd.append('dir', '原始资料/文档');
    for (const file of files) fd.append('files', file);
    const { data } = await api.post('/api/files/upload', fd);
    const saved: Array<{ path?: string; name?: string; pageId?: string }> = Array.isArray(data?.saved) ? data.saved : [];
    if (!saved.length) throw new Error(data?.error || '文件上传失败');
    const snippets = await Promise.all(saved.map(async (entry) => {
      const name = String(entry.name || '');
      if (entry.pageId) {
        // md 导入后会变成页面：双链要按页面标题写（frontmatter 标题可能不同于文件名）
        let title = name.replace(/\.[^.]+$/, '');
        try {
          const { data: page } = await api.get('/api/pages/' + encodeURIComponent(entry.pageId));
          const pageTitle = page?.meta?.title;
          if (typeof pageTitle === 'string' && pageTitle.trim()) title = pageTitle.trim();
        } catch {
          /* 拿不到标题就退回文件名 */
        }
        return markdownWikiLink(title);
      }
      return '[' + (name || '文件') + '](/api/files/download?path=' + encodeURIComponent(String(entry.path || '')) + ')';
    }));
    insertSnippet(snippets.join('\n'));
    if (Array.isArray(data?.duplicates) && data.duplicates.length) {
      notify.info('以下文件已存在，未重复上传：' + data.duplicates.join('、'));
    } else {
      notify.success('已插入 ' + saved.length + ' 个文件链接');
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '文件上传失败');
  } finally {
    insertBusy.value = '';
  }
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
  // 阅读时/初始化时尚未同步的编辑器不是当前正文的来源，保存用父级最新值。
  if (!modelSync.isCurrent()) return props.modelValue;
  // 组字中返回最近一次稳定快照：Vditor 的活值里含未提交拼音，不能写进正文/文件。
  return restoreIngestComments(markdownLinksToWiki(stableEditorValue()));
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

const modelSync = createEditorModelSync(applyModelValue);

/** 阅读模式下编辑器被 v-show 隐藏：跳过整页重渲染（大页面可省约一半卡顿），恢复显示时由 syncIfPending 补一次。 */
function editorHidden(): boolean {
  return !wrapEl.value || wrapEl.value.offsetParent === null;
}

/** 整块写入编辑器（换页或真正的外部更新才走这里）：写完把稳定快照对齐 Vditor 序列化后的值。 */
function applyEditorMarkdown(editorValue: string, pageChanged: boolean) {
  if (!vditor) return;
  syncingModelValue = true;
  vditor.setValue(editorValue, pageChanged);
  lastProgrammaticValue = vditor.getValue();
  committedMarkdown = lastProgrammaticValue;
  releaseModelSyncSoon();
  scheduleHideManagedPlaceholders();
  // 整块重渲染后表格 DOM 已经换掉，旧的浮条目标失效：先收起，等 selectionchange 按新 DOM 重算
  hideTableBar();
}

/**
 * 父级正文写回编辑器。关键边界：组字期间绝不 setValue——整块重建 DOM 会打断输入法
 * （拼音被提交成拉丁字母、光标跳位、正文被重新解析）。组字中收到的回显直接丢弃，
 * 真正的外部改动推迟到 compositionend 后由 finishComposition 复核生效。
 */
function applyModelValue(v: string, pageChanged = false) {
  if (!ready || !vditor) return;
  const editorValue = stripIngestComments(wikiLinksToMarkdown(v));
  if (pageChanged) {
    userInputPending = false;
    composing = false;
    // 换页前先让输入法收掉组字（blur 触发 compositionend；此刻 composing 已清，不会把旧页文字
    // 当成新页提交），再整块换内容，避免在 IME 活跃状态下直接替换 contenteditable 的 DOM。
    vditorEl.value
      ?.querySelector<HTMLElement>('.vditor-ir [contenteditable="true"], .vditor-sv [contenteditable="true"], .vditor-wysiwyg [contenteditable="true"]')
      ?.blur();
    savedSelectionRange = null;
    savedSelectionText = '';
    linkPopup.value = false;
    applyEditorMarkdown(editorValue, true);
    return;
  }
  const live = vditor.getValue();
  // 快速路径 1：父级值与编辑器活值逐字节相同（最常见的 emit 回显），不做全文规范化比较。
  if (editorValue === live) {
    if (!composing) {
      lastProgrammaticValue = editorValue;
      committedMarkdown = live;
    }
    return;
  }
  // 快速路径 2：父级值等于最近一次稳定快照——这是自己提交时的滞后回显（自动保存回包、SSE 回声
  // 都可能晚一拍），绝不能用它覆盖编辑器里更新的内容（组字中的活值可能已经领先）。
  if (editorValue === committedMarkdown) {
    if (!composing) lastProgrammaticValue = editorValue;
    return;
  }
  const incomingKey = syncKey(editorValue);
  const action = decideModelSync(
    composing,
    incomingKey === syncKey(live),
    incomingKey === syncKey(committedMarkdown),
  );
  if (action === 'skip') {
    if (!composing) {
      lastProgrammaticValue = editorValue;
      committedMarkdown = live;
    }
    return;
  }
  if (action === 'defer') return;
  applyEditorMarkdown(editorValue, false);
}

watch(
  () => [props.pageId, props.modelValue] as const,
  ([pageId, value]) => {
    modelSync.setEnvironment(ready, !editorHidden());
    modelSync.update(pageId || '', value);
  },
  { immediate: true }
);

function syncIfPending() {
  modelSync.setEnvironment(ready, !editorHidden());
}
watch(
  () => props.dark,
  (d) => {
    if (!ready) return;
    vditor?.setTheme(d ? 'dark' : 'classic', d ? 'dark' : 'light');
  }
);
/* 全屏状态由父级持有：变化时把工具栏按钮的图标/提示同步过去 */
watch(
  () => props.fullscreen,
  () => {
    if (!ready) return;
    overrideToolbarIcons();
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
  unbindTableBarEvents();
  unbindSelectionTools();
  wikiTagObserver?.disconnect();
  modeObserver?.disconnect();
  unbindVditorTooltips?.();
  unbindVditorTooltips = null;
  floatingHintCleanup?.();
  unregisterInsertBack?.();
  unregisterInsertBack = null;
  mobileViewport.removeEventListener('change', onMobileViewportChange);
  vditor?.destroy();
});

defineExpose({
  getSelectionText,
  insertText,
  getValue,
  /** 输入法组字中：父级保存/重载/切阅读态都要避开这个窗口（见 EditorView 的守卫） */
  isComposing: () => composing,
  getCurrentMode,
  focus,
  syncIfPending,
  undo: () => executeHistoryCommand('undo'),
  redo: () => executeHistoryCommand('redo'),
  /** 编辑「格式」面板的目录项：把正文滚到同名标题（ir / wysiwyg 是标题元素，sv 模式下找不到就返回 false） */
  scrollToHeading: (text: string): boolean => scrollToHeadingByText(text),
  cutSelection,
  copySelection,
  pasteClipboard,
  selectAll,
});
onMounted(() => {
  init();
  // 安卓返回键：插入面板开着时先关面板（只认领本组件的这一层）
  unregisterInsertBack = registerBackHandler(() => {
    if (actionsSheet.value) {
      closeActionsSheet();
      return true;
    }
    if (insertOpen.value) {
      closeInsertPanel();
      return true;
    }
    return false;
  });
  // 从手机档放大到桌面档（折叠屏展开 / 旋屏）：这些手机档浮层直接收起
  mobileViewport.addEventListener('change', onMobileViewportChange);
});

function onMobileViewportChange(event: MediaQueryListEvent): void {
  if (event.matches) return;
  closeInsertPanel();
  closeActionsSheet(false);
  hideSelectionBar();
}
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

/* ---------- 手机档：选中文字浮动格式条 ----------
 * 深色小条（用 --text 当底、--bg 当字，只花现有令牌），fixed 视口坐标 + translate(-50%,-100%)
 * 贴在选区上方；放不下时加 .is-below 翻到下方。只在手机档渲染（脚本按断点控制）。 */
.sel-bar {
  position: fixed;
  z-index: var(--z-popup);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  background: var(--text);
  color: var(--bg);
  box-shadow: var(--shadow-dialog);
  transform: translate(-50%, -100%);
  animation: sel-bar-in 0.12s ease-out both;
}
.sel-bar.is-below {
  transform: translate(-50%, 0);
}
@keyframes sel-bar-in {
  from { opacity: 0; transform: translate(-50%, -100%) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, -100%) scale(1); }
}
.sel-bar.is-below { animation-name: sel-bar-in-below; }
@keyframes sel-bar-in-below {
  from { opacity: 0; transform: translate(-50%, 0) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
.sel-btn {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 16px;
  font-weight: 650;
}
.sel-btn:active,
.sel-btn.is-on {
  background: color-mix(in srgb, var(--bg) 18%, transparent);
}
.sel-btn:focus-visible { outline: 2px solid var(--bg); outline-offset: -2px; }
.sel-bold { font-weight: 800; }
.sel-italic { font-style: italic; font-family: Georgia, 'Times New Roman', serif; font-weight: 600; }
.sel-div {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: color-mix(in srgb, var(--bg) 26%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .sel-bar,
  .sel-bar.is-below { animation: none; }
}

/* ---------- 工具栏换肤：悬浮卡片 + 分组气泡按钮（UI 2.0 mockup 4.3） ---------- */
/* Vditor 自带 tooltipped 提示（::after/::before 读 aria-label）固定贴按钮一侧、不做避让，
   长文案会压住旁边的工具栏按钮；提示已换成自建气泡（adoptVditorTooltips），
   这里只把自带伪元素关掉——类本身保留，它的 position: relative 与 cursor: pointer 还要用 */
:deep(.vditor-tooltipped)::after,
:deep(.vditor-tooltipped)::before {
  content: none !important;
  display: none !important;
}
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
  /* 白卡片 + 细描边 + 单层轻投影，左缘对齐正文列，浮在纸面上 */
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  width: fit-content;
  max-width: calc(100% - var(--col-inset, 24px) - 24px);
  margin: 0 0 18px var(--col-inset, 24px);
  /* !important 必须带：vditor 的 setPadding 会写内联 padding-left（正文列居中公式），
     否则卡片左内边距被它顶掉 */
  padding: 6px 8px !important;
  gap: 2px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: var(--shadow-raised);
  position: relative;
  z-index: 2;
}
:deep(.vditor-toolbar .vditor-toolbar__item) { padding: 0; }
:deep(.vditor-toolbar button) {
  width: 28px;
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
  float: none;
  width: 1px;
  height: 16px;
  margin: 0 5px;
  border-left: none;
  background: var(--border);
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
/* 全屏编辑由 EditorView 持有状态（页头/状态栏一起让位），这里不再依赖 Vditor 的
   .vditor--fullscreen：它只把 .vditor 变成 fixed 覆盖层，扁平布局下会与页头叠字 */
/* 手机端工具栏：精简后的 10 个按钮按 44×44 算要 466px（390–412 视口放不下），
   原来让 flex 折成两行、正文被挤掉两行高度。现在固定单行 + 横向滚动（滚动条隐藏），
   高度恒定一行；按钮本体撑到 44×44（相邻按钮只隔 2px，热区外扩会互相压住，只能撑本体）。 */
@media (max-width: 768px) {
  :deep(.vditor-toolbar) {
    margin: 0 20px 14px;
    max-width: calc(100% - 40px);
    padding: 4px !important;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  :deep(.vditor-toolbar::-webkit-scrollbar) { display: none; }
  :deep(.vditor-toolbar .vditor-toolbar__item),
  :deep(.vditor-toolbar button) { flex: none; }
  :deep(.vditor-toolbar button) {
    width: 44px;
    min-width: 44px;
    height: 44px;
  }
  :deep(.vditor-toolbar .vditor-toolbar__divider) { margin: 0 3px; flex: none; }
  /* 横滚容器会裁掉绝对定位的下拉菜单：菜单打开时脚本（bindToolbarHintOverlay）把它改成
     fixed；这条类再兜一层，防止 Vditor 重写内联样式后菜单又被裁回去。 */
  :deep(.vditor-toolbar .vditor-hint.eg-hint-floating) {
    position: fixed !important;
    z-index: var(--z-popup) !important;
    margin: 0 !important;
  }
}

:deep(.vditor-ir), :deep(.vditor-wysiwyg), :deep(.vditor-sv) {
  background: transparent;
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

/* ---------- 手机档「插入」底部面板 ----------
   入口只挂在 mobileToolbar 尾部（engram-insert），桌面工具栏没有这一项；
   面板 Teleport 到 body：遮罩 + 抓柄 + 22px 顶圆角 + 44px 行高，与阅读目录面板同一套语言。 */
.insert-file-input { display: none; }
:deep(.vditor-toolbar button[data-type="engram-insert"]) { color: var(--accent); }
:deep(.vditor-toolbar button[data-type="engram-insert"]:hover) {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 从手机档放大到桌面档时 Vditor 工具栏不重建：用媒体查询兜底藏掉这个只属于手机档的入口 */
@media (min-width: 769px) {
  :deep(.vditor-toolbar button[data-type="engram-insert"]) { display: none !important; }
}
@media (max-width: 768px) {
  .insert-mask {
    position: fixed;
    inset: 0;
    z-index: var(--z-overlay);
    background: rgba(20, 18, 15, 0.42);
    animation: insert-fade 0.2s ease both;
  }
  .insert-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: calc(var(--z-overlay) + 1);
    display: flex;
    flex-direction: column;
    max-height: 78dvh;
    padding: 8px 16px calc(14px + var(--safe-bottom));
    border-radius: 22px 22px 0 0;
    background: var(--card-bg);
    box-shadow: 0 -18px 60px -20px rgba(20, 18, 15, 0.35);
    animation: insert-sheet-up 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .insert-sheet:focus { outline: none; }
  .insert-grab {
    width: 38px;
    height: 4px;
    flex: none;
    margin: 2px auto 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 18%, transparent);
  }
  .insert-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .insert-head h2 {
    flex: 1;
    margin: 0;
    font-size: 17px;
    font-weight: 650;
    color: var(--text);
  }
  .insert-x {
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: -8px -8px -8px 0;
    border: 0;
    border-radius: 12px;
    background: none;
    color: var(--text-secondary);
  }
  .insert-x:active { background: var(--bg-hover); color: var(--text); }
  .insert-sub {
    flex: none;
    margin: 2px 0 6px;
    font-size: 12.5px;
    color: var(--text-secondary);
  }
  .insert-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 2px 4px;
  }
  .insert-group + .insert-group { margin-top: 8px; }
  .insert-group-title {
    margin: 6px 4px 4px;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }
  .insert-row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    min-height: 44px;
    padding: 7px 10px;
    border-radius: 12px;
    color: var(--text);
    text-align: left;
  }
  .insert-row + .insert-row { margin-top: 2px; }
  .insert-row:active { background: var(--bg-hover); }
  .insert-row:disabled { opacity: 0.5; }
  .insert-row-icon {
    width: 32px;
    height: 32px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background: var(--bg-tertiary);
    color: var(--text);
  }
  .insert-row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .insert-row-text b { font-size: 14px; font-weight: 600; }
  .insert-row-text small {
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--text-secondary);
  }
  .insert-row-chevron { flex: none; color: var(--text-faint); }
  @keyframes insert-sheet-up {
    from { transform: translateY(105%); }
    to { transform: translateY(0); }
  }
  @keyframes insert-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
}
/* 触屏（无 hover + 粗指针）：工具栏按钮 28px、双链候选行 ~32px，手指都按不准。
   刻意不写成 `max-width: 768px`——那是宽度不是触屏：折叠屏内屏、平板、手机横屏都在 769px 以上，
   按宽度写它们就还是 28px。反过来，鼠标设备不匹配这个查询，桌面工具栏一点不变。
   为什么不用「不可见热区」：按钮之间只隔 2px，热区各伸 1px 等于没伸，伸多了就压住隔壁按钮
   （那正是这次要修的误触）；vditor 给按钮带的 tooltipped::after 又被上面那条 !important 关掉了，
   所以只能把按钮本体撑到 44×44。390px 视口放不下 10 个 44px 按钮，工具栏会折成两行——
   为了让每个按钮都点得准，这一行高度值得付。放在文件最后，确保盖住前面所有工具栏规则。 */
@media (hover: none) and (pointer: coarse) {
  :deep(.vditor-toolbar button) {
    width: 44px;
    height: 44px;
  }
  :deep(.vditor-toolbar .vditor-toolbar__divider) {
    height: 24px;
  }
  /* edit-mode 下拉挂在工具栏 DOM 里，选项原来只有 26px 高 */
  :deep(.vditor-toolbar .vditor-hint button) {
    min-height: 44px;
    padding: 0 12px;
  }
  /* [[ 双链候选弹窗：每行都是纯手指操作，原来约 32px */
  .link-item {
    min-height: 44px;
    align-items: center;
  }
}
</style>
