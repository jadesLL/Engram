<template>
  <section ref="root" class="shell" :class="[`tone-${meta.tone}`, `tier-${tier}`, { managing, dragging, compact, short: size.h < 180, capture: functional, micro: size.w < 100 || size.h < 90, 'ai-card': kind === 'digest', 'auto-height': autoHeight }]"
    :tabindex="managing ? 0 : -1" :aria-label="title" @pointerdown="onPointerDown" @click.capture="suppressClick">
    <!-- 标题栏只有标准档（w≥2 且 h≥2）才画：磁贴 / 横条 / 竖条把空间全部留给内容 -->
    <header v-if="tier === 'standard' && !functional" class="shell-head"><div class="shell-titles"><span class="shell-eyebrow">{{ eyebrow }}</span><h3><Icon :name="meta.icon" :size="15" /><span class="shell-title-text">{{ title }}</span></h3></div><span v-if="summary.header" class="shell-meta">{{ summary.header }}</span><button type="button" class="shell-expand" :aria-label="`展开${title}`" @click="openDetail"><Icon name="arrow-up-right" :size="13" /></button></header>
    <HomeAdaptiveSummary v-if="compact" :summary="summary" :title="title" :short-title="tinyTitle" :tier="tier" :icon="meta.icon" @open="openDetail" @activate="$emit('activate', $event)" />
    <!-- 始终保留同一个模块实例；打开详情、改变尺寸不会丢失速记草稿。 -->
    <Teleport to="body" :disabled="!expanded">
      <div class="shell-content" :class="{ 'detail-overlay': expanded, 'content-hidden': compact && !expanded }" :role="expanded ? 'dialog' : undefined" :aria-modal="expanded ? true : undefined" :aria-label="expanded ? title : undefined" @keydown="onDetailKey">
        <button v-if="expanded" class="detail-backdrop" type="button" aria-label="关闭详情" @click="closeDetail" />
        <div class="shell-body" :class="{ 'detail-panel': expanded }">
          <header v-if="expanded" class="detail-head"><h2>{{ title }}</h2><button ref="closeButton" class="detail-close" type="button" aria-label="关闭详情" @click="closeDetail">×</button></header>
          <div ref="contentEl" class="module-content"><slot :expanded="expanded" :open="openDetail" :close="closeDetail" :body-height="bodySize.h" /></div>
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
const props = defineProps<{ kind: ModuleKind; title: string; width: number; height: number; limit?: number; captureStyle?: number; managing: boolean; dragging: boolean; target?: boolean; summary: HomeCardSummary; autoHeight?: boolean }>();
const emit = defineEmits<{ (e: 'remove' | 'rename'): void; (e: 'set-size', w: number, h: number): void; (e: 'set-opt', key: string, value: number): void; (e: 'drag-request' | 'resize-request', event: PointerEvent): void; (e: 'activate', row: HomeCardRow): void }>();
const root = ref<HTMLElement | null>(null), settings = ref<HTMLDialogElement | null>(null), closeButton = ref<HTMLButtonElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
/** 卡面正文的实际高度（像素）：列表模块据此决定显示几行，避免卡片内出现内部滚动条 */
const bodySize = ref({ w: 0, h: 0 });
const size = ref({ w: 300, h: 300 });
/** 尺寸菜单里的格子边长：卡片宽度减去格间 14px 留白后均分，让「1 格多大」看得见 */
const cellPx = computed(() => {
  const columns = Math.max(1, props.width);
  return Math.max(24, Math.round((size.value.w + 14) / columns - 14));
});
/** 尺寸矩阵画几行高度：常用高度只到 6 行，再高就用下面的数字框 */
const sizeMatrixRows = 6;
const meta = computed(() => moduleMeta(props.kind));
/** 卡头的小写眉毛标签（首页 Claude 风格）：模块识别靠它，不再靠彩色图标块 */
const EYEBROWS: Record<ModuleKind, string> = {
  ask: 'Ask', capture: 'Capture', shortcuts: 'Shortcuts', recent: 'Recent', notes: 'Ideas', fresh: 'Fresh',
  tasks: 'Tasks', stats: 'Library', weekly: 'Weekly', tags: 'Tags', sections: 'Sections', roam: 'Roam',
  system: 'Status', sync: 'Sync', ring: 'Ratio', heat: 'Heat', inbox: 'Inbox', queue: 'Queue', board: 'Board',
  activity: 'Recent', digest: 'Summary',
};
const eyebrow = computed(() => EYEBROWS[props.kind] || '');
/** 内容档位由栅格格数决定（用户在尺寸菜单看到的 w × h），与像素无关 */
const tier = computed(() => cardTier(props.width, props.height));
const shortTitles: Record<ModuleKind, string> = { ask: '问答', capture: '灵感', shortcuts: '入口', recent: '更新', notes: '灵感', fresh: '新增', tasks: '待办', stats: '概览', weekly: '动态', tags: '标签', sections: '分区', roam: '漫游', system: '状态', sync: '同步', ring: '占比', heat: '热力', inbox: '收集', queue: '提炼', board: '看板', activity: '改动', digest: '摘要' };
const tinyTitle = computed(() => props.title === meta.value.title ? shortTitles[props.kind] : props.title);
/** 动作卡自己按尺寸切换功能；其他卡沿用摘要与详情分档。 */
const functional = computed(() => props.kind === 'ask' || props.kind === 'capture');
const compact = computed(() => {
  if (functional.value) return false;
  /* 横条快捷入口本身就是一排名片，必须渲染正文；其余横条/磁贴/竖条用摘要。 */
  if (props.kind === 'shortcuts' && tier.value === 'bar') return false;
  /* 磁贴 / 横条 / 竖条放不下模块正文，继续用摘要；标准卡一律渲染真实内容。 */
  if (tier.value === 'tile' || tier.value === 'bar' || tier.value === 'column') return true;
  /* 极小的标准卡（用户把卡拖得很小）也退回摘要，避免正文挤成一团 */
  return size.value.w < 150 || size.value.h < 130;
});
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
let contentObserver: ResizeObserver | null = null;
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
// 读布局尺寸而非变换后的屏幕尺寸，整体缩放不应触发卡片内容和内边距重新分档。
onMounted(() => { observer = new ResizeObserver(([entry]) => { const box = entry.borderBoxSize[0]; size.value = { w: box?.inlineSize ?? root.value?.offsetWidth ?? entry.contentRect.width, h: box?.blockSize ?? root.value?.offsetHeight ?? entry.contentRect.height }; }); if (root.value) observer.observe(root.value); contentObserver = new ResizeObserver(([entry]) => { bodySize.value = { w: entry.contentRect.width, h: entry.contentRect.height }; }); if (contentEl.value) contentObserver.observe(contentEl.value); window.addEventListener('pointermove', moveHold); window.addEventListener('pointerup', clearHold); window.addEventListener('pointercancel', clearHold); });
onUnmounted(() => { stopDetailBack?.(); stopSettingsBack?.(); observer?.disconnect(); contentObserver?.disconnect(); clearHold(); window.removeEventListener('pointermove', moveHold); window.removeEventListener('pointerup', clearHold); window.removeEventListener('pointercancel', clearHold); });
</script>
<style scoped>
.shell {
  position:relative;
  width:100%;
  height:100%;
  min-width:0;
  min-height:0;
  padding:var(--card-pad,17px);
  /* 卡片 v2：暖白纸卡 + 1px 发丝线 + 极轻接触阴影，不再用玻璃填充 */
  border:1px solid var(--card-line);
  border-radius:var(--card-radius,16px);
  background:var(--card-bg);
  box-shadow:var(--card-shadow);
  display:flex;
  flex-direction:column;
  overflow:hidden;
  container-type:size;
  transition:box-shadow .18s ease,border-color .18s ease,transform .18s ease;
}
.shell:not(.managing):not(.dragging):hover {
  box-shadow:var(--card-shadow-hover);
  transform:translateY(-1px);
}
.shell.tier-bar { padding:12px; }
.shell.tier-tile { padding:7px; }
.shell.micro { padding:6px; border-radius:12px; }
/*
 * 手机单列：外壳高度由内容决定。
 * 关键：container-type:size 自带 size containment，会把“没有固定高度”的外壳算成 0 高；
 * 自动高度时必须退回 inline-size（只保留宽度容器查询），否则正文会被压扁再裁掉。
 * 详情浮层在 Teleport 里、已不在 .shell 内，不受这条规则影响。
 */
