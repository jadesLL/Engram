<template>
  <div ref="rootEl" class="image-viewer">
    <div class="image-toolbar">
      <button class="icon-btn" v-tooltip="'缩小'" @click="zoomBy(0.85)"><Icon name="zoom-out" :size="16" /></button>
      <span class="zoom-label">{{ Math.round(scale * 100) }}%</span>
      <button class="icon-btn" v-tooltip="'放大'" @click="zoomBy(1.18)"><Icon name="zoom-in" :size="16" /></button>
      <button class="icon-btn" v-tooltip="'向左旋转'" @click="rotateBy(-90)"><Icon name="rotate-left" :size="16" /></button>
      <button class="icon-btn" v-tooltip="'向右旋转'" @click="rotateBy(90)"><Icon name="rotate-right" :size="16" /></button>
      <button class="icon-btn" v-tooltip="'适应窗口'" @click="fitImage"><Icon name="fit-width" :size="16" /></button>
      <button class="icon-btn" v-tooltip="'重置'" @click="resetImage"><Icon name="restore" :size="16" /></button>
      <span class="toolbar-spacer" />
      <button class="icon-btn" v-tooltip="'全屏'" @click="toggleFullscreen"><Icon name="maximize" :size="16" /></button>
    </div>
    <div
      ref="viewportEl"
      class="image-viewport"
      :class="{ dragging }"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img
        ref="imageEl"
        :src="url"
        alt=""
        draggable="false"
        :style="{ transform: imageTransform }"
        @load="fitImage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ url: string }>();

const rootEl = ref<HTMLDivElement>();
const viewportEl = ref<HTMLDivElement>();
const imageEl = ref<HTMLImageElement>();
const scale = ref(1);
const rotation = ref(0);
const offsetX = ref(0);
const offsetY = ref(0);
const dragging = ref(false);
const pointers = new Map<number, { x: number; y: number }>();
let lastPointer = { x: 0, y: 0 };
let pinchDistance = 0;
let pinchScale = 1;
let resizeObserver: ResizeObserver | null = null;

const imageTransform = computed(() =>
  `translate(-50%, -50%) translate(${offsetX.value}px, ${offsetY.value}px) ` +
  `scale(${scale.value}) rotate(${rotation.value}deg)`
);

function clampScale(value: number) {
  return Math.max(0.08, Math.min(8, value));
}

function fitImage() {
  const viewport = viewportEl.value;
  const image = imageEl.value;
  if (!viewport || !image?.naturalWidth || !image.naturalHeight) return;
  const rotated = Math.abs(rotation.value % 180) === 90;
  const imageWidth = rotated ? image.naturalHeight : image.naturalWidth;
  const imageHeight = rotated ? image.naturalWidth : image.naturalHeight;
  scale.value = clampScale(Math.min(
    (viewport.clientWidth - 32) / imageWidth,
    (viewport.clientHeight - 32) / imageHeight,
    1,
  ));
  offsetX.value = 0;
  offsetY.value = 0;
}

function resetImage() {
  rotation.value = 0;
  fitImage();
}

function zoomBy(factor: number, anchor?: { x: number; y: number }) {
  const viewport = viewportEl.value;
  const previous = scale.value;
  const next = clampScale(previous * factor);
  if (anchor && viewport && next !== previous) {
    const rect = viewport.getBoundingClientRect();
    const dx = anchor.x - (rect.left + rect.width / 2) - offsetX.value;
    const dy = anchor.y - (rect.top + rect.height / 2) - offsetY.value;
    const ratio = next / previous;
    offsetX.value -= dx * (ratio - 1);
    offsetY.value -= dy * (ratio - 1);
  }
  scale.value = next;
}

function rotateBy(degrees: number) {
  rotation.value = (rotation.value + degrees + 360) % 360;
  fitImage();
}

function onWheel(event: WheelEvent) {
  zoomBy(event.deltaY < 0 ? 1.12 : 0.89, { x: event.clientX, y: event.clientY });
}

function pointerDistance() {
  const values = [...pointers.values()];
  if (values.length < 2) return 0;
  return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
}

function onPointerDown(event: PointerEvent) {
  viewportEl.value?.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) {
    dragging.value = true;
    lastPointer = { x: event.clientX, y: event.clientY };
  } else if (pointers.size === 2) {
    pinchDistance = pointerDistance();
    pinchScale = scale.value;
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size >= 2) {
    const distance = pointerDistance();
    if (pinchDistance > 0) scale.value = clampScale(pinchScale * distance / pinchDistance);
    return;
  }
  if (!dragging.value) return;
  offsetX.value += event.clientX - lastPointer.x;
  offsetY.value += event.clientY - lastPointer.y;
  lastPointer = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (pointers.size === 0) dragging.value = false;
  if (pointers.size === 1) {
    const remaining = [...pointers.values()][0];
    lastPointer = { ...remaining };
  }
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) await rootEl.value?.requestFullscreen();
  else await document.exitFullscreen();
}

watch(() => props.url, resetImage);
onMounted(() => {
  if (!viewportEl.value) return;
  resizeObserver = new ResizeObserver(() => fitImage());
  resizeObserver.observe(viewportEl.value);
});
onBeforeUnmount(() => {
  pointers.clear();
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.image-viewer { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg-soft); }
.image-toolbar {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.icon-btn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 6px; }
.icon-btn:hover { background: var(--bg-hover); color: var(--accent); }
.zoom-label { min-width: 44px; text-align: center; color: var(--text-secondary); font-size: 11px; }
.toolbar-spacer { flex: 1; }
.image-viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  user-select: none;
}
.image-viewport.dragging { cursor: grabbing; }
.image-viewport img {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: none;
  max-height: none;
  transform-origin: center;
  will-change: transform;
  pointer-events: none;
}
.image-viewer:fullscreen { background: var(--bg-soft); }
</style>
