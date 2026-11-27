<template>
  <button
    ref="triggerEl"
    type="button"
    class="help-tip-btn"
    :class="{ 'is-open': open }"
    v-tooltip="hoverTip"
    :aria-label="resolvedLabel"
    :aria-expanded="open ? 'true' : 'false'"
    @click.stop="toggle"
  >
    <Icon name="help" :size="14" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popoverEl"
      class="help-tip-popover"
      :class="{ 'is-placed': placed }"
      :style="popoverStyle"
      role="dialog"
      :aria-label="resolvedLabel"
      @click.stop
    >
      <div v-if="title" class="help-tip-title">{{ title }}</div>
      <div class="help-tip-body">
        <slot>{{ text }}</slot>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useSlots, watch, type CSSProperties } from 'vue';
import Icon from '../Icon.vue';
import { registerBackHandler } from '../../lib/androidBack';

/**
 * 轻量 `?` 帮助气泡：把次要规则、隐私边界、长段步骤从主界面下沉到按需查看。
 * - 桌面端：hover 轻预览（复用 v-tooltip），点击固定弹层（可复制正文）；
 * - 触屏 / Android：点击弹出，点外部 / Esc / 滚动 / 系统返回键关闭。
 */
const props = defineProps<{
  text?: string;
  title?: string;
  label?: string;
}>();

const slots = useSlots();
const triggerEl = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const open = ref(false);
const placed = ref(false);
const coords = ref({ left: 12, top: 12 });

const resolvedLabel = computed(() => props.label || (props.title ? `查看「${props.title}」说明` : '查看说明'));

const hoverTip = computed(() => {
  if (open.value || slots.default || !props.text) return '';
  return props.title ? { title: props.title, body: props.text } : props.text;
});

const popoverStyle = computed<CSSProperties>(() => ({
  left: `${coords.value.left}px`,
  top: `${coords.value.top}px`,
  visibility: placed.value ? 'visible' : 'hidden',
}));

let unregisterBack: (() => void) | null = null;
let listenersBound = false;

function place(): void {
  const trigger = triggerEl.value;
  const popover = popoverEl.value;
  if (!trigger || !popover) return;
  const anchor = trigger.getBoundingClientRect();
  const rect = popover.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchor.left + anchor.width / 2 - rect.width / 2;
  left = Math.max(margin, Math.min(left, vw - rect.width - margin));

  const spaceBelow = vh - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;
  let top = anchor.bottom + gap;
  if (spaceBelow < rect.height + gap && spaceAbove > spaceBelow) {
    top = Math.max(margin, anchor.top - rect.height - gap);
  } else if (top + rect.height > vh - margin) {
    top = Math.max(margin, vh - rect.height - margin);
  }

  coords.value = { left: Math.round(left), top: Math.round(top) };
  placed.value = true;
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
}

function onDocPointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (!target) return;
  if (triggerEl.value?.contains(target) || popoverEl.value?.contains(target)) return;
  close();
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  close();
  triggerEl.value?.focus();
}

function onViewportChange(): void {
  if (open.value) place();
}

function bindOpenListeners(): void {
  if (!listenersBound) {
    listenersBound = true;
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }
  if (!unregisterBack) {
    unregisterBack = registerBackHandler(() => {
      if (!open.value) return false;
      close();
      return true;
    });
  }
}

function unbindOpenListeners(): void {
  if (listenersBound) {
    listenersBound = false;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
  }
  unregisterBack?.();
  unregisterBack = null;
}

function toggle(): void {
  open.value = !open.value;
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    placed.value = false;
    unbindOpenListeners();
    return;
  }
  placed.value = false;
  bindOpenListeners();
  await nextTick();
  place();
});

onBeforeUnmount(() => {
  unbindOpenListeners();
});
</script>

<style scoped>
.help-tip-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  vertical-align: middle;
  transition: color var(--motion-fast) var(--ease-standard),
    background var(--motion-fast) var(--ease-standard);
}
.help-tip-btn:hover,
.help-tip-btn.is-open {
  background: var(--bg-hover);
  color: var(--accent);
}
.help-tip-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (hover: none) and (pointer: coarse) {
  .help-tip-btn::after {
    content: '';
    position: absolute;
    inset: -11px;
  }
}

.help-tip-popover {
  position: fixed;
  z-index: var(--z-menu);
  width: min(340px, calc(100vw - 24px));
  max-height: min(60vh, 420px);
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--card-bg);
  color: var(--text);
  font-size: var(--fs-small);
  line-height: 1.6;
  box-shadow: var(--shadow-dialog);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}
.help-tip-popover.is-placed {
  opacity: 1;
}
.help-tip-title {
  margin-bottom: 4px;
  color: var(--text);
  font-weight: 600;
}
.help-tip-body {
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.help-tip-body :deep(code) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  font-size: var(--fs-caption);
}
.help-tip-body :deep(p) {
  margin: 0 0 6px;
}
.help-tip-body :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
