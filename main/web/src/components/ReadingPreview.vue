<template>
  <section
    ref="readerEl"
    class="reading-preview"
    :class="{
      'outline-hidden': !preferences.outline || outline.length === 0,
      'numbered-headings': preferences.numberedHeadings,
      'mobile-outline-open': mobileOutlineOpen,
    }"
    :style="readingStyle"
    tabindex="-1"
    @keydown.esc="onEsc"
  >
    <header ref="toolbarEl" class="reading-toolbar">
      <button class="reading-tool back" type="button" v-tooltip="'返回编辑（Esc）'" @click="closeReading">
        <Icon name="chevron-left" :size="17" />
        <span class="back-label">返回编辑</span>
      </button>

      <BackTrailMenu v-if="canGoBack" :trail="trail ?? []" @select="emit('go-back-to', $event)">
        <template #default="{ open }">
          <button
            class="reading-tool back-page"
            type="button"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click="emit('go-back')"
          >
            <Icon name="undo" :size="16" />
            <span class="back-page-label">返回上一页</span>
            <Icon name="chevron-down" :size="12" />
          </button>
        </template>
      </BackTrailMenu>

      <button class="reading-tool theme-tool" type="button" v-tooltip="dark ? '切换到浅色' : '切换到深色'" @click="app.toggleResolvedTheme()">
        <Icon :name="dark ? 'sun' : 'moon'" :size="17" />
      </button>

      <div class="reading-settings">
        <div class="font-stepper" aria-label="正文字号">
          <button
            type="button"
            aria-label="减小字号"
            :disabled="preferences.fontSize <= READING_FONT_SIZE_MIN"
            @click="stepFont(-1)"
          >A−</button>
          <div ref="fontPickerEl" class="font-picker">
            <button
              class="font-size-trigger"
              type="button"
              aria-haspopup="listbox"
              :aria-expanded="fontMenuOpen"
              aria-label="选择正文字号"
              v-tooltip="'点这里直接选字号'"
              @click="toggleFontMenu"
            >
              <span>{{ preferences.fontSize }}px</span>
              <Icon name="chevron-down" :size="12" />
            </button>
            <div
              v-if="fontMenuOpen"
              ref="fontMenuEl"
              class="font-menu"
              role="listbox"
              aria-label="正文字号选项"
            >
              <button
                v-for="size in fontSizeOptions"
                :key="size"
                class="font-menu-item"
                :class="{ active: size === preferences.fontSize }"
                type="button"
                role="option"
                :aria-selected="size === preferences.fontSize"
                @click="pickFontSize(size)"
              >{{ size }}px</button>
            </div>
          </div>
          <button
            type="button"
            aria-label="增大字号"
            :disabled="preferences.fontSize >= READING_FONT_SIZE_MAX"
            @click="stepFont(1)"
          >A+</button>
        </div>

        <div ref="widthPickerEl" class="width-picker">
          <button
            class="width-trigger"
            type="button"
            aria-haspopup="menu"
            :aria-expanded="widthMenuOpen"
            aria-label="选择正文宽度"
            v-tooltip="'正文宽度：按可用区百分比'"
            @click="toggleWidthMenu"
          >
            <span>{{ formatContentWidthRatio(preferences.widthRatio) }}</span>
            <Icon name="chevron-down" :size="12" />
          </button>
          <div
            v-if="widthMenuOpen"
            class="width-menu"
            role="menu"
            aria-label="正文宽度选项"
          >
            <button
              v-for="ratio in CONTENT_WIDTH_RATIO_STEPS"
              :key="ratio"
              type="button"
              role="menuitemradio"
              :aria-checked="preferences.widthRatio === ratio"
              :class="{ active: preferences.widthRatio === ratio }"
              @click="pickWidthRatio(ratio)"
            >{{ formatContentWidthRatio(ratio) }}</button>
          </div>
        </div>

        <!-- 低频显示项收进「显示」菜单：行距 / 编号 / 目录 -->
        <div ref="displayWrapEl" class="display-wrap">
          <button
            class="reading-tool"
            type="button"
            aria-haspopup="menu"
            :aria-expanded="displayMenuOpen"
            v-tooltip="'显示选项（行距 / 编号 / 目录）'"
            @click="toggleDisplayMenu"
          >
            <Icon name="more" :size="17" />
          </button>
          <div v-if="displayMenuOpen" class="display-menu" role="menu" aria-label="显示选项">
            <div class="display-menu-label">行距</div>
            <div class="display-menu-seg" role="radiogroup" aria-label="正文行距">
              <button
                v-for="option in lineHeightOptions"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="preferences.lineHeight === option.value"
                :class="{ active: preferences.lineHeight === option.value }"
                @click="pickLineHeight(option.value)"
              >{{ option.label }}</button>
            </div>
            <div class="display-menu-sep"></div>
            <button
              type="button"
              role="menuitemcheckbox"
              :aria-checked="preferences.numberedHeadings"
              @click="toggleNumberingMenu"
            ><span class="check" :class="{ on: preferences.numberedHeadings }"></span>标题编号</button>
            <button
              type="button"
              role="menuitemcheckbox"
              :aria-checked="outlinePressed"
              :disabled="outline.length === 0"
              @click="toggleOutline"
            ><span class="check" :class="{ on: outlinePressed }"></span>本页目录</button>
          </div>
        </div>
      </div>
    </header>

    <div class="reading-grid">
      <div ref="mainEl" class="reading-main">
        <article class="reading-article" @contextmenu="handleContextMenu">
          <header class="reading-document-head">
            <h1>{{ title }}</h1>
            <div class="reading-meta">
              <span class="reading-type">{{ typeLabel }}</span>
              <template v-if="updatedAt">
                <span class="reading-meta-sep">·</span>
                <span>更新于 {{ formatDate(updatedAt) }}</span>
              </template>
              <template v-if="tags.length">
                <span class="reading-meta-sep">·</span>
                <span v-for="tag in tags" :key="tag" class="reading-tag">{{ tag }}</span>
              </template>
            </div>
          </header>

          <div
            ref="contentEl"
            class="reading-content vditor-reset"
            :aria-busy="rendering"
            @click="handleContentClick"
          />
        </article>

        <div class="reading-tail-space" :style="{ height: `${tailSpace}px` }" aria-hidden="true" />
      </div>

      <aside class="reading-outline" aria-label="本页目录">
        <h2><Icon name="list-tree" :size="15" /> 本页目录</h2>
        <nav ref="outlineNavEl">
          <a
            v-for="heading in outline"
            :key="heading.id"
            :href="`#${heading.id}`"
            :class="{ current: currentHeading === heading.id }"
            :data-level="heading.level"
            @click.prevent="scrollToHeading(heading.id)"
          >{{ heading.text }}</a>
        </nav>
      </aside>
    </div>

    <!-- 底部悬浮胶囊：字数 / 阅读时长在左，本页关联在右。
         阅读视图自己没有底栏（字数原在顶栏），这里补一条与编辑视图 .statusbar 同一套语言的胶囊；
         用 sticky 而不是 absolute：.reading-preview 自己就是滚动容器，absolute 会跟着正文滚走，
         sticky 让它贴在可视区底部，滚到文末时自然停在文档流末端 -->
    <div class="reading-statusbar">
      <span class="reading-stat">{{ metrics.units.toLocaleString('zh-CN') }} 字 · 约 {{ metrics.minutes }} 分钟</span>
      <RelatedMenu
        v-if="relatedCount > 0"
        ref="relatedMenuRef"
        :related="related"
        :reset-key="pageKey"
        @open-page="emit('open-related', $event)"
        @open-graph="emit('open-graph')"
      >
        <template #default="{ toggle, open, count }">
          <button
            type="button"
            class="reading-rel"
            aria-haspopup="dialog"
            :aria-expanded="open"
            v-tooltip="'本页关联'"
            @click="toggle"
          >
            <Icon name="link" :size="12" />
            关联 <span class="reading-rel-count">{{ count }}</span>
          </button>
        </template>
      </RelatedMenu>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Vditor from 'vditor';
