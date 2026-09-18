<template>
  <div ref="rootEl" class="pdf-viewer">
    <div class="pdf-toolbar">
      <button class="icon-btn" v-tooltip="'上一页'" :disabled="pageNumber <= 1" @click="goToPage(pageNumber - 1)">
        <Icon name="chevron-left" :size="16" />
      </button>
      <label class="page-control">
        <input
          :value="pageNumber"
          inputmode="numeric"
          aria-label="当前页"
          @change="changePageInput"
        />
        <span>/ {{ pageCount || 0 }}</span>
      </label>
      <button class="icon-btn" v-tooltip="'下一页'" :disabled="pageNumber >= pageCount" @click="goToPage(pageNumber + 1)">
        <Icon name="chevron-right" :size="16" />
      </button>

      <span class="toolbar-separator" />
      <button class="icon-btn" v-tooltip="'缩小'" @click="zoomBy(-0.15)"><Icon name="zoom-out" :size="16" /></button>
      <span class="zoom-label">{{ Math.round(effectiveScale * 100) }}%</span>
      <button class="icon-btn" v-tooltip="'放大'" @click="zoomBy(0.15)"><Icon name="zoom-in" :size="16" /></button>
      <button class="icon-btn" v-tooltip="'适合宽度'" :class="{ active: fitWidth }" @click="fitToWidth">
        <Icon name="fit-width" :size="16" />
      </button>

      <span class="toolbar-spacer" />
      <div class="pdf-search">
        <input
          v-model="searchQuery"
          type="search"
          placeholder="搜索文档"
          aria-label="搜索 PDF"
          @keydown.enter.prevent="findNext"
        />
        <span v-if="searchQuery" class="search-count">
          {{ searchMatches.length ? `${searchIndex + 1}/${searchMatches.length}` : '0/0' }}
        </span>
        <button class="icon-btn" v-tooltip="'上一个匹配'" :disabled="!searchMatches.length" @click="findPrevious">
          <Icon name="chevron-up" :size="14" />
        </button>
        <button class="icon-btn" v-tooltip="'下一个匹配'" :disabled="searching" @click="findNext">
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <button class="icon-btn" v-tooltip="'全屏'" @click="toggleFullscreen">
        <Icon name="maximize" :size="16" />
      </button>
    </div>

    <div class="pdf-workspace">
      <aside ref="thumbnailEl" class="pdf-thumbnails" aria-label="PDF 页面缩略图">
        <button
          v-for="page in pageCount"
          :key="page"
          ref="thumbnailButtons"
          type="button"
          :data-page="page"
          :class="{ active: page === pageNumber }"
          v-tooltip="`第 ${page} 页`"
          @click="goToPage(page)"
        >
          <img v-if="thumbnailUrls[page - 1]" :src="thumbnailUrls[page - 1]" alt="" />
          <span v-else class="thumbnail-loading">{{ page }}</span>
          <small>{{ page }}</small>
        </button>
      </aside>

      <div ref="scrollEl" class="pdf-scroll">
        <div v-if="loading" class="pdf-message">正在加载 PDF…</div>
        <div v-else-if="error" class="pdf-message error">{{ error }}</div>
        <div v-else class="pdf-canvas-wrap" :class="{ rendering: pageRendering }">
          <canvas ref="canvasEl" />
        </div>
        <div v-if="!loading && !error && pageRendering" class="pdf-rendering-status">
          正在渲染第 {{ pageNumber }} 页…
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, ref, watch } from 'vue';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import Icon from './Icon.vue';

GlobalWorkerOptions.workerSrc = workerUrl;

const props = withDefaults(defineProps<{
  url: string;
  extractedPages?: Array<{ pageNumber: number; text: string }>;
}>(), {
  extractedPages: () => [],
});

const rootEl = ref<HTMLDivElement>();
const scrollEl = ref<HTMLDivElement>();
const canvasEl = ref<HTMLCanvasElement>();
const thumbnailEl = ref<HTMLElement>();
const thumbnailButtons = ref<HTMLButtonElement[]>([]);
const loading = ref(true);
const error = ref('');
const pageRendering = ref(false);
const pageCount = ref(0);
const pageNumber = ref(1);
const zoom = ref(1);
const effectiveScale = ref(1);
const fitWidth = ref(true);
const thumbnailUrls = ref<string[]>([]);
const searchQuery = ref('');
const searching = ref(false);
const searchMatches = ref<number[]>([]);
const searchIndex = ref(-1);

