<template>
  <Teleport to="body">
    <!-- 聚光：压暗除被说明对象以外的内容（默认关，需要时用 spotlight 选项开启） -->
    <div
      v-if="tooltipState.visible && tooltipState.spotlight"
      class="app-tooltip-spot"
      :style="anchorBoxStyle"
      aria-hidden="true"
    />
    <!-- 提示只在被说明对象四周避让，不做外移，因此不再有虚线引导线 -->

    <div
      v-if="tooltipState.visible"
      ref="bubbleRef"
      class="app-tooltip"
      :class="{ 'is-placed': placed }"
      :style="bubbleStyle"
      role="tooltip"
    >
      <div v-if="tooltipState.title" class="tt-title">{{ tooltipState.title }}</div>
      <div v-if="tooltipState.body" class="tt-body" :class="{ 'tt-strong': !tooltipState.title }">{{ tooltipState.body }}</div>
      <div v-if="tooltipState.kbd || tooltipState.meta" class="tt-foot">
        <kbd v-if="tooltipState.kbd">{{ tooltipState.kbd }}</kbd>
        <span v-if="tooltipState.meta" class="tt-meta">{{ tooltipState.meta }}</span>
      </div>
      <i
        v-if="tooltipState.arrow"
        class="tt-arrow"
        :data-side="tooltipState.arrow.side"
        :style="arrowStyle"
      />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 全局提示气泡（自建，替代系统原生 title）。
 *
 * 落位算法在 lib/tooltip.ts；这里负责：
 *  1. 渲染后测量气泡真实尺寸，按 320 / 224 两种宽度各算一次落位，取「零遮挡优先、其次更宽」的那一次；
 *  2. 悬停期间用 rAF 跟踪锚点位移与鼠标位置（侧栏拖宽、列表滚动、图谱跟随都能跟上）；
 *  3. 渲染箭头、聚光与三段式内容（标题 / 正文 / 快捷键 + 补充说明）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import {
  commitPlan,
  consumePointerDirty,
  hideTooltip,
  planTooltip,
  refreshTooltip,
  tooltipAnchor,
  tooltipState,
  type TooltipPlan,
} from '../../lib/tooltip';

const bubbleRef = ref<HTMLElement | null>(null);
/** 测量完成前先隐藏，避免气泡在旧位置闪一帧 */
const placed = ref(false);

const BUBBLE_MAX_WIDTH = 320;
const BUBBLE_NARROW_WIDTH = 224;

function viewportMaxWidth(width: number): number {
  return Math.max(160, Math.min(width, window.innerWidth - 16));
}

/** 同一提示的两次宽度尝试之间比较：不越界 > 零遮挡 > 更宽 */
function planScore(plan: TooltipPlan, maxWidth: number): number {
  return (plan.overflow > 0 ? 5e5 + plan.overflow : 0)
    + (plan.occluded > 0 ? 1e4 + plan.occluded : 0)
    - maxWidth * 0.5;
}

function place(): void {
  const el = bubbleRef.value;
  if (!el) return;
  const widths = tooltipState.strategy === 'avoid' && tooltipState.strict
    ? [BUBBLE_MAX_WIDTH, BUBBLE_NARROW_WIDTH]
    : [BUBBLE_MAX_WIDTH];
  let best: { plan: TooltipPlan; size: { width: number; height: number }; maxWidth: number; score: number } | null = null;
  for (const width of widths) {
    el.style.maxWidth = `${viewportMaxWidth(width)}px`;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const plan = planTooltip(size);
    const score = planScore(plan, width);
    if (!best || score < best.score) best = { plan, size, maxWidth: width, score };
  }
  if (!best) return;
  el.style.maxWidth = `${viewportMaxWidth(best.maxWidth)}px`;
  commitPlan(best.plan, best.size);
  placed.value = true;
}

const bubbleStyle = computed<CSSProperties>(() => ({
  left: `${tooltipState.left}px`,
  top: `${tooltipState.top}px`,
  visibility: placed.value ? 'visible' : 'hidden',
}));

