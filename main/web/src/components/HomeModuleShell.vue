<template>
  <section ref="root" class="shell" :class="{ managing, dragging, compact, short: size.h < 180, capture: functional, micro: size.w < 100 || size.h < 90 }" :style="{ padding: `${padding}px` }"
    :tabindex="managing ? 0 : -1" :aria-label="title" @pointerdown="onPointerDown" @click.capture="suppressClick">
    <!-- 标题栏只有标准档（w≥2 且 h≥2）才画：磁贴 / 横条 / 竖条把空间全部留给内容 -->
    <header v-if="tier === 'standard' && !functional" class="shell-head"><h3><Icon :name="meta.icon" :size="15" />{{ title }}</h3><button type="button" class="shell-expand" :aria-label="`展开${title}`" @click="openDetail"><Icon name="arrow-up-right" :size="13" /></button></header>
    <HomeAdaptiveSummary v-if="compact" :summary="summary" :title="title" :short-title="tinyTitle" :tier="tier" :icon="meta.icon" @open="openDetail" @activate="$emit('activate', $event)" />
    <!-- 始终保留同一个模块实例；打开详情、改变尺寸不会丢失速记草稿。 -->
    <Teleport to="body" :disabled="!expanded">
      <div class="shell-content" :class="{ 'detail-overlay': expanded, 'content-hidden': compact && !expanded }" :role="expanded ? 'dialog' : undefined" :aria-modal="expanded ? true : undefined" :aria-label="expanded ? title : undefined" @keydown="onDetailKey">
        <button v-if="expanded" class="detail-backdrop" type="button" aria-label="关闭详情" @click="closeDetail" />
        <div class="shell-body" :class="{ 'detail-panel': expanded }">
          <header v-if="expanded" class="detail-head"><h2>{{ title }}</h2><button ref="closeButton" class="detail-close" type="button" aria-label="关闭详情" @click="closeDetail">×</button></header>
          <div class="module-content"><slot :expanded="expanded" :open="openDetail" :close="closeDetail" /></div>
        </div>
      </div>
    </Teleport>
    <button v-if="managing" class="card-settings" type="button" :aria-label="`设置${title}尺寸`" @click="openSettings">⋯</button>
    <button v-if="managing" class="resize-handle" type="button" aria-label="拖动调整宽高" @pointerdown.stop.prevent="$emit('resize-request', $event)" />
    <Teleport to="body"><dialog ref="settings" class="size-dialog" @click="onDialogClick" @close="stopSettingsBack?.()">
      <header class="detail-head"><h2>调整「{{ title }}」</h2><button type="button" class="detail-close" aria-label="关闭尺寸设置" @click="settings?.close()">×</button></header>
      <p class="size-hint">{{ hoverSize || `${width} × ${height}` }} · 宽 × 高（格）<span class="size-unit">1 格 ≈ {{ Math.round(cellPx) }}px</span></p>
      <div class="size-matrix" :style="{ '--size-cols': GRID_COLS }" @mouseleave="hoverSize = ''"><template v-for="h in sizeMatrixRows" :key="h"><button v-for="w in GRID_COLS" :key="w" type="button" :class="{ selected: w <= width && h <= height }" :aria-label="`${w} × ${h}`" @mouseenter="hoverSize = `${w} × ${h}`" @focus="hoverSize = `${w} × ${h}`" @click="$emit('set-size', w, h)" /></template></div>
      <div class="size-fields"><label>宽度 <input type="number" min="1" :max="GRID_COLS" :value="width" @change="$emit('set-size', Number(($event.target as HTMLInputElement).value), height)" /></label><label>高度 <input type="number" min="1" :max="GRID_MAX_H" :value="height" @change="$emit('set-size', width, Number(($event.target as HTMLInputElement).value))" /></label><label v-if="limit !== undefined">{{ kind === 'heat' ? '周数' : '条数' }} <input type="number" :min="kind === 'heat' ? 4 : 1" :max="kind === 'tasks' ? 20 : 12" :value="limit" @change="$emit('set-opt', 'limit', Number(($event.target as HTMLInputElement).value))" /></label></div>
      <fieldset v-if="kind === 'capture'" class="capture-styles"><legend>输入样式</legend><label><input type="radio" :name="`capture-style-${$.uid}`" :checked="captureStyle === 1" @change="$emit('set-opt', 'captureStyle', 1)" /> A · 紧凑单行</label><label><input type="radio" :name="`capture-style-${$.uid}`" :checked="captureStyle !== 1" @change="$emit('set-opt', 'captureStyle', 2)" /> B · 多行书写</label><p>小格与竖卡自动显示快捷动作；一格高直接输入，切换保留草稿。</p></fieldset>
      <footer class="settings-actions"><button type="button" @click="$emit('rename')">修改标题</button><button type="button" class="danger" @click="settings?.close(); $emit('remove')">移除卡片</button><button type="button" class="done" @click="settings?.close()">完成</button></footer>
    </dialog></Teleport>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import HomeAdaptiveSummary from './HomeAdaptiveSummary.vue';
