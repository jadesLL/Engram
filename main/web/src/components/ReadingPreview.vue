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
    @keydown.esc="closeReading"
  >
    <header ref="toolbarEl" class="reading-toolbar">
      <button class="reading-tool back" type="button" v-tooltip="'返回编辑（Esc）'" @click="closeReading">
        <Icon name="chevron-left" :size="17" />
        <span class="back-label">返回编辑</span>
      </button>

      <span class="reading-stats">{{ metrics.units.toLocaleString('zh-CN') }} 字 · 约 {{ metrics.minutes }} 分钟</span>

      <button class="reading-tool theme-tool" type="button" v-tooltip="dark ? '切换到浅色' : '切换到深色'" @click="app.toggleResolvedTheme()">
        <Icon :name="dark ? 'sun' : 'moon'" :size="17" />
      </button>

      <div class="reading-settings">
        <div class="font-stepper" aria-label="正文字号">
          <button type="button" aria-label="减小字号" @click="stepFont(-1)">A−</button>
          <span>{{ preferences.fontSize }}px</span>
          <button type="button" aria-label="增大字号" @click="stepFont(1)">A+</button>
        </div>

        <div class="width-segment" aria-label="正文宽度">
          <button
            v-for="option in widthOptions"
            :key="option.value"
            type="button"
            :aria-pressed="preferences.width === option.value"
            @click="updatePreferences({ width: option.value })"
          >{{ option.label }}</button>
        </div>

        <select
          class="line-height-select"
          :value="preferences.lineHeight"
          aria-label="正文行距"
          @change="setLineHeight"
        >
          <option :value="1.6">紧凑</option>
          <option :value="1.8">舒适</option>
          <option :value="2">宽松</option>
        </select>

        <label class="reading-switch">
          <input
            type="checkbox"
            :checked="preferences.numberedHeadings"
            @change="toggleNumbering"
          />
          <span>编号</span>
        </label>

        <button
          class="reading-tool outline-tool"
          type="button"
          :aria-pressed="outlinePressed"
          :disabled="outline.length === 0"
          v-tooltip="'显示或隐藏目录'"
          @click="toggleOutline"
        >
          <Icon name="list-tree" :size="17" />
          <span class="outline-label">目录</span>
        </button>
      </div>
    </header>

    <div class="reading-grid">
      <div class="reading-main">
        <article class="reading-article" @contextmenu="handleContextMenu">
          <header class="reading-document-head">
            <p class="reading-kicker">{{ typeLabel }}</p>
            <h1>{{ title }}</h1>
            <div class="reading-meta">
              <span v-if="updatedAt">更新于 {{ formatDate(updatedAt) }}</span>
              <span v-for="tag in tags" :key="tag" class="reading-tag">{{ tag }}</span>
            </div>
          </header>

          <div
            ref="contentEl"
            class="reading-content vditor-reset"
            :aria-busy="rendering"
            @click="handleContentClick"
          />
        </article>

        <section v-if="hasRelated" class="reading-related" aria-label="本页关联">
          <p>本页关联</p>
          <div>
            <button
              v-for="item in related?.neighbors || []"
              :key="`n-${item.id}`"
              type="button"
              @click="emit('open-related', item.id)"
            >{{ item.direction === 'out' ? '→' : '←' }} {{ item.title }}</button>
            <button
              v-for="item in related?.similar || []"
              :key="`s-${item.id}`"
              type="button"
              @click="emit('open-related', item.id)"
            >≈ {{ item.title }}</button>
            <span v-for="item in related?.entities || []" :key="`e-${item.name}`">{{ item.name }}</span>
          </div>
        </section>
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
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Vditor from 'vditor';
import { useAppStore } from '../stores/app';
import {
  headingNumbers,
  isDuplicateDocumentTitle,
  readingMetrics,
  requiredReadingTailSpace,
  uniqueHeadingId,
  type ReadingFontSize,
  type ReadingLineHeight,
  type ReadingPreferences,
  type ReadingWidth,
} from '../lib/readingPreview';
import { wikiLinksToMarkdown, wikiTargetFromHref } from '../lib/wikiLinks';
import { vditorPreviewOptions } from '../lib/vditorPreview';
import {
  selectionInside,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import Icon from './Icon.vue';

type OutlineItem = {
  id: string;
  level: number;
  text: string;
};

const props = defineProps<{
  markdown: string;
  title: string;
  pageType: string;
  tags: string[];
  updatedAt?: string;
  dark: boolean;
  related?: any;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'open-wikilink', title: string): void;
  (event: 'open-related', id: string): void;
  (event: 'context-menu', request: SelectionContextMenuRequest): void;
}>();