.shell.auto-height {
  height:auto;
  container-type:inline-size;
}
.shell.auto-height .shell-content { flex:none; overflow:visible; }
/* .shell-content 是 row flex：正文列必须 flex:1 才吃满卡宽；只把高度交给内容，不要连宽度一起缩 */
.shell.auto-height .shell-body { flex:1 1 auto; min-width:0; overflow:visible; }
.shell.auto-height .module-content { flex:none; overflow:visible; }
.shell.auto-height :deep(.adaptive-summary) { flex:none; height:auto; }
/* 热力卡在手机 auto-height 下不能让日历 flex:1（basis:0 会把网格压成 0）；高度交给格子算 */
.shell.auto-height :deep(.heat-card) { height:auto; }
.shell.auto-height :deep(.heat-calendar),
.shell.auto-height :deep(.heat-strip),
.shell.auto-height :deep(.heat-days) { flex:none; }
@media (max-width:768px) {
  .shell { padding:14px; }
  .shell.tier-bar { padding:11px; }
  .shell.tier-tile { padding:7px; }
}
.shell:focus-visible {
  outline:2px solid var(--accent);
  outline-offset:-3px;
}
/* 材质统一：数据 / 列表 / 操作 / 状态都回到同一张暖白卡，层级交给内容与字号 */
.shell.tone-data,
.shell.tone-list,
.shell.tone-action,
.shell.tone-status { background:var(--card-bg); border-color:var(--card-line); box-shadow:var(--card-shadow); }
/* Agent 摘要：整张卡用陶土色轻铺一层，只在 AI 卡上出现 */
.shell.ai-card { background:linear-gradient(145deg, var(--ai-soft) 0%, var(--card-bg) 64%); border-color:var(--ai-line); }
.shell.ai-card:not(.managing):not(.dragging):hover { border-color:var(--ai-line-strong); }
.shell.ai-card .shell-head h3::after {
  content:'AI';
  flex:none;
  margin-left:2px;
  padding:1px 5px;
  border-radius:4px;
  background:var(--ai-soft);
  color:var(--ai);
  font-size:9px;
  line-height:1.5;
  font-weight:700;
  letter-spacing:.04em;
}
.shell-head {
  display:flex;
  gap:7px;
  align-items:center;
  margin-bottom:13px;
  flex:none;
}
.shell-titles {
  display:flex;
  flex-direction:column;
  gap:2px;
  flex:1;
  min-width:0;
}
.shell-eyebrow {
  font-size:9px;
  font-weight:650;
  letter-spacing:.2em;
  line-height:1.4;
  text-transform:uppercase;
  color:var(--text-faint);
}
.shell-head h3 {
  display:flex;
  align-items:center;
  gap:7px;
  flex:1;
  min-width:0;
  /* h3 的浏览器默认上下外边距（1em）会把「眉标 + 标题」撑高到卡头之外：Claude 主题
     的卡头固定 34px，flex 居中后多出的部分顶出卡顶，被 .shell 的 overflow:hidden
     裁成一条字符残影（2026-11-22 用户报「顶上好像有文字」）。 */
  margin:0;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  font-size:12.5px;
  font-weight:650;
  letter-spacing:0.005em;
  color:var(--text);
}
/* 标题文本必须单独成项：ellipsis 写在 flex 容器上对匿名文本项不生效 */
.shell-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 卡头只留 15px 线性图标，不再画彩色图标块 */
.shell-head h3 :deep(svg) {
  color:var(--text-faint);
  flex:none;
}
/* 卡头右侧一句上下文（条数 / 近 7 天 / 按到期日）：有就显示，没有不留空 */
.shell-meta {
  flex:none;
  font-size:10.5px;
  line-height:1.2;
  color:var(--text-faint);
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
}
.shell-expand {
  width:22px;
  height:22px;
  flex:none;
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius:6px;
  background:transparent;
  border:0;
  color:var(--text-faint);
  /* 一卡一个出口：头部 ↗ 在 hover / 键盘聚焦时才现身；触屏没有 hover，常显 */
  opacity:0;
  transition:opacity .15s ease, color .15s ease, background .15s ease;
}
.shell:hover .shell-expand,
.shell:focus-within .shell-expand,
.shell:focus-visible .shell-expand { opacity:1; }
@media (hover:none), (pointer:coarse) { .shell-expand { opacity:1; } }
.shell:hover .shell-expand {
  color:var(--accent);
  background:var(--accent-soft);
  border-color:transparent;
}
/* 编辑态右上角是手机的三枚工具（上移/下移/隐藏），详情箭头让位 */
.shell.managing .shell-expand { display:none; }
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
  display:flex;
  flex-direction:column;
  /* 卡面不出现内部滚动条：模块按拿到的宽高自行收敛内容，溢出的由模块自己省略 */
  overflow:hidden;
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
  /* 全屏遮罩是一个 <button>，会吃到 main.css 里 button{border-radius:999px}：
     圆角被浏览器夹到半屏高，遮罩变成一颗巨型胶囊（四角露出原页面）。
     全屏场景必须显式归零，不能靠按钮默认样式。 */
  border-radius:0;
  background:rgba(0,0,0,.38);
  backdrop-filter:blur(5px);
  animation:detail-fade .18s ease;
}
.detail-panel {
  position:relative;
  width:min(680px,100%);
  max-height:85dvh;
  padding:28px;
  border:1px solid var(--card-line);
  border-radius:18px;
  background:var(--card-bg);
  color:var(--text);
  box-shadow:var(--shadow-dialog);
  animation:detail-pop .22s cubic-bezier(.2,.9,.3,1.06);
}
@keyframes detail-fade { from { opacity:0; } }
/* 详情面板从下方 10px 弹入并轻微放大，遮罩同时淡入：点卡不再「瞬间糊上来」 */
@keyframes detail-pop {
  from { opacity:0; transform:translateY(10px) scale(.97); }
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
  border:1px solid var(--card-line);
  border-radius:16px;
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
  background:var(--action-solid);
  color:var(--on-action-solid);
  padding:8px 16px;
  border-radius:8px;
}
.module-content :deep(.hb-card) {
  background:transparent;
  border:0;
  box-shadow:none;
  padding:0;
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
  .detail-panel,.detail-backdrop {
    animation:none;
  }
}
</style>