<template>
  <div
    class="img-resizer"
    :style="{ top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` }"
    role="group"
    aria-label="图片大小"
  >
    <span class="img-resizer__size">{{ Math.round(width) }} px</span>
    <button
      type="button"
      class="img-resizer__reset"
      aria-label="恢复图片原始大小"
      @pointerdown.stop.prevent
      @click.stop="$emit('reset')"
    >
      自适应
    </button>
    <span
      v-for="handle in HANDLES"
      :key="handle"
      class="img-resizer__handle"
      :class="`is-${handle}`"
      role="presentation"
      @pointerdown.stop.prevent="startDrag(handle, $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { onUnmounted } from 'vue';

/**
 * 编辑页图片选中框：右侧上下两个角拖拽只改宽度（高度按原比例跟着走）。
 *
 * 位置由父级按 `.editor-wrap` 坐标算好；这里只负责指针手势与宽度预览。
 * 叠加层默认 pointer-events: none，点击图片仍然落到 Vditor 自己身上（保留它原有的
 * 「点图片编辑 URL」行为），只有角上的手柄与「自适应」按钮接收指针。
 */
const props = defineProps<{
  top: number;
  left: number;
  width: number;
  height: number;
  minWidth: number;
  maxWidth: number;
}>();

const emit = defineEmits<{
  (e: 'preview', width: number): void;
  (e: 'commit', width: number): void;
  (e: 'reset'): void;
  (e: 'cancel'): void;
}>();

const HANDLES = ['ne', 'se'] as const;
type Handle = (typeof HANDLES)[number];

interface DragState {
  handle: Handle;
  pointerId: number;
  startX: number;
  startWidth: number;
  lastWidth: number;
}

let drag: DragState | null = null;
let bodyUserSelect = '';
let bodyCursor = '';

function startDrag(handle: Handle, event: PointerEvent) {
  if (drag || event.button !== 0) return;
  drag = {
    handle,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: props.width,
    lastWidth: props.width,
  };
  bodyUserSelect = document.body.style.userSelect;
  bodyCursor = document.body.style.cursor;
  // 拖手柄时别让浏览器顺手选中正文 / 显示文本光标
  document.body.style.userSelect = 'none';
  document.body.style.cursor = handle === 'se' ? 'nwse-resize' : 'nesw-resize';
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  // 只在右侧留手柄：拖动的是图片右边缘，宽度随水平位移增减，左边缘不动（符合正文左对齐的流式布局）
  const next = Math.round(
    Math.max(props.minWidth, Math.min(props.maxWidth, drag.startWidth + event.clientX - drag.startX)),
  );
  if (next === drag.lastWidth) return;
  drag.lastWidth = next;
  emit('preview', next);
}

function onPointerUp(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  finish(true);
}

function onPointerCancel() {
  if (!drag) return;
  finish(false);
}

function finish(commit: boolean) {
  if (!drag) return;
  const completed = drag;
  drag = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  document.body.style.userSelect = bodyUserSelect;
  document.body.style.cursor = bodyCursor;
  if (commit) {
    emit('commit', completed.lastWidth);
    return;
  }
  // 手势被系统打断：把拖到一半的宽度退回起点
  emit('preview', completed.startWidth);
  emit('cancel');
}

onUnmounted(() => {
  if (!drag) return;
  drag = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  document.body.style.userSelect = bodyUserSelect;
  document.body.style.cursor = bodyCursor;
});
</script>

<style scoped>
.img-resizer {
  position: absolute;
  z-index: var(--z-popup);
  box-sizing: border-box;
  border: 1.5px solid var(--accent);
  border-radius: 6px;
  pointer-events: none;
  animation: img-resizer-in 0.12s ease-out;
}
.img-resizer__size,
.img-resizer__reset {
  position: absolute;
  bottom: 6px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--text);
  color: var(--bg);
  font-size: var(--fs-caption);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.img-resizer__size {
  left: 6px;
  padding: 0 8px;
  pointer-events: none;
}
.img-resizer__reset {
  right: 6px;
  padding: 0 10px;
  border: 0;
  font: inherit;
  font-size: var(--fs-caption);
  font-weight: 650;
  cursor: pointer;
  pointer-events: auto;
}
.img-resizer__reset:focus-visible {
  outline: 2px solid var(--bg);
  outline-offset: -2px;
}
.img-resizer__handle {
  position: absolute;
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border: 2px solid var(--card-bg);
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.24);
  pointer-events: auto;
  touch-action: none;
}
/* 视觉上 14px，实际热区扩到 32px：触屏手指也能稳稳抓住 */
.img-resizer__handle::before {
  content: '';
  position: absolute;
  inset: -9px;
}
.img-resizer__handle.is-ne { top: -8px; right: -8px; cursor: nesw-resize; }
.img-resizer__handle.is-se { bottom: -8px; right: -8px; cursor: nwse-resize; }
@keyframes img-resizer-in {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .img-resizer { animation: none; }
}
</style>