let loadingTask: PDFDocumentLoadingTask | null = null;
let pdfDocument: PDFDocumentProxy | null = null;
let renderTask: RenderTask | null = null;
let loadVersion = 0;
let resizeObserver: ResizeObserver | null = null;
let thumbnailObserver: IntersectionObserver | null = null;
let searchTexts: string[] | null = null;
let renderVersion = 0;
let renderQueue: Promise<void> = Promise.resolve();
let thumbnailQueue: Promise<void> = Promise.resolve();
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let initializing = false;
const pendingThumbnails = new Set<number>();

async function loadPdf() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = '';
  pageCount.value = 0;
  pageNumber.value = 1;
  thumbnailUrls.value = [];
  searchTexts = null;
  searchMatches.value = [];
  searchIndex.value = -1;
  pageRendering.value = false;
  initializing = true;
  renderVersion++;
  renderTask?.cancel();
  renderTask = null;
  thumbnailObserver?.disconnect();
  pendingThumbnails.clear();
  thumbnailQueue = Promise.resolve();
  await loadingTask?.destroy().catch(() => {});
  pdfDocument = null;
  loadingTask = getDocument({ url: props.url, withCredentials: true });
  try {
    const loaded = await loadingTask.promise;
    if (version !== loadVersion) return;
    pdfDocument = loaded;
    pageCount.value = loaded.numPages;
    thumbnailUrls.value = Array.from({ length: loaded.numPages }, () => '');
    loading.value = false;
    await nextTick();
    await renderCurrentPage();
    initializing = false;
    observeThumbnails(version);
  } catch (loadError: any) {
    if (version !== loadVersion) return;
    error.value = /password/i.test(String(loadError?.message || ''))
      ? '该 PDF 受密码保护，暂时无法在线查看。'
      : 'PDF 加载失败，请下载后检查文件。';
    loading.value = false;
    initializing = false;
  }
}

function renderCurrentPage(): Promise<void> {
  const version = ++renderVersion;
  pageRendering.value = true;
  renderTask?.cancel();
  renderQueue = renderQueue
    .catch(() => {})
    .then(() => renderPage(version));
  return renderQueue;
}

async function renderPage(version: number) {
  if (version !== renderVersion) return;
  if (!pdfDocument || !canvasEl.value || !scrollEl.value) {
    if (version === renderVersion) pageRendering.value = false;
    return;
  }
  let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
  let task: RenderTask | null = null;
  try {
    page = await pdfDocument.getPage(pageNumber.value);
    if (version !== renderVersion) return;
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(260, scrollEl.value.clientWidth - 48);
    const scale = fitWidth.value ? availableWidth / base.width : zoom.value;
    effectiveScale.value = scale;
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = canvasEl.value;
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    renderTask = task;
    await task.promise;
  } catch (renderError: any) {
    if (renderError?.name !== 'RenderingCancelledException') {
      console.error('PDF 页面渲染失败', renderError);
    }
  } finally {
    if (renderTask === task) renderTask = null;
    if (version === renderVersion) pageRendering.value = false;
    page?.cleanup();
  }
}

function observeThumbnails(version: number) {
  thumbnailObserver?.disconnect();
  const root = thumbnailEl.value;
  if (!root) return;
  thumbnailObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const page = Number((entry.target as HTMLElement).dataset.page);
      if (Number.isInteger(page)) queueThumbnail(page, version);
    }
  }, {
    root,
    rootMargin: '320px 0px',
  });
  for (const button of thumbnailButtons.value) thumbnailObserver.observe(button);
  queueThumbnail(pageNumber.value, version);
}

function queueThumbnail(pageNumber: number, version = loadVersion) {
  if (
    version !== loadVersion ||
    thumbnailUrls.value[pageNumber - 1] ||
    pendingThumbnails.has(pageNumber)
  ) return;
  pendingThumbnails.add(pageNumber);
  thumbnailQueue = thumbnailQueue
    .catch(() => {})
    .then(() => renderThumbnail(pageNumber, version))
    .finally(() => pendingThumbnails.delete(pageNumber));
}