const app = useAppStore();
const readerEl = ref<HTMLElement>();
const toolbarEl = ref<HTMLElement>();
const contentEl = ref<HTMLDivElement>();
const outlineNavEl = ref<HTMLElement>();
const outline = ref<OutlineItem[]>([]);
const currentHeading = ref('');
const rendering = ref(false);
const mobileOutlineOpen = ref(false);
const metrics = ref({ units: 0, minutes: 1 });
const toolbarHeight = ref(56);
const viewportHeight = ref(0);
const tailSpace = ref(0);
const mobileMedia = window.matchMedia('(max-width: 768px)');
let renderVersion = 0;
let scrollFrame = 0;
let tailFrame = 0;
let layoutObserver: ResizeObserver | null = null;

const fontOptions: ReadingFontSize[] = [15, 16, 18];
const widthOptions: Array<{ value: ReadingWidth; label: string }> = [
  { value: 680, label: '窄' },
  { value: 780, label: '标准' },
  { value: 960, label: '宽' },
];

const preferences = computed(() => app.readingPreferences);
const outlinePressed = computed(() =>
  outline.value.length > 0 &&
  (mobileMedia.matches ? mobileOutlineOpen.value : preferences.value.outline)
);
const readingStyle = computed(() => ({
  '--reading-width': `${preferences.value.width}px`,
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
  place: '地点',
  work: '作品',
  project: '产品',
  other: '其他',
  note: '知识页面',
}[props.pageType] || '知识页面'));
const hasRelated = computed(() =>
  Boolean(
    props.related?.neighbors?.length ||
    props.related?.similar?.length ||
    props.related?.entities?.length
  )
);

function updatePreferences(value: Partial<ReadingPreferences>) {
  app.updateReadingPreferences(value);
}

function stepFont(direction: number) {
  const index = fontOptions.indexOf(preferences.value.fontSize);
  const next = Math.max(0, Math.min(fontOptions.length - 1, index + direction));
  updatePreferences({ fontSize: fontOptions[next] });
}

function setLineHeight(event: Event) {
  updatePreferences({
    lineHeight: Number((event.target as HTMLSelectElement).value) as ReadingLineHeight,
  });
}

function toggleNumbering(event: Event) {
  updatePreferences({
    numberedHeadings: (event.target as HTMLInputElement).checked,
  });
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
  if (firstH1 && isDuplicateDocumentTitle(firstH1.textContent || '', props.title)) {
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
    return { id, level, text: heading.textContent || '' };
  });
  currentHeading.value = outline.value[0]?.id || '';
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