import type { HomeCardSummary, HomeCardRow } from '../lib/homeCardPresentation.ts';
import { registerBackHandler } from '../lib/androidBack';
import { moduleMeta, type ModuleKind } from '../lib/homeBoard.ts';
import { GRID_COLS, GRID_MAX_H } from '../lib/homeGrid.ts';
import { cardTier } from '../lib/homeCardPresentation.ts';
const props = defineProps<{ kind: ModuleKind; title: string; width: number; height: number; limit?: number; captureStyle?: number; managing: boolean; dragging: boolean; target?: boolean; summary: HomeCardSummary }>();
const emit = defineEmits<{ (e: 'remove' | 'rename'): void; (e: 'set-size', w: number, h: number): void; (e: 'set-opt', key: string, value: number): void; (e: 'drag-request' | 'resize-request', event: PointerEvent): void; (e: 'activate', row: HomeCardRow): void }>();
const root = ref<HTMLElement | null>(null), settings = ref<HTMLDialogElement | null>(null), closeButton = ref<HTMLButtonElement | null>(null);
const size = ref({ w: 300, h: 300 });
/** 尺寸菜单里的格子边长：卡片宽度减去格间 14px 留白后均分，让「1 格多大」看得见 */
const cellPx = computed(() => {
  const columns = Math.max(1, props.width);
  return Math.max(24, Math.round((size.value.w + 14) / columns - 14));
});
/** 尺寸矩阵画几行高度：常用高度只到 6 行，再高就用下面的数字框 */
const sizeMatrixRows = 6;
const meta = computed(() => moduleMeta(props.kind));
/** 内容档位由栅格格数决定（用户在尺寸菜单看到的 w × h），与像素无关 */
const tier = computed(() => cardTier(props.width, props.height));
const shortTitles: Record<ModuleKind, string> = { ask: '问答', capture: '灵感', shortcuts: '入口', recent: '更新', notes: '灵感', fresh: '新增', tasks: '待办', stats: '概览', weekly: '动态', tags: '标签', sections: '分区', roam: '漫游', system: '状态', sync: '同步', ring: '占比', heat: '热力', inbox: '收集', queue: '提炼', board: '看板', activity: '改动', digest: '摘要' };
const tinyTitle = computed(() => props.title === meta.value.title ? shortTitles[props.kind] : props.title);
/** 动作卡自己按尺寸切换功能；其他卡沿用摘要与详情分档。 */
const functional = computed(() => props.kind === 'ask' || props.kind === 'capture');
const compact = computed(() => {
  if (functional.value) return false;
  if (tier.value === 'tile') return true;
  if (props.kind === 'heat') return !(props.width >= 2 && props.height >= 2);
  if (props.kind === 'shortcuts') return tier.value !== 'bar';
  return true;
});
const padding = computed(() => functional.value ? (props.width === 1 ? 7 : props.height === 1 ? 10 : 14) : size.value.w < 100 || size.value.h < 90 ? 6 : size.value.w < 200 || size.value.h < 200 ? 12 : 20);
const expanded = ref(false), hoverSize = ref('');
let previousFocus: HTMLElement | null = null;
let stopDetailBack: (() => void) | null = null, stopSettingsBack: (() => void) | null = null;
watch(expanded, (open) => { stopDetailBack?.(); stopDetailBack = open ? registerBackHandler(() => { closeDetail(); return true; }) : null; });
function openSettings() { settings.value?.showModal(); stopSettingsBack?.(); stopSettingsBack = registerBackHandler(() => { settings.value?.close(); return true; }); }
async function openDetail() { if (props.managing) return; previousFocus = document.activeElement as HTMLElement; expanded.value = true; await nextTick(); (closeButton.value?.closest('.detail-panel')?.querySelector('textarea') || closeButton.value)?.focus(); }
function closeDetail() { expanded.value = false; previousFocus?.focus(); }
function onDetailKey(event: KeyboardEvent) {
  if (!expanded.value) return;
  if ((event.target as HTMLElement)?.closest('dialog')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetail(); }
  if (event.key !== 'Tab') return;
  const controls = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex="0"]')).filter((el) => el.getClientRects().length && !(el as HTMLButtonElement).disabled && !el.classList.contains('detail-backdrop'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
