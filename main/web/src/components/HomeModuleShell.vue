<template>
  <section ref="root" class="shell" :class="{ managing, dragging, compact, short: size.h < 180, capture: kind === 'capture', ribbon: size.w > 310 && height === 1, micro: size.w < 150 || size.h < 90, heatMini: kind === 'heat' && size.w > 65 && size.h > 90 }"
    :tabindex="managing ? 0 : -1" :aria-label="title" @pointerdown="onPointerDown" @click.capture="suppressClick">
    <header v-show="!compact" class="shell-head"><h3><Icon :name="meta.icon" :size="15" />{{ title }}</h3><button type="button" class="shell-expand" :aria-label="`展开${title}`" @click="openDetail">↗</button></header>
    <button v-if="compact" type="button" class="shell-summary" :aria-label="`打开${title}完整内容`" @click="openDetail">
      <Icon :name="meta.icon" :size="18" /><strong class="summary-value">{{ summary.value }}</strong><span class="summary-label">{{ size.w < 150 ? tinyTitle : title }}</span>
      <small class="summary-caption">{{ summary.label }}</small>
      <span v-if="kind === 'heat' && size.w > 65 && size.h > 90" class="mini-heat" :style="{ maxWidth: `${Math.min(250, Math.max(50, (size.h - (size.h < 180 ? 55 : 90)) * (summary.heat?.length || 56) / 49))}px` }" aria-hidden="true"><i v-for="(level,i) in summary.heat" :key="i" :style="{ background: level ? `color-mix(in srgb,var(--accent) ${[0,22,42,66,100][level]}%,var(--card-bg))` : 'var(--bg-tertiary)' }" /></span>
      <ul v-if="size.h > 180 && summary.lines?.length"><li v-for="(line, i) in summary.lines" :key="i">{{ line }}</li></ul>
      <span v-if="size.w > 110 && size.h > 160" class="summary-open">查看完整内容 ↗</span>
    </button>
    <!-- 始终保留同一个模块实例；打开详情、改变尺寸不会丢失速记草稿。 -->
    <Teleport to="body" :disabled="!expanded">
      <div class="shell-content" :class="{ 'detail-overlay': expanded, 'content-hidden': compact && !expanded }" :role="expanded ? 'dialog' : undefined" :aria-modal="expanded ? true : undefined" :aria-label="expanded ? title : undefined" @keydown="onDetailKey">
        <button v-if="expanded" class="detail-backdrop" type="button" aria-label="关闭详情" @click="closeDetail" />
        <div class="shell-body" :class="{ 'detail-panel': expanded }">
          <header v-if="expanded" class="detail-head"><h2>{{ title }}</h2><button ref="closeButton" class="detail-close" type="button" aria-label="关闭详情" @click="closeDetail">×</button></header>
          <div class="module-content"><slot /></div>
        </div>
      </div>
    </Teleport>
    <button v-if="managing" class="card-settings" type="button" :aria-label="`设置${title}尺寸`" @click="openSettings">⋯</button>
    <button v-if="managing" class="resize-handle" type="button" aria-label="拖动调整宽高" @pointerdown.stop.prevent="$emit('resize-request', $event)" />
    <Teleport to="body"><dialog ref="settings" class="size-dialog" @click="onDialogClick" @close="stopSettingsBack?.()">
      <header class="detail-head"><h2>调整「{{ title }}」</h2><button type="button" class="detail-close" aria-label="关闭尺寸设置" @click="settings?.close()">×</button></header>
      <p class="size-hint">{{ hoverSize || `${width} × ${height}` }} · 宽 × 高（格）</p>
      <div class="size-matrix" @mouseleave="hoverSize = ''"><template v-for="h in 5" :key="h"><button v-for="w in 6" :key="w" type="button" :class="{ selected: w <= width && h <= height }" :aria-label="`${w} × ${h}`" @mouseenter="hoverSize = `${w} × ${h}`" @focus="hoverSize = `${w} × ${h}`" @click="$emit('set-size', w, h)" /></template></div>
      <div class="size-fields"><label>宽度 <input type="number" min="1" max="6" :value="width" @change="$emit('set-size', Number(($event.target as HTMLInputElement).value), height)" /></label><label>高度 <input type="number" min="1" max="12" :value="height" @change="$emit('set-size', width, Number(($event.target as HTMLInputElement).value))" /></label><label v-if="limit !== undefined">{{ kind === 'heat' ? '周数' : '条数' }} <input type="number" :min="kind === 'heat' ? 4 : 1" :max="kind === 'tasks' ? 20 : 12" :value="limit" @change="$emit('set-opt', 'limit', Number(($event.target as HTMLInputElement).value))" /></label></div>
      <footer class="settings-actions"><button type="button" @click="$emit('rename')">修改标题</button><button type="button" class="danger" @click="settings?.close(); $emit('remove')">移除卡片</button><button type="button" class="done" @click="settings?.close()">完成</button></footer>
    </dialog></Teleport>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { registerBackHandler } from '../lib/androidBack';