async function renderMarkdown() {
  const host = contentEl.value;
  if (!host) return;
  const version = ++renderVersion;
  rendering.value = true;
  const next = document.createElement('div');
  try {
    await Vditor.preview(
      next,
      wikiLinksToMarkdown(props.markdown),
      vditorPreviewOptions(props.dark),
    );
    if (version !== renderVersion) return;
    wrapTables(next);
    addImageCaptions(next);
    prepareHeadings(next);
    prepareLinks(next);
    metrics.value = readingMetrics(`${props.title}\n${next.innerText}`);
    host.replaceChildren(...Array.from(next.childNodes));
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

function updateCurrentHeading() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    const headings = Array.from(contentEl.value?.querySelectorAll<HTMLElement>('.reading-heading') || []);
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
}

function scheduleTailSpace() {
  cancelAnimationFrame(tailFrame);
  tailFrame = requestAnimationFrame(() => {
    const reader = readerEl.value;
    const headings = Array.from(contentEl.value?.querySelectorAll<HTMLElement>('.reading-heading') || []);
    const lastHeading = headings.at(-1);
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

onMounted(() => {
  void renderMarkdown();
  readerEl.value?.focus();
  readerEl.value?.addEventListener('scroll', updateCurrentHeading, { passive: true });
  layoutObserver = new ResizeObserver(handleLayoutChange);
  if (readerEl.value) layoutObserver.observe(readerEl.value);
  if (toolbarEl.value) layoutObserver.observe(toolbarEl.value);
  measureLayout();
  mobileMedia.addEventListener('change', handleMediaChange);
});

onBeforeUnmount(() => {
  renderVersion++;
  cancelAnimationFrame(scrollFrame);
  cancelAnimationFrame(tailFrame);
  layoutObserver?.disconnect();
  readerEl.value?.removeEventListener('scroll', updateCurrentHeading);
  mobileMedia.removeEventListener('change', handleMediaChange);
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
.reading-tool,
.font-stepper button,
.width-segment button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
}
.reading-tool {
  padding: 0 10px;
}
.reading-tool:hover,
.reading-tool[aria-pressed="true"] {
  border-color: var(--border);
  background: var(--bg-hover);
  color: var(--text);
}
.reading-stats {
  margin-right: auto;
  color: var(--text-faint);
  font-size: 12px;
  white-space: nowrap;
}
.reading-settings {
  display: flex;
  align-items: center;
  gap: 8px;
}
.font-stepper,
.width-segment {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.font-stepper button {
  width: 32px;
  border-radius: 0;
}
.font-stepper span {
  min-width: 42px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}
.width-segment button {
  padding: 0 10px;
  border-left-color: var(--border);
  border-radius: 0;
  font-size: 12px;
}
.width-segment button:first-child { border-left: 0; }
.width-segment button[aria-pressed="true"] {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.line-height-select {
  min-height: 34px;
  padding-block: 0;
  color: var(--text-secondary);
}
.reading-switch {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-inline: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.reading-switch input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
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
.reading-article,
.reading-related {
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
.reading-kicker {
  margin: 0 0 8px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 650;
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
  gap: 8px 14px;
  color: var(--text-faint);
  font-size: 12px;
}
.reading-tag {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.reading-content {
  min-height: 240px;
  color: var(--text);
  font-size: inherit;
  line-height: inherit;
}
.reading-content[aria-busy="true"] { opacity: 0.65; }
.reading-content :deep(h1) { font-size: 1.75em; }
.reading-content :deep(h2),
.reading-content :deep(h3),
.reading-content :deep(h4) {
  position: relative;
  color: var(--text);
  letter-spacing: 0;
}
.reading-content :deep(.reading-heading) {
  scroll-margin-top: var(--reading-anchor-offset);
}
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
  border-radius: 0;
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
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-secondary);
  overflow-x: auto;
}
.reading-content :deep(code) {
  border-radius: 4px;
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
  border-radius: 6px;
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
.reading-related {
  margin-top: 36px;
  padding-top: 16px;
  border-top: 1px dashed var(--border);
}
.reading-related p {
  margin: 0 0 8px;
  color: var(--text-faint);
  font-size: 12px;
}
.reading-related > div {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.reading-related button,
.reading-related span {
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
}
.reading-related button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
@media (max-width: 1024px) {
  .reading-toolbar { flex-wrap: wrap; }
  .reading-stats { order: 10; width: 100%; }
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
  .back-label,
  .outline-label { display: none; }
  .reading-stats {
    grid-column: 2;
    grid-row: 1;
    width: auto;
    margin: 0;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
  }
  .theme-tool {
    grid-column: 3;
    grid-row: 1;
    width: 36px;
    padding: 0;
  }
  .reading-settings {
    grid-column: 1 / -1;
    grid-row: 2;
    flex-wrap: wrap;
    gap: 7px;
  }
  .reading-grid { padding: 20px 16px 46px; }
  .reading-outline nav { grid-template-columns: minmax(0, 1fr); }
}
</style>