async function renderThumbnail(pageNumber: number, version: number) {
  if (version !== loadVersion || !pdfDocument) return;
  let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
  try {
    page = await pdfDocument.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 104 / base.width });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (context) {
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      if (version === loadVersion) {
        const next = [...thumbnailUrls.value];
        next[pageNumber - 1] = canvas.toDataURL('image/jpeg', 0.72);
        thumbnailUrls.value = next;
      }
    }
  } catch {
    // A missing thumbnail must not block the main page viewer.
  } finally {
    page?.cleanup();
  }
}

function queueResizeRender() {
  if (initializing || loading.value || !fitWidth.value || !pdfDocument) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    if (!initializing && fitWidth.value) void renderCurrentPage();
  }, 120);
}

async function buildSearchIndex() {
  if (!pdfDocument || searchTexts) return;
  searching.value = true;
  const texts: string[] = [];
  const extracted = new Map(
    props.extractedPages
      .filter((page) => page.text.trim())
      .map((page) => [page.pageNumber, page.text])
  );
  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      if (extracted.has(pageNumber)) {
        texts.push(extracted.get(pageNumber)!);
        continue;
      }
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      texts.push(content.items.map((item: any) => item?.str || '').join(' '));
      page.cleanup();
    }
    searchTexts = texts;
  } finally {
    searching.value = false;
  }
}

/** Android 本地端复用 PDF.js，只提取文件自带的文字层；扫描件不触发 OCR。 */
async function extractEmbeddedText(): Promise<Array<{ pageNumber: number; text: string }>> {
  if (!pdfDocument && loadingTask) await loadingTask.promise;
  await buildSearchIndex();
  return (searchTexts || []).map((text, index) => ({ pageNumber: index + 1, text }));
}

async function refreshMatches() {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN');
  if (!query) {
    searchMatches.value = [];
    searchIndex.value = -1;
    return;
  }
  await buildSearchIndex();
  const matches: number[] = [];
  searchTexts?.forEach((text, index) => {
    const normalized = text.toLocaleLowerCase('zh-CN');
    let position = 0;
    while ((position = normalized.indexOf(query, position)) >= 0) {
      matches.push(index + 1);
      position += Math.max(1, query.length);
    }
  });
  searchMatches.value = matches;
  searchIndex.value = matches.length ? 0 : -1;
}

async function findNext() {
  if (!searchQuery.value.trim()) return;
  const hadMatches = searchMatches.value.length > 0;
  if (!hadMatches) await refreshMatches();
  if (!searchMatches.value.length) return;
  if (hadMatches && searchIndex.value >= 0) {
    searchIndex.value = (searchIndex.value + 1) % searchMatches.value.length;
  }
  await goToPage(searchMatches.value[searchIndex.value]);
}

async function findPrevious() {
  if (!searchMatches.value.length) {
    await refreshMatches();
    if (!searchMatches.value.length) return;
  }
  searchIndex.value = (searchIndex.value - 1 + searchMatches.value.length) % searchMatches.value.length;
  await goToPage(searchMatches.value[searchIndex.value]);
}

async function goToPage(page: number) {
  if (!pageCount.value) return;
  const next = Math.max(1, Math.min(pageCount.value, Math.round(page)));
  pageNumber.value = next;
  scrollEl.value?.scrollTo({ top: 0, behavior: 'smooth' });
  await renderCurrentPage();
  const thumbnail = thumbnailButtons.value.find((button) => Number(button.dataset.page) === next);
  thumbnail?.scrollIntoView({ block: 'nearest' });
  queueThumbnail(next);
}

function changePageInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  void goToPage(Number.isFinite(value) ? value : pageNumber.value);
}

function zoomBy(delta: number) {
  fitWidth.value = false;
  zoom.value = Math.max(0.35, Math.min(3.5, effectiveScale.value + delta));
  void renderCurrentPage();
}

function fitToWidth() {
  fitWidth.value = true;
  void renderCurrentPage();
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) await rootEl.value?.requestFullscreen();
  else await document.exitFullscreen();
}

defineExpose({ goToPage, extractEmbeddedText });