function onDialogClick(event: MouseEvent) { if (event.target === settings.value) settings.value?.close(); }
let observer: ResizeObserver | null = null;
let hold: ReturnType<typeof setTimeout> | null = null;
let down: { x: number; y: number } | null = null;
let held = false;
function clearHold() { if (hold) clearTimeout(hold); hold = null; down = null; if (held) setTimeout(() => { held = false; }, 0); }
function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('input,textarea,a,select,.home-action button,.card-settings,.resize-handle,.shell-expand')) return;
  if (props.managing) { emit('drag-request', event); return; }
  if (event.pointerType !== 'touch') return;
  down = { x: event.clientX, y: event.clientY };
  hold = setTimeout(() => { hold = null; held = true; emit('drag-request', event); }, 450);
}
function moveHold(event: PointerEvent) { if (hold && down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) clearHold(); }
function suppressClick(event: MouseEvent) { if (held) { event.preventDefault(); event.stopPropagation(); held = false; } }
onMounted(() => { observer = new ResizeObserver(([entry]) => { const box = root.value?.getBoundingClientRect(); size.value = { w: box?.width || entry.contentRect.width, h: box?.height || entry.contentRect.height }; }); if (root.value) observer.observe(root.value); window.addEventListener('pointermove', moveHold); window.addEventListener('pointerup', clearHold); window.addEventListener('pointercancel', clearHold); });
onUnmounted(() => { stopDetailBack?.(); stopSettingsBack?.(); observer?.disconnect(); clearHold(); window.removeEventListener('pointermove', moveHold); window.removeEventListener('pointerup', clearHold); window.removeEventListener('pointercancel', clearHold); });
</script>
<style scoped>
.shell {
  position:relative;
  width:100%;
  height:100%;
  min-width:0;
  min-height:0;
  padding:22px;
  border:1px solid var(--border);
  border-radius:22px;
  background:var(--card-bg);
  box-shadow:0 3px 14px color-mix(in srgb,var(--text) 3%,transparent);
  display:flex;
  flex-direction:column;
  overflow:hidden;
  container-type:size;
  transition:box-shadow .2s,border-color .2s;
}
.shell:hover {
  box-shadow:0 8px 24px color-mix(in srgb,var(--text) 7%,transparent);
}
.shell:focus-visible {
  outline:2px solid var(--accent);
  outline-offset:-3px;
}
.shell-head {
  display:flex;
  gap:8px;
  align-items:center;
  margin-bottom:10px;
  flex:none;
}
.shell-head h3 {
  display:flex;
  align-items:center;
  gap:8px;
  flex:1;
  min-width:0;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  font-size:13px;
  font-weight:600;
  color:var(--text-secondary);
}
.shell-head h3 :deep(svg) {
  color:var(--accent);
  flex:none;
}
.shell-expand {
  width:26px;
  height:26px;
  flex:none;
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius:8px;
  background:var(--bg-secondary);
  border:1px solid var(--border);
  color:var(--text-faint);
}
.shell:hover .shell-expand {
  color:var(--accent);
  background:var(--accent-soft);
  border-color:transparent;
}
.shell-content,.shell-body,.module-content {
  min-width:0;
  min-height:0;
  flex:1;
}
.shell-content {
  display:flex;
  overflow:hidden;
}
.shell-body {
  display:flex;
  flex-direction:column;
  overflow:hidden;
}
.module-content {
  overflow:auto;
  scrollbar-width:thin;
}
.content-hidden {
  display:none;
}
.micro { border-radius:12px; }
.managing {
  border:1px dashed var(--accent);
  touch-action:none;
}
.managing .shell-summary,.managing .module-content {
  pointer-events:none;
}
.dragging {
  opacity:.75;
  box-shadow:0 12px 30px color-mix(in srgb,var(--accent) 22%,transparent);
}
.card-settings {
  position:absolute;
  top:5px;
  right:5px;
  width:28px;
  height:24px;
  border-radius:8px;
  background:var(--card-bg);
  color:var(--accent);
  border:1px solid var(--border);
  font-weight:700;
  z-index:3;
}
.resize-handle {
  position:absolute;
  width:24px;
  height:24px;
  bottom:1px;
  right:1px;
  touch-action:none;
  cursor:nwse-resize;
  z-index:3;
}
.resize-handle::after {
  content:'';
  position:absolute;
  bottom:6px;
  right:6px;
  width:9px;
  height:9px;
  border-right:2px solid var(--accent);
  border-bottom:2px solid var(--accent);
}
.detail-overlay {
  position:fixed;
  inset:0;
  z-index:1200;
  display:grid;
  place-items:center;
  padding:24px;
}
.detail-backdrop {
  position:absolute;
  inset:0;
  background:rgba(0,0,0,.38);
  backdrop-filter:blur(5px);
}
.detail-panel {
  position:relative;
  width:min(680px,100%);
  max-height:85dvh;
  padding:28px;
  border:1px solid var(--border);
  border-radius:24px;
  background:var(--card-bg);
  color:var(--text);
  box-shadow:var(--shadow-card);
}
.detail-panel .module-content {
  overflow:auto;
}
.detail-head {
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:12px;
  margin-bottom:22px;
}
.detail-head h2 {
  font-size:18px;
  color:var(--text);
}
.detail-close {
  width:32px;
  height:32px;
  border-radius:50%;
  background:var(--bg-secondary);
  color:var(--text-secondary);
  font-size:24px;
}
.size-dialog {
  position:fixed;
  inset:0;
  margin:auto;
  width:min(420px,calc(100% - 32px));
  padding:24px;
  border:1px solid var(--border);
  border-radius:22px;
  background:var(--card-bg);
  color:var(--text);
}
.size-dialog::backdrop {
  background:rgba(0,0,0,.38);
  backdrop-filter:blur(4px);
}
.size-hint {
  color:var(--text-secondary);
  font-size:13px;
  margin-bottom:16px;
}
.size-matrix {
  display:grid;
  /* 列数跟着栅格走：12 列栅格就画 12 个小格，点哪个就是几格宽 */
  grid-template-columns:repeat(var(--size-cols, 12),1fr);
  gap:4px;
}
.size-matrix button {
  aspect-ratio:1;
  background:var(--bg-tertiary);
  border:1px solid var(--border);
  border-radius:5px;
}
.size-unit {
  margin-left:8px;
  color:var(--text-faint);
  font-size:12px;
}
.size-matrix button.selected {
  background:var(--accent-soft);
  border-color:var(--accent);
}
.size-matrix button:hover,.size-matrix button:focus-visible {
  background:var(--accent);
}
.size-fields {
  display:flex;
  flex-wrap:wrap;
  gap:14px;
  margin:22px 0;
}
.size-fields label {
  font-size:12px;
  color:var(--text-secondary);
  display:flex;
  align-items:center;
  gap:6px;
}
.size-fields input {
  width:55px;
  padding:7px;
  border:1px solid var(--border);
  background:var(--bg);
  color:var(--text);
  border-radius:6px;
}
.settings-actions {
  display:flex;
  gap:12px;
  font-size:12px;
  align-items:center;
}
.settings-actions .danger {
  color:var(--danger);
}
.settings-actions .done {
  margin-left:auto;
  background:var(--accent);
  color:#fff;
  padding:8px 16px;
  border-radius:8px;
}
.module-content :deep(.hb-card) {
  background:transparent;
  border:0;
  box-shadow:none;
}
.module-content :deep(.hb-row) {
  padding-left:0;
  padding-right:0;
}
.module-content :deep(.notes-bulb) {
  background:var(--accent-soft);
  color:var(--accent);
}
.module-content :deep(.activity-dot) {
  background:var(--accent)!important;
}
.module-content :deep(.hb-badge) {
  background:var(--accent-soft);
  color:var(--accent);
}
.capture .module-content { display:flex;overflow:hidden; }
.capture .module-content :deep(.home-action) { width:100%; }
.capture-styles { border:0;padding:0;margin:0 0 22px;display:grid;gap:10px;font-size:13px; }
.capture-styles legend { margin-bottom:10px;color:var(--text-secondary); }
.capture-styles label { display:flex;align-items:center;gap:8px; }
.capture-styles p { color:var(--text-faint);font-size:11px; }
@container (max-width:260px) {
  .shell-head {
    margin-bottom:10px;
  }
  .shell-head h3 {
    font-size:11px;
    gap:5px;
  }
}
/* 小格（1×1/横条）里「⋯」和缩放手柄按比例收小，别把一格占掉一半 */
@container (max-width:170px) {
  .card-settings {
    width:24px;
    height:20px;
    top:3px;
    right:3px;
    border-radius:6px;
    font-size:12px;
  }
  .resize-handle {
    width:20px;
    height:20px;
  }
  .resize-handle::after {
    bottom:5px;
    right:5px;
    width:8px;
    height:8px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .shell {
    transition:none;
  }
}
</style>