import { useAppStore } from '../stores/app';
import {
  headingNumbers,
  isDuplicateDocumentTitle,
  READING_FONT_SIZE_MAX,
  READING_FONT_SIZE_MIN,
  readingMetrics,
  requiredReadingTailSpace,
  uniqueHeadingId,
  type ReadingLineHeight,
  type ReadingPreferences,
} from '../lib/readingPreview';
import {
  CONTENT_WIDTH_RATIO_STEPS,
  contentColumnWidth,
  formatContentWidthRatio,
  type ContentWidthRatio,
} from '../lib/contentWidth';
import { wikiLinksToMarkdown, wikiTargetFromHref } from '../lib/wikiLinks';
import { headingFoldRanges } from '../lib/readingFold';
import { vditorPreviewOptions } from '../lib/vditorPreview';
import {
  selectionInside,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import type { PageTrailEntry } from '../lib/pageTrail';
import BackTrailMenu from './BackTrailMenu.vue';
import RelatedMenu from './RelatedMenu.vue';
import Icon from './Icon.vue';

type OutlineItem = {
  id: string;
  level: number;
  text: string;
};

const props = defineProps<{
  markdown: string;
  title?: string;
  pageType: string;
  tags: string[];
  updatedAt?: string;
  dark: boolean;
  related?: any;
  /** 存在双链/关联跳转轨迹时显示「返回上一页」 */
  canGoBack?: boolean;
  /** 返回轨迹（栈底 → 栈顶）：悬停「返回上一页」时下拉列出全部可返回的页面名称 */
  trail?: PageTrailEntry[];
  /** 当前页面 id：换页时清空按标题收放的状态 */
  pageKey?: string;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'go-back'): void;
  (event: 'go-back-to', id: string): void;
  (event: 'open-wikilink', title: string): void;
  (event: 'open-related', id: string): void;
  (event: 'open-graph'): void;
  (event: 'context-menu', request: SelectionContextMenuRequest): void;
}>();

const app = useAppStore();
const readerEl = ref<HTMLElement>();
const toolbarEl = ref<HTMLElement>();
const mainEl = ref<HTMLElement>();
const contentEl = ref<HTMLDivElement>();
const outlineNavEl = ref<HTMLElement>();
const fontPickerEl = ref<HTMLElement>();
const fontMenuEl = ref<HTMLElement>();
const fontMenuOpen = ref(false);
const widthPickerEl = ref<HTMLElement>();
const widthMenuOpen = ref(false);
const displayWrapEl = ref<HTMLElement>();
const displayMenuOpen = ref(false);
const outline = ref<OutlineItem[]>([]);
const currentHeading = ref('');
const rendering = ref(false);
const mobileOutlineOpen = ref(false);
const metrics = ref({ units: 0, minutes: 1 });
const toolbarHeight = ref(56);
const viewportHeight = ref(0);
const tailSpace = ref(0);
/* 正文可用区宽度：--reading-width 按它的百分比算（响应式，随窗口与侧栏变化） */
const availableWidth = ref(0);
const mobileMedia = window.matchMedia('(max-width: 768px)');
let renderVersion = 0;
let scrollFrame = 0;
let tailFrame = 0;
let layoutObserver: ResizeObserver | null = null;