watch(() => props.url, loadPdf);
watch(() => props.extractedPages, () => {
  searchTexts = null;
  searchMatches.value = [];
  searchIndex.value = -1;
}, { deep: true });
watch(searchQuery, () => {
  searchMatches.value = [];
  searchIndex.value = -1;
});

onBeforeUpdate(() => {
  thumbnailButtons.value = [];
});

onMounted(() => {
  void loadPdf();
  if (scrollEl.value) {
    resizeObserver = new ResizeObserver(queueResizeRender);
    resizeObserver.observe(scrollEl.value);
  }
});

onBeforeUnmount(() => {
  loadVersion++;
  renderVersion++;
  resizeObserver?.disconnect();
  thumbnailObserver?.disconnect();
  if (resizeTimer) clearTimeout(resizeTimer);
  renderTask?.cancel();
  void loadingTask?.destroy();
});
</script>

<style scoped>
.pdf-viewer { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg-soft); }
.pdf-toolbar {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.icon-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 6px;
}
.icon-btn:hover:not(:disabled), .icon-btn.active { background: var(--bg-hover); color: var(--accent); }
.page-control { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-secondary); }
.page-control input { width: 42px; height: 28px; padding: 2px 5px; text-align: center; }
.zoom-label { min-width: 42px; text-align: center; font-size: 11px; color: var(--text-secondary); }
.toolbar-separator { width: 1px; height: 20px; margin: 0 4px; background: var(--border); }
.toolbar-spacer { flex: 1; }
.pdf-search { height: 32px; display: flex; align-items: center; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.pdf-search:focus-within { border-color: var(--accent); }
.pdf-search input { width: min(180px, 18vw); height: 30px; border: 0; background: transparent; padding: 4px 7px; }
.pdf-search input:focus { outline: none; }
.pdf-search .icon-btn { width: 27px; height: 28px; }
.search-count { min-width: 34px; font-size: 10px; text-align: center; color: var(--text-tertiary); }
.pdf-workspace { flex: 1; min-height: 0; display: flex; }
.pdf-thumbnails {
  width: 132px;
  overflow-y: auto;
  padding: 10px 8px 24px;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
}
.pdf-thumbnails button {
  width: 100%;
  min-height: 132px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px;
  margin-bottom: 8px;
  border: 1px solid transparent;
  border-radius: 6px;
}
.pdf-thumbnails button:hover { background: var(--bg-hover); }
.pdf-thumbnails button.active { border-color: var(--accent); background: var(--bg); }
.pdf-thumbnails img { width: 104px; max-height: 118px; object-fit: contain; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.16); }
.pdf-thumbnails small { font-size: 10px; color: var(--text-secondary); }
.thumbnail-loading { width: 104px; height: 118px; display: grid; place-items: center; background: var(--bg); color: var(--text-tertiary); }
.pdf-scroll { flex: 1; min-width: 0; overflow: auto; padding: 24px; position: relative; }
.pdf-canvas-wrap { min-width: max-content; display: flex; justify-content: center; transition: opacity 100ms ease; }
.pdf-canvas-wrap.rendering { opacity: 0.72; }
.pdf-canvas-wrap canvas { display: block; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.18); }
.pdf-rendering-status {
  position: sticky;
  left: 50%;
  bottom: 18px;
  z-index: 2;
  width: max-content;
  margin: -42px auto 0;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  box-shadow: var(--shadow);
  color: var(--text-secondary);
  font-size: 12px;
  pointer-events: none;
}
.pdf-message { height: 100%; display: grid; place-items: center; color: var(--text-secondary); }
.pdf-message.error { color: var(--danger); }
.pdf-viewer:fullscreen { background: var(--bg-soft); }

@media (max-width: 768px) {
  .pdf-toolbar { flex-wrap: wrap; }
  .toolbar-spacer { display: none; }
  .pdf-search { order: 2; width: 100%; }
  .pdf-search input { flex: 1; width: auto; }
  .pdf-thumbnails { width: 82px; padding-inline: 5px; }
  .pdf-thumbnails button { min-height: 92px; }
  .pdf-thumbnails img, .thumbnail-loading { width: 66px; height: 74px; }
  .pdf-scroll { padding: 12px; }
}
</style>
