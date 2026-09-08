<template>
  <Teleport to="body">
    <Transition name="tooltip-fade">
      <div
        v-if="tooltipState.visible"
        class="app-tooltip"
        :class="`placement-${tooltipState.placement}`"
        :style="tooltipStyle"
        role="tooltip"
      >
        {{ tooltipState.text }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { tooltipState } from '../../lib/tooltip';

const GAP = 6;
const VIEWPORT_PADDING = 8;

const tooltipStyle = computed(() => {
  const { x, y, width, height, placement } = tooltipState;
  const style: Record<string, string> = {};

  if (placement === 'top') {
    style.left = `${x + width / 2}px`;
    style.top = `${y - GAP}px`;
    style.transform = 'translate(-50%, -100%)';
  } else if (placement === 'bottom') {
    style.left = `${x + width / 2}px`;
    style.top = `${y + height + GAP}px`;
    style.transform = 'translate(-50%, 0)';
  } else if (placement === 'left') {
    style.left = `${x - GAP}px`;
    style.top = `${y + height / 2}px`;
    style.transform = 'translate(-100%, -50%)';
  } else {
    style.left = `${x + width + GAP}px`;
    style.top = `${y + height / 2}px`;
    style.transform = 'translate(0, -50%)';
  }

  // 视口边界约束（不精确但足够避免遮挡）
  style.maxWidth = `calc(100vw - ${VIEWPORT_PADDING * 2}px)`;
  return style;
});
</script>

<style scoped>
.app-tooltip {
  position: fixed;
  z-index: var(--z-menu);
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--card-bg);
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  max-width: 320px;
}

.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity 120ms ease;
}
.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
}
</style>