const lineHeightOptions: Array<{ value: ReadingLineHeight; label: string }> = [
  { value: 1.6, label: '紧凑' },
  { value: 1.8, label: '舒适' },
  { value: 2, label: '宽松' },
];
/* 下拉里 8–48px 每 1px 一档，与 A−/A+ 的步进范围完全一致 */
const fontSizeOptions: number[] = Array.from(
  { length: READING_FONT_SIZE_MAX - READING_FONT_SIZE_MIN + 1 },
  (_, index) => READING_FONT_SIZE_MIN + index,
);

const preferences = computed(() => app.readingPreferences);
const outlinePressed = computed(() =>
  outline.value.length > 0 &&
  (mobileMedia.matches ? mobileOutlineOpen.value : preferences.value.outline)
);
const readingStyle = computed(() => ({
  /* 正文列宽 = 可用区 × 百分比（可用区没量到前回落到 100%，不闪成 0） */
  '--reading-width': availableWidth.value > 0
    ? `${contentColumnWidth(preferences.value.widthRatio, availableWidth.value)}px`
    : '100%',
  '--reading-font-size': `${preferences.value.fontSize}px`,
  '--reading-line-height': String(preferences.value.lineHeight),
  '--reading-toolbar-height': `${toolbarHeight.value}px`,
  '--reading-anchor-offset': `${toolbarHeight.value + 28}px`,
  '--reading-viewport-height': `${viewportHeight.value}px`,
}));
const typeLabel = computed(() => ({
  concept: '概念',
  person: '人物',
  customer: '客户',
  org: '组织',
  project: '项目',
  other: '其他',
  note: '知识页面',
}[props.pageType] || '知识页面'));
/* 本页关联：展示交给底部胶囊里的 RelatedMenu（原先正文尾部有一行折叠摘要，
 * 展开态记在 localStorage；本次连同那一行一起去掉，面板开合不再跨会话记忆） */
const relatedMenuRef = ref<InstanceType<typeof RelatedMenu>>();
const relatedCount = computed(() =>
  (props.related?.neighbors?.length || 0) +
  (props.related?.similar?.length || 0) +
  (props.related?.entities?.length || 0)
);

function updatePreferences(value: Partial<ReadingPreferences>) {
  app.updateReadingPreferences(value);
}

/* 字号连续可调：每次 ±1px，仅在安全区间两端收敛 */
function stepFont(direction: number) {
  updatePreferences({ fontSize: preferences.value.fontSize + direction });
}

/* 点字号直接下拉选（8–48px 每 1px 一档，与步进共用同一套偏好与收敛逻辑） */
function toggleFontMenu() {
  fontMenuOpen.value = !fontMenuOpen.value;
  if (!fontMenuOpen.value) return;
  // 打开时把当前档位滚到可视区中间，41 项也不用找（只滚菜单本身，不动正文）
  nextTick(() => {
    const menu = fontMenuEl.value;
    const active = menu?.querySelector<HTMLElement>('.active');
    if (!menu || !active) return;
    menu.scrollTop = active.offsetTop - menu.clientHeight / 2 + active.clientHeight / 2;
  });
}

function pickFontSize(size: number) {
  updatePreferences({ fontSize: size });
  fontMenuOpen.value = false;
}

/* 正文宽度：点开百分比菜单选档（40%–100%，默认 70%），选择即写入偏好 */
function toggleWidthMenu() {
  widthMenuOpen.value = !widthMenuOpen.value;
}

function pickWidthRatio(ratio: ContentWidthRatio) {
  updatePreferences({ widthRatio: ratio });
  widthMenuOpen.value = false;
}

/* 下拉打开时：点别处或按 Esc 收起；Esc 在菜单关闭后才交回「返回编辑」 */
function onDocumentPointerDown(event: MouseEvent) {
  if (fontMenuOpen.value && !fontPickerEl.value?.contains(event.target as Node)) {
    fontMenuOpen.value = false;
  }
  if (widthMenuOpen.value && !widthPickerEl.value?.contains(event.target as Node)) {
    widthMenuOpen.value = false;
  }
  if (displayMenuOpen.value && !displayWrapEl.value?.contains(event.target as Node)) {
    displayMenuOpen.value = false;
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (fontMenuOpen.value) fontMenuOpen.value = false;
  if (widthMenuOpen.value) widthMenuOpen.value = false;
  if (displayMenuOpen.value) displayMenuOpen.value = false;
}

function onEsc() {
  /* 关联面板开着时 Esc 只关面板：阅读视图的 Esc 默认是「返回编辑」，不能顺手把人踢出去 */
  if (relatedMenuRef.value?.open) {
    relatedMenuRef.value.close();
    return;
  }
  if (fontMenuOpen.value) {
    fontMenuOpen.value = false;
    return;
  }
  if (widthMenuOpen.value) {
    widthMenuOpen.value = false;
    return;
  }
  if (displayMenuOpen.value) {
    displayMenuOpen.value = false;
    return;
  }
  closeReading();
}

/* 「显示」菜单：行距 / 标题编号低频项从顶栏收进菜单，顶栏只留页宽+字号+主题 */
function toggleDisplayMenu() {
  displayMenuOpen.value = !displayMenuOpen.value;
}

function pickLineHeight(value: ReadingLineHeight) {
  updatePreferences({ lineHeight: value });
}

function toggleNumberingMenu() {
  updatePreferences({ numberedHeadings: !preferences.value.numberedHeadings });
}

function toggleOutline() {
  if (mobileMedia.matches) {
    mobileOutlineOpen.value = !mobileOutlineOpen.value;
    return;
  }
  updatePreferences({ outline: !preferences.value.outline });
}

function closeReading() {
  emit('close');
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function wrapTables(root: HTMLElement) {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('reading-table-scroll')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'reading-table-scroll';
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  }
}

function addImageCaptions(root: HTMLElement) {
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[alt]'))) {
    const alt = image.alt.trim();
    if (!alt || image.closest('figure')) continue;
    const paragraph = image.parentElement;
    if (!paragraph || paragraph.tagName !== 'P' || paragraph.childElementCount !== 1) continue;
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = alt;
    paragraph.replaceWith(figure);
    figure.append(image, caption);
  }
}

