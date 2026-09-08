<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="item in toastState.items" :key="item.id" class="app-toast" :class="item.kind">
          <span class="toast-icon">
            <Icon :name="iconFor(item.kind)" :size="14" />
          </span>
          <span class="toast-text">{{ item.text }}</span>
          <button class="btn icon toast-close" aria-label="关闭通知" @click="dismissToast(item.id)">
            <Icon name="x" :size="13" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import Icon from '../Icon.vue';
import { dismissToast, toastState, type ToastKind } from '../../lib/notify';

function iconFor(kind: ToastKind): string {
  if (kind === 'success') return 'check';
  if (kind === 'error') return 'x';
  return 'activity';
}
</script>

<style scoped>
.toast-stack {
  position: fixed;
  top: max(18px, env(safe-area-inset-top));
  right: 22px;
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 28px));
  pointer-events: none;
}
.app-toast {
  pointer-events: auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 12px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--card-bg) 92%, transparent);
  box-shadow: var(--shadow);
  backdrop-filter: saturate(150%) blur(20px);
  -webkit-backdrop-filter: saturate(150%) blur(20px);
}
.app-toast.success { border-left: 3px solid var(--success); }
.app-toast.error { border-left: 3px solid var(--danger); }
.app-toast.info { border-left: 3px solid var(--accent); }

.toast-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
}
.app-toast.success .toast-icon {
  background: color-mix(in srgb, var(--success) 14%, var(--bg));
  color: var(--success);
}
.app-toast.error .toast-icon {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg));
  color: var(--danger);
}
.app-toast.info .toast-icon {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--accent);
}

.toast-text {
  min-width: 0;
  padding-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}
.toast-close {
  width: 24px;
  height: 24px;
}

.toast-enter-active,
.toast-leave-active,
.toast-move {
  transition: opacity 160ms ease, transform 160ms ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(16px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.toast-leave-active {
  position: absolute;
  right: 0;
  width: 100%;
}
</style>