const arrowStyle = computed<CSSProperties>(() => {
  const arrow = tooltipState.arrow;
  if (!arrow) return {};
  if (arrow.side === 'bottom') return { left: `${arrow.x - 5.5}px`, top: `${tooltipState.height - 6}px` };
  if (arrow.side === 'top') return { left: `${arrow.x - 5.5}px`, top: '-3px' };
  if (arrow.side === 'right') return { left: `${tooltipState.width - 6}px`, top: `${arrow.y - 5.5}px` };
  return { left: '-3px', top: `${arrow.y - 5.5}px` };
});

const anchorBoxStyle = computed<CSSProperties>(() => ({
  left: `${tooltipState.anchor.left - 2}px`,
  top: `${tooltipState.anchor.top - 2}px`,
  width: `${tooltipState.anchor.width + 4}px`,
  height: `${tooltipState.anchor.height + 4}px`,
}));

/* ── 内容变化 → 重新测量落位 ─────────────────────────────── */
watch(
  () => [
    tooltipState.visible,
    tooltipState.title,
    tooltipState.body,
    tooltipState.kbd,
    tooltipState.meta,
    tooltipState.strategy,
    tooltipState.strict,
  ],
  async () => {
    if (!tooltipState.visible) {
      placed.value = false;
      return;
    }
    placed.value = false;
    await nextTick();
    place();
  },
);

/* ── 悬停期间跟踪锚点位移与鼠标（rAF 节流，位移变化才重排）── */
let rafId = 0;
let lastAnchorKey = '';

function anchorKey(): string {
  const a = tooltipState.anchor;
  return `${a.left.toFixed(1)},${a.top.toFixed(1)},${a.width.toFixed(1)},${a.height.toFixed(1)}`;
}

function tick(): void {
  rafId = 0;
  if (!tooltipState.visible) return;
  const anchor = tooltipAnchor();
  if (anchor && !anchor.isConnected) {
    hideTooltip();
    return;
  }
  refreshTooltip();
  const key = anchorKey();
  if (!placed.value || key !== lastAnchorKey || consumePointerDirty()) {
    lastAnchorKey = key;
    place();
  }
  rafId = requestAnimationFrame(tick);
}

function startLoop(): void {
  if (!rafId && tooltipState.visible) {
    lastAnchorKey = anchorKey();
    rafId = requestAnimationFrame(tick);
  }
}

watch(() => tooltipState.visible, (visible) => {
  if (visible) startLoop();
});

function onViewportChange(): void {
  if (tooltipState.visible) {
    refreshTooltip();
    place();
  }
}

onMounted(() => {
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
});
</script>

<style scoped>
.app-tooltip {
  position: fixed;
  z-index: var(--z-menu);
  padding: 6px 10px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--card-bg);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
  max-width: 320px;
  opacity: 0;
  transition: opacity 110ms ease;
}
.app-tooltip.is-placed {
  opacity: 1;
}
html.dark .app-tooltip {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.app-tooltip .tt-title {
  font-weight: 650;
  margin-bottom: 1px;
}
.app-tooltip .tt-body {
  color: var(--text-secondary);
}
.app-tooltip .tt-body.tt-strong {
  color: var(--text);
}
.app-tooltip .tt-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
}
.app-tooltip kbd {
  font: inherit;
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.app-tooltip .tt-meta {
  color: var(--text-faint);
  font-size: 11px;
}
.app-tooltip .tt-arrow {
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--card-bg);
  border: 1px solid var(--border-strong);
  transform: rotate(45deg);
}
.app-tooltip .tt-arrow[data-side='bottom'] {
  border-top: none;
  border-left: none;
}
.app-tooltip .tt-arrow[data-side='top'] {
  border-bottom: none;
  border-right: none;
}
.app-tooltip .tt-arrow[data-side='right'] {
  border-bottom: none;
  border-left: none;
}
.app-tooltip .tt-arrow[data-side='left'] {
  border-top: none;
  border-right: none;
}

.app-tooltip-spot {
  position: fixed;
  z-index: calc(var(--z-menu) - 1);
  border-radius: 8px;
  box-shadow: 0 0 0 9999px rgba(12, 12, 12, 0.17), 0 0 0 1px var(--accent);
  pointer-events: none;
}
html.dark .app-tooltip-spot {
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--accent);
}
</style>