function prepareHeadings(root: HTMLElement) {
  const firstH1 = root.querySelector<HTMLElement>('h1');
  if (firstH1 && isDuplicateDocumentTitle(firstH1.textContent || '', props.title ?? '')) {
    firstH1.remove();
  }

  const headings = Array.from(root.querySelectorAll<HTMLElement>('h2, h3, h4'));
  const used = new Set<string>();
  const numbers = headingNumbers(headings.map((heading) => ({
    level: Number(heading.tagName.slice(1)),
    text: heading.textContent || '',
  })));

  outline.value = headings.map((heading, index) => {
    const id = uniqueHeadingId(heading.textContent || '', used);
    const level = Number(heading.tagName.slice(1));
    heading.id = id;
    heading.classList.add('reading-heading');
    heading.dataset.readingNumber = numbers[index];
    if (numbers[index]) heading.classList.add('reading-numbered');
    ensureFoldButton(heading);
    return { id, level, text: heading.textContent || '' };
  });
  currentHeading.value = outline.value[0]?.id || '';
}

/* ---------- 按标题收放 ---------- */

type FoldSection = {
  id: string;
  level: number;
  heading: HTMLElement;
  /** 随该标题一起收放的块（含其下子节） */
  targets: HTMLElement[];
};

const foldSections = ref<FoldSection[]>([]);
/** 已收起的标题 id：仅当前会话有效（切页/刷新后恢复展开） */
const collapsedHeadings = ref<Set<string>>(new Set());

function ensureFoldButton(heading: HTMLElement) {
  if (heading.querySelector(':scope > .reading-fold')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reading-fold';
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-label', '收起本节');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m6 9 6 6 6-6"/></svg>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleFold(heading.id);
  });
  heading.prepend(button);
}

/** 扫描正文块，重建「标题 → 收放范围」映射，并套用当前收放状态 */
function bindFoldSections(root: HTMLElement) {
  const blocks = Array.from(root.children) as HTMLElement[];
  const headingBlocks = blocks
    .map((element, block) => ({ element, block }))
    .filter((item) => item.element.classList.contains('reading-heading'));
  const ranges = headingFoldRanges(
    headingBlocks.map((item) => ({ level: Number(item.element.tagName.slice(1)), block: item.block })),
    blocks.length,
  );

  foldSections.value = headingBlocks.map((item, index) => ({
    id: item.element.id,
    level: ranges[index].level,
    heading: item.element,
    targets: blocks.slice(ranges[index].block + 1, ranges[index].end),
  }));
  applyFoldState();
}

function applyFoldState() {
  // 一个块可能同时属于外层（H2）和内层（H3）两个收放范围：只要任一外层收起就必须隐藏，
  // 因此先求并集再统一切换，避免内层「展开」把外层收起的块又放出来
  const hidden = new Set<HTMLElement>();
  for (const section of foldSections.value) {
    if (!collapsedHeadings.value.has(section.id)) continue;
    for (const target of section.targets) hidden.add(target);
  }
  for (const section of foldSections.value) {
    for (const target of section.targets) {
      target.classList.toggle('reading-folded', hidden.has(target));
    }
    const collapsed = collapsedHeadings.value.has(section.id);
    section.heading.classList.toggle('reading-collapsed', collapsed);
    const button = section.heading.querySelector<HTMLElement>(':scope > .reading-fold');
    button?.setAttribute('aria-expanded', String(!collapsed));
    button?.setAttribute('aria-label', collapsed ? '展开本节' : '收起本节');
  }
}