import { moduleMeta, type ModuleKind } from '../lib/homeBoard.ts';
const props = defineProps<{ kind: ModuleKind; title: string; width: number; height: number; limit?: number; managing: boolean; dragging: boolean; target?: boolean; summary: { value: string | number; label?: string; lines?: string[]; heat?: number[] } }>();
const emit = defineEmits<{ (e: 'remove' | 'rename'): void; (e: 'set-size', w: number, h: number): void; (e: 'set-opt', key: string, value: number): void; (e: 'drag-request' | 'resize-request', event: PointerEvent): void }>();
const root = ref<HTMLElement | null>(null), settings = ref<HTMLDialogElement | null>(null), closeButton = ref<HTMLButtonElement | null>(null);
const size = ref({ w: 300, h: 300 });
const meta = computed(() => moduleMeta(props.kind));
const shortTitles: Record<ModuleKind, string> = { capture: '速记', shortcuts: '入口', recent: '更新', notes: '灵感', fresh: '新增', tasks: '待办', stats: '概览', weekly: '动态', tags: '标签', sections: '分区', roam: '漫游', system: '状态', sync: '同步', ring: '占比', heat: '热力', inbox: '收集', queue: '提炼', board: '看板', activity: '改动', digest: '摘要' };
const tinyTitle = computed(() => props.title === meta.value.title ? shortTitles[props.kind] : props.title);
const compact = computed(() => size.value.w < 230 || size.value.h < 170);
const expanded = ref(false), hoverSize = ref('');
let previousFocus: HTMLElement | null = null;
let stopDetailBack: (() => void) | null = null, stopSettingsBack: (() => void) | null = null;
watch(expanded, (open) => { stopDetailBack?.(); stopDetailBack = open ? registerBackHandler(() => { closeDetail(); return true; }) : null; });
function openSettings() { settings.value?.showModal(); stopSettingsBack?.(); stopSettingsBack = registerBackHandler(() => { settings.value?.close(); return true; }); }
async function openDetail() { if (props.managing) return; previousFocus = document.activeElement as HTMLElement; expanded.value = true; await nextTick(); closeButton.value?.focus(); }
function closeDetail() { expanded.value = false; previousFocus?.focus(); }
function onDetailKey(event: KeyboardEvent) {
  if (!expanded.value) return;
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
  if (event.button !== 0 || (event.target as HTMLElement).closest('input,textarea,a,select,.card-settings,.resize-handle,.shell-expand')) return;
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
  margin-bottom:18px;
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
  font-size:20px;
  color:var(--text-faint);
  width:26px;
  height:26px;
  flex:none;
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
.shell-summary {
  display:flex;
  flex:1;
  min-height:0;
  min-width:0;
  flex-direction:column;
  align-items:flex-start;
  text-align:left;
  justify-content:center;
  gap:8px;
  color:var(--text);
  width:100%;
}
.shell-summary :deep(svg) {
  color:var(--accent);
}
.summary-value {
  font-size:clamp(24px,24cqw,40px);
  font-weight:700;
  letter-spacing:-.05em;
  line-height:1.1;
  max-width:100%;
  overflow:hidden;
  text-overflow:ellipsis;
}
.summary-label {
  font-size:12px;
  line-height:1.2;
  max-width:100%;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
}
.summary-caption,.summary-open {
  font-size:10px;
  line-height:1.2;
  color:var(--text-faint);
  overflow:hidden;
  max-width:100%;
  white-space:nowrap;
  text-overflow:ellipsis;
}
.shell-summary ul {
  list-style:none;
  padding:0;
  margin:4px 0;
  width:100%;
  overflow:hidden;
}
.shell-summary li {
  font-size:12px;
  padding:8px 0;
  border-top:1px solid var(--border);
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.compact {
  padding:16px;
}
.short {
  padding:12px;
}
.short .shell-summary {
  gap:4px;
}
.short .shell-summary :deep(svg) {
  display:none;
}
.summary-value,.summary-label,.summary-caption,.summary-open {
  flex-shrink:0;
}
.micro {
  padding:7px;
  border-radius:12px;
}
.micro .shell-summary {
  gap:2px;
  align-items:center;
  text-align:center;
}
.micro .shell-summary :deep(svg),.micro .summary-caption {
  display:none;
}
.micro .summary-value {
  font-size:clamp(14px,20cqh,18px);
}
.micro .summary-label {
  font-size:9px;
  line-height:1.1;
}
.capture {
  background:var(--accent);
  border-color:transparent;
  --text:#fff;
  --text-secondary:rgba(255,255,255,.85);
  --text-faint:rgba(255,255,255,.7);
  --border:rgba(255,255,255,.22);
  color:#fff;
}
.capture .shell-head h3,.capture .shell-head h3 :deep(svg),.capture .shell-summary :deep(svg) {
  color:#fff;
}
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
  grid-template-columns:repeat(6,1fr);
  gap:6px;
}
.size-matrix button {
  aspect-ratio:1;
  background:var(--bg-tertiary);
  border:1px solid var(--border);
  border-radius:7px;
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
.ribbon .shell-summary {
  display:grid;
  grid-template-columns:auto auto 1fr;
  align-content:center;
  align-items:center;
  column-gap:16px;
}
.ribbon .summary-value {
  font-size:28px;
  grid-row:1/3;
}
.ribbon .summary-label {
  grid-column:3;
}
.ribbon .summary-caption {
  grid-column:3;
}
.ribbon .summary-open {
  display:none;
}
.mini-heat {
  display:grid;
  grid-template-rows:repeat(7,1fr);
  grid-auto-flow:column;
  grid-auto-columns:1fr;
  gap:3px;
  width:100%;
  max-height:100px;
}
.mini-heat i {
  aspect-ratio:1;
  border-radius:2px;
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
.heatMini .shell-summary {
  gap:8px;
}
.heatMini .shell-summary :deep(svg),.heatMini .summary-value,.heatMini .summary-caption,.heatMini .summary-open {
  display:none;
}
.heatMini .mini-heat {
  gap:2px;
  max-width:250px;
  max-height:none;
}
.capture .module-content :deep(.btn.primary) {
  background:#fff;
  color:var(--accent);
}
@container (max-width:260px) {
  .shell-head {
    margin-bottom:10px;
  }
  .shell-head h3 {
    font-size:11px;
    gap:5px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .shell {
    transition:none;
  }
}
</style>