function toggleFold(id: string) {
  if (!id) return;
  const next = new Set(collapsedHeadings.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedHeadings.value = next;
  applyFoldState();
  scheduleTailSpace();
  updateCurrentHeading();
}

/** 展开包含目标标题的所有折叠节（目录跳到被收起的小节时用），由外到内逐层解开 */
function expandAncestors(heading: HTMLElement): boolean {
  const toExpand = new Set<string>();
  for (let pass = 0; pass < foldSections.value.length; pass++) {
    let changed = false;
    for (const section of foldSections.value) {
      if (toExpand.has(section.id) || !collapsedHeadings.value.has(section.id)) continue;
      if (section.targets.includes(heading)) {
        toExpand.add(section.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!toExpand.size) return false;
  const next = new Set(collapsedHeadings.value);
  for (const id of toExpand) next.delete(id);
  collapsedHeadings.value = next;
  applyFoldState();
  return true;
}

function prepareLinks(root: HTMLElement) {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = link.getAttribute('href') || '';
    if (wikiTargetFromHref(href)) {
      link.classList.add('reading-wikilink');
    } else if (/^https?:\/\//i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
}

/** 大页阅读渲染缓存：Vditor.preview + 后处理对 15 万字页是一次 ~2s 的同步主线程阻塞。
 * 按「标题+转换后正文」作键（内容或标题变即失效），LRU 限 3 份、只缓存 ≥2 万字的页
 * （小页渲染 <100ms，不值得占内存）。存 innerHTML 字符串而非 detached DOM：
 * 复访省 cloneNode，内存也更省；缓存的 HTML 与主题无关（配色走 CSS 变量）。 */
const RENDER_CACHE_MAX = 3;
const RENDER_CACHE_MIN_CHARS = 20_000;
const renderCache = new Map<string, { html: string; outline: OutlineItem[]; metrics: { units: number; minutes: number } }>();

async function renderMarkdown() {
  const host = contentEl.value;
  if (!host) return;
  const version = ++renderVersion;
  const source = wikiLinksToMarkdown(props.markdown);
  const cacheKey = `${props.title}\u0000${source}`;
  const cached = renderCache.get(cacheKey);
  if (cached) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached); // LRU 命中刷新
    host.innerHTML = cached.html;
    outline.value = cached.outline;
    currentHeading.value = cached.outline[0]?.id || '';
    metrics.value = cached.metrics;
    bindFoldSections(host);
    await nextTick();
    if (version !== renderVersion) return;
    readerEl.value?.scrollTo({ top: 0 });
    measureLayout();
    scheduleTailSpace();
    return;
  }
  rendering.value = true;
  const next = document.createElement('div');
  try {
    await Vditor.preview(next, source, vditorPreviewOptions(props.dark));
    if (version !== renderVersion) return;
    wrapTables(next);
    addImageCaptions(next);
    prepareHeadings(next);
    prepareLinks(next);
    // textContent 而非 innerText：纯遍历无布局开销，15 万字页面省数百毫秒，计数结果一致
    metrics.value = readingMetrics(`${props.title}\n${next.textContent}`);
    if (source.length >= RENDER_CACHE_MIN_CHARS) {
      renderCache.set(cacheKey, { html: next.innerHTML, outline: [...outline.value], metrics: metrics.value });
      while (renderCache.size > RENDER_CACHE_MAX) {
        renderCache.delete(renderCache.keys().next().value!);
      }
    }
    host.replaceChildren(...Array.from(next.childNodes));
    bindFoldSections(host);
    await nextTick();
    readerEl.value?.scrollTo({ top: 0 });
    measureLayout();
    scheduleTailSpace();
  } catch (error) {
    if (version !== renderVersion) return;
    console.error('阅读预览渲染失败', error);
    host.textContent = props.markdown;
    outline.value = [];
    metrics.value = readingMetrics(`${props.title}\n${props.markdown}`);
  } finally {
    if (version === renderVersion) rendering.value = false;
  }
}

function handleContentClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
  if (!link) return;
  const target = wikiTargetFromHref(link.getAttribute('href') || '');
  if (!target) return;
  event.preventDefault();
  emit('open-wikilink', target);
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault();
  emit('context-menu', {
    x: event.clientX,
    y: event.clientY,
    selection: selectionInside(event.currentTarget as HTMLElement),
  });
}

function scrollToHeading(id: string) {
  const reader = readerEl.value;
  const heading = contentEl.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!reader || !heading) return;
  // 目录里点到被收起的小节时，先把包含它的折叠节逐层展开再定位
  if (expandAncestors(heading)) scheduleTailSpace();
  const readerRect = reader.getBoundingClientRect();
  const headingY = reader.scrollTop + heading.getBoundingClientRect().top - readerRect.top;
  reader.scrollTo({
    top: Math.max(0, headingY - toolbarHeight.value - 28),
    behavior: 'smooth',
  });
  mobileOutlineOpen.value = false;
}

function keepCurrentOutlineVisible() {
  const nav = outlineNavEl.value;
  const link = nav?.querySelector<HTMLElement>(`a[href="#${CSS.escape(currentHeading.value)}"]`);
  if (!nav || !link) return;
  const navRect = nav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  if (linkRect.top < navRect.top) {
    nav.scrollBy({ top: linkRect.top - navRect.top, behavior: 'smooth' });
  } else if (linkRect.bottom > navRect.bottom) {
    nav.scrollBy({ top: linkRect.bottom - navRect.bottom, behavior: 'smooth' });
  }
}

/** 当前可见（未被折叠节收进去）的标题 */
function visibleHeadings(): HTMLElement[] {
  return Array.from(contentEl.value?.querySelectorAll<HTMLElement>('.reading-heading') || [])
    .filter((heading) => heading.offsetParent !== null);
}

function updateCurrentHeading() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    // 被收起的小节不在视口里参与「当前标题」判定（display:none 的 rect 会退化成 0）
    const headings = visibleHeadings();
    let current = headings[0]?.id || '';
    const anchorOffset = toolbarHeight.value + 28;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= anchorOffset) current = heading.id;
      else break;
    }
    if (currentHeading.value !== current) {
      currentHeading.value = current;
      requestAnimationFrame(keepCurrentOutlineVisible);
    }
  });
}

function measureLayout() {
  toolbarHeight.value = Math.ceil(toolbarEl.value?.getBoundingClientRect().height || 56);
  viewportHeight.value = readerEl.value?.clientHeight || window.innerHeight;
  /* 正文可用区 = 阅读栅格里正文那一列的宽度（已扣掉工具栏留白与右侧目录列），
   * --reading-width 取它的百分比；量不到（首帧）时保持 0，样式回落 100% */
  const main = mainEl.value;
  if (main) availableWidth.value = Math.round(main.clientWidth);
}

function scheduleTailSpace() {
  cancelAnimationFrame(tailFrame);
  tailFrame = requestAnimationFrame(() => {
    const reader = readerEl.value;
    const lastHeading = visibleHeadings().at(-1);
    if (!reader || !lastHeading) {
      tailSpace.value = 0;
      return;
    }
    const readerRect = reader.getBoundingClientRect();
    const lastHeadingY =
      reader.scrollTop + lastHeading.getBoundingClientRect().top - readerRect.top;
    tailSpace.value = requiredReadingTailSpace({
      lastHeadingY,
      anchorOffset: toolbarHeight.value + 28,
      scrollHeightWithoutTail: reader.scrollHeight - tailSpace.value,
      viewportHeight: reader.clientHeight,
    });
  });
}

function handleLayoutChange() {
  measureLayout();
  scheduleTailSpace();
}

function handleMediaChange() {
  mobileOutlineOpen.value = false;
  handleLayoutChange();
}

watch(
  () => [props.markdown, props.title, props.dark],
  () => void renderMarkdown(),
);

/* 换页即恢复展开：按标题收放的状态只属于当前这次阅读会话 */
watch(
  () => props.pageKey,
  () => {
    if (!collapsedHeadings.value.size) return;
    collapsedHeadings.value = new Set();
    applyFoldState();
  },
);

onMounted(() => {
  void renderMarkdown();
  readerEl.value?.focus();
  readerEl.value?.addEventListener('scroll', updateCurrentHeading, { passive: true });
  layoutObserver = new ResizeObserver(handleLayoutChange);
  if (readerEl.value) layoutObserver.observe(readerEl.value);
  if (toolbarEl.value) layoutObserver.observe(toolbarEl.value);
  measureLayout();
  mobileMedia.addEventListener('change', handleMediaChange);
  // pointerdown 覆盖真实点击，click 兜底程序化点击（自动化/辅助工具）
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('click', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  renderVersion++;
  cancelAnimationFrame(scrollFrame);
  cancelAnimationFrame(tailFrame);
  layoutObserver?.disconnect();
  readerEl.value?.removeEventListener('scroll', updateCurrentHeading);
  mobileMedia.removeEventListener('change', handleMediaChange);
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('click', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<style scoped>
.reading-preview {
  --reading-width: 780px;
  --reading-font-size: 16px;
  --reading-line-height: 1.8;
  --reading-toolbar-height: 56px;
  --reading-anchor-offset: 84px;
  --reading-viewport-height: 100dvh;
  position: absolute;
  inset: 0;
  z-index: 20;
  overflow-y: auto;
  background: var(--bg);
  color: var(--text);
}
.reading-toolbar {
  position: sticky;
  top: 0;
  z-index: 5;
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 18px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  backdrop-filter: blur(12px);
}
/* 只作用于步进按钮本身：用直接子选择器，避免样式漏进字号下拉里的 option 按钮 */
.reading-tool,
.font-stepper > button,
.width-segment button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
}
.reading-tool {
  padding: 0 10px;
}
.reading-tool:hover,
.reading-tool[aria-pressed="true"] {
  border-color: var(--control-border);
  background: var(--control-bg-hover);
  color: var(--text);
}
.reading-tool:active {
  background: var(--control-bg-pressed);
}
/* 双链跳转后的返回入口：跟随工具栏，与「返回编辑」区分开图标与文案 */
.back-page {
  border-color: var(--control-border);
  background: var(--control-bg);
  color: var(--text);
  font-weight: 600;
}
.back-page:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.font-stepper > button:hover,
.width-segment button:hover:not([aria-pressed="true"]) {
  background: var(--control-bg-hover);
  color: var(--text);
}
.reading-settings {
  display: flex;
  align-items: center;
  gap: 8px;
}
.font-stepper,
.width-picker {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--control-border);
  border-bottom-color: var(--control-border-strong);
  border-radius: var(--radius-control);
  background: var(--control-bg);
  overflow: hidden;
}
/* 字号下拉要溢出到工具栏下方，不能被组容器的圆角裁剪 */
.font-stepper { overflow: visible; }
.font-stepper > button {
  width: 32px;
  border-radius: 0;
}
.font-stepper > button:first-child { border-radius: var(--radius-control) 0 0 var(--radius-control); }
.font-stepper > button:last-child { border-radius: 0 var(--radius-control) var(--radius-control) 0; }
.font-stepper > button:disabled {
  color: var(--text-faint);
  opacity: 0.45;
  cursor: not-allowed;
}
.font-stepper > button:disabled:hover {
  background: transparent;
  color: var(--text-faint);
}
/* 字号触发器 + 下拉面板：41 档一列可滚动，当前档位高亮 */
.font-picker {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.font-size-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 62px;
  min-height: 32px;
  padding: 0 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.font-size-trigger:hover,
.font-size-trigger[aria-expanded="true"] {
  background: var(--control-bg-hover);
  color: var(--text);
}
.font-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  z-index: 20;
  width: 76px;
  max-height: 264px;
  overflow-y: auto;
  padding: 4px;
  transform: translateX(-50%);
  border: 1px solid var(--control-border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  box-shadow: var(--shadow);
}
.font-menu-item {
  display: block;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: pointer;
}
.font-menu-item:hover {
  background: var(--control-bg-hover);
  color: var(--text);
}
.font-menu-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
/* 正文宽度触发器 + 百分比菜单：按「可用区百分比」选档（默认 70%） */
.width-picker {
  position: relative;
  display: inline-flex;
  overflow: visible;
}
.width-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 58px;
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.width-trigger:hover,
.width-trigger[aria-expanded="true"] {
  background: var(--control-bg-hover);
  color: var(--text);
}
.width-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  z-index: 20;
  width: 84px;
  padding: 4px;
  transform: translateX(-50%);
  border: 1px solid var(--control-border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  box-shadow: var(--shadow);
}
.width-menu button {
  display: block;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: pointer;
}
.width-menu button:hover {
  background: var(--control-bg-hover);
  color: var(--text);
}
.width-menu button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
/* 「显示」菜单：触发钮 + 浮层（行距分段 + 两个勾选项） */
.display-wrap {
  position: relative;
  display: inline-flex;
}
.display-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: 176px;
  padding: 6px;
  border: 1px solid var(--control-border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  box-shadow: var(--shadow);
}
.display-menu-label {
  padding: 4px 8px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}
.display-menu-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-control);
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  margin: 2px 4px 4px;
}
.display-menu-seg button {
  flex: 1;
  padding: 4px 0;
  border: 0;
  border-radius: calc(var(--radius-control) - 2px);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.display-menu-seg button:hover { color: var(--text); }
.display-menu-seg button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.display-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
.display-menu > button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
}
.display-menu > button:hover:not(:disabled) { background: var(--control-bg-hover); color: var(--text); }
.display-menu > button:disabled { opacity: 0.45; cursor: not-allowed; }
.display-menu .check {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 4px;
  border: 1px solid var(--control-border-strong);
  background: var(--control-bg);
  position: relative;
}
.display-menu .check.on {
  background: var(--accent);
  border-color: var(--accent);
}
.display-menu .check.on::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.reading-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 34px;
  align-items: start;
  padding: 34px 38px 70px;
}
.reading-tail-space {
  min-height: 0;
  pointer-events: none;
}
.outline-hidden .reading-grid { grid-template-columns: minmax(0, 1fr); }
.outline-hidden .reading-outline { display: none; }
.reading-main { min-width: 0; }
.reading-article {
  width: min(100%, var(--reading-width));
  margin-inline: auto;
}
.reading-article {
  font-size: var(--reading-font-size);
  line-height: var(--reading-line-height);
  overflow-wrap: anywhere;
}
.reading-document-head {
  margin-bottom: 34px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--border);
}
.reading-document-head h1 {
  margin: 0 0 12px;
  font-size: clamp(28px, 4vw, 38px);
  line-height: 1.28;
  letter-spacing: 0;
}
.reading-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 9px;
  color: var(--text-faint);
  font-size: 12px;
}
.reading-type {
  color: var(--accent);
  font-weight: 650;
}
.reading-meta-sep {
  color: var(--text-faint);
  opacity: 0.7;
}
.reading-tag {
  padding: 2px 8px;
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.reading-content {
  min-height: 240px;
  color: var(--text);
  font-size: inherit;
  line-height: inherit;
  /* 折叠箭头要落在标题左侧的空槽里，而 .vditor-reset 自带 overflow:auto 会把负边距
   * 溢出的内容裁掉：这里把内容盒向左扩 22px 并用等宽 padding 抵消，
   * 箭头落在 padding 区内（不被裁剪、可点击），标题文字仍与正文左对齐 */
  margin-left: -22px;
  padding-left: 22px;
}
.reading-content[aria-busy="true"] { opacity: 0.65; }
/* 正文首个块去掉上外边距：实体页删掉与标题重复的 H1 后，「## 当前理解」的
 * 2.3em 上边距会与文档头的 34px 下边距叠加成 ~90px 空行 */
.reading-content :deep(> :first-child) { margin-top: 0; }
.reading-content :deep(h1) { font-size: 1.75em; }
.reading-content :deep(h2),
.reading-content :deep(h3),
.reading-content :deep(h4) {
  position: relative;
  color: var(--text);
  letter-spacing: 0;
}
.reading-content :deep(.reading-heading) {
  display: flex;
  align-items: center;
  gap: 4px;
  scroll-margin-top: var(--reading-anchor-offset);
}
/* 折叠箭头：桌面落在标题左侧空槽里（标题文字仍与正文左对齐），窄屏改为内联避免出屏 */
.reading-content :deep(.reading-fold) {
  order: -1;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: -22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.reading-content :deep(.reading-fold:hover) {
  background: var(--control-bg-hover);
  color: var(--accent);
}
.reading-content :deep(.reading-fold svg) {
  transition: transform 140ms ease;
}
.reading-content :deep(.reading-collapsed > .reading-fold svg) {
  transform: rotate(-90deg);
}
/* 收起的块整体隐藏；标题本身保留，方便再点开 */
.reading-content :deep(.reading-folded) { display: none; }
.reading-content :deep(.reading-collapsed) { color: var(--text-secondary); }
.reading-content :deep(h2) {
  margin: 2.3em 0 0.8em;
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--border);
  font-size: 1.52em;
  line-height: 1.38;
}
.reading-content :deep(h3) {
  margin: 1.85em 0 0.65em;
  font-size: 1.22em;
  line-height: 1.45;
}
.reading-content :deep(h4) {
  margin: 1.55em 0 0.55em;
  color: var(--text-secondary);
  font-size: 1em;
  line-height: 1.5;
}
.numbered-headings .reading-content :deep(.reading-heading.reading-numbered::before) {
  content: attr(data-reading-number);
  margin-right: 0.5em;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.reading-content :deep(p) { margin: 0 0 1.05em; }
.reading-content :deep(a.reading-wikilink) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  text-decoration: none;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.reading-content :deep(blockquote) {
  margin: 1.3em 0;
  padding: 0.85em 1.1em;
  border-left: 4px solid var(--accent);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.reading-content :deep(ul),
.reading-content :deep(ol) {
  margin: 0.75em 0 1.2em;
  padding-left: 1.65em;
}
.reading-content :deep(li) {
  margin: 0.35em 0;
  padding-left: 0.18em;
}
.reading-content :deep(li::marker) {
  color: var(--accent);
  font-weight: 650;
}
.reading-content :deep(pre) {
  margin: 1.25em 0;
  padding: 18px 20px;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  overflow-x: auto;
}
.reading-content :deep(code) {
  border-radius: var(--radius-control);
  padding: 0.15em 0.38em;
  background: var(--bg-tertiary);
  color: var(--accent);
  font-family: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.86em;
}
.reading-content :deep(pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
}
.reading-content :deep(.reading-table-scroll) {
  margin: 1.25em 0;
  overflow-x: auto;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.reading-content :deep(table) {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
  font-size: 0.92em;
}
.reading-content :deep(th),
.reading-content :deep(td) {
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.reading-content :deep(th) {
  background: var(--bg-secondary);
  font-weight: 650;
}
.reading-content :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin-inline: auto;
  border-radius: var(--radius);
}
.reading-content :deep(figure) { margin: 1.4em 0; }
.reading-content :deep(figcaption) {
  margin-top: 8px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}
.reading-content :deep(.katex-display),
.reading-content :deep(.language-math) {
  max-width: 100%;
  overflow-x: auto;
}
.reading-content :deep(svg) {
  max-width: 100%;
  height: auto;
}
.reading-outline {
  position: sticky;
  top: calc(var(--reading-toolbar-height) + 22px);
  max-height: calc(var(--reading-viewport-height) - var(--reading-toolbar-height) - 44px);
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 6px 0 0 18px;
  border-left: 1px solid var(--border);
}
.reading-outline h2 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 10px;
  color: var(--text-secondary);
  font-size: 12px;
}
.reading-outline nav {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.reading-outline a {
  padding: 5px 8px;
  border-left: 2px solid transparent;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.45;
  text-decoration: none;
}
.reading-outline a[data-level="3"] { padding-left: 18px; }
.reading-outline a[data-level="4"] { padding-left: 30px; }
.reading-outline a:hover,
.reading-outline a.current {
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
/* ---------- 底部悬浮胶囊：字数 / 阅读时长 + 本页关联入口 ----------
   sticky 贴可视区底部（见模板注释）；与编辑视图 .statusbar 同一套毛玻璃语言 */
.reading-statusbar {
  position: sticky;
  bottom: 12px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 12px;
  width: fit-content;
  max-width: calc(100% - 36px);
  height: 30px;
  /* 与 bottom 同值：滚到文末时胶囊停在文档流末端，不会因为多留白而往上跳一格 */
  margin: 0 18px 12px;
  padding: 0 6px 0 12px;
  border: 1px solid var(--border);
  border-radius: 15px;
  background: var(--glass-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 26px -14px rgba(0, 0, 0, 0.28);
  color: var(--text-faint);
  font-size: 11.5px;
}
.reading-stat { white-space: nowrap; }
.reading-rel {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 12px;
  padding: 2px 7px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.reading-rel:hover { background: var(--bg-hover); color: var(--accent); }
.reading-rel[aria-expanded="true"] { background: var(--accent-soft); color: var(--accent); }
.reading-rel-count {
  min-width: 17px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.reading-rel[aria-expanded="true"] .reading-rel-count {
  background: rgba(15, 108, 189, 0.16);
  color: var(--accent);
}
@media (max-width: 1024px) {
  .reading-toolbar { flex-wrap: wrap; }
  .reading-grid { grid-template-columns: minmax(0, 1fr); }
  .reading-outline {
    position: static;
    order: -1;
    width: min(100%, var(--reading-width));
    max-height: min(42dvh, calc(var(--reading-viewport-height) - var(--reading-toolbar-height) - 32px));
    margin-inline: auto;
    padding: 10px 0 14px;
    border: 0;
    border-bottom: 1px solid var(--border);
  }
  .reading-outline nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .reading-outline a,
  .reading-outline a[data-level="3"],
  .reading-outline a[data-level="4"] { padding-left: 8px; }
}
@media (max-width: 768px) {
  .reading-grid { padding: 24px 20px 54px; }
  .reading-outline { display: none; }
  .mobile-outline-open:not(.outline-hidden) .reading-outline { display: block; }
  /* 窄屏没有左槽：箭头改内联，标题文字右移而不是溢出到屏幕外 */
  .reading-content { margin-left: 0; padding-left: 0; }
  .reading-content :deep(.reading-fold) { margin-left: 0; }
  /* 手机端底部导航（Home.vue .bottom-nav）是 fixed 8px + 48px 高：胶囊要抬到它上面 */
  .reading-statusbar {
    bottom: calc(64px + env(safe-area-inset-bottom, 0px));
    margin: 0 10px calc(64px + env(safe-area-inset-bottom, 0px));
    max-width: calc(100% - 20px);
  }
}
@media (max-width: 640px) {
  .reading-toolbar {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) 36px;
    gap: 7px 8px;
    padding: 8px 10px;
  }
  .back {
    grid-column: 1;
    grid-row: 1;
    width: 36px;
    padding: 0;
  }
  .back-label { display: none; }
  .theme-tool {
    grid-column: 3;
    grid-row: 1;
    width: 36px;
    padding: 0;
  }
  /* 窄屏：返回上一页独占一行（可点区域大），设置组顺延到下一行 */
  .back-page {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-content: center;
  }
  /* 返回入口外面包着悬停下拉容器：栅格项是容器，按钮撑满整行 */
  .reading-toolbar :deep(.back-trail) {
    grid-column: 1 / -1;
    grid-row: 2;
    display: flex;
  }
  .reading-toolbar :deep(.back-trail) .back-page { width: 100%; }
  .reading-settings {
    grid-column: 1 / -1;
    grid-row: 3;
    flex-wrap: wrap;
    gap: 7px;
  }
  .reading-grid { padding: 20px 16px 46px; }
  .reading-outline nav { grid-template-columns: minmax(0, 1fr); }
}
</style>
