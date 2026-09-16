<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="item in toastState.items" :key="item.id" class="app-toast" :class="item.kind">
          <span class="toast-icon">
            <Icon :name="iconFor(item.kind)" :size="15" />
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
/*
 * 极简线条（Linear 风）：1px 细线框 + 零色块 + 小字号高密度。
 * 类型仅由行内彩色图标表达，不铺设色块/色条，阴影压到最轻。
 */
.toast-stack {
  position: fixed;
  top: max(18px, env(safe-area-inset-top));
  right: 22px;
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(340px, calc(100vw - 28px));
  pointer-events: none;
}
.app-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--card-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 8px 24px -12px rgba(0, 0, 0, 0.14);
}
:global(html.dark) .app-toast {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 28px -10px rgba(0, 0, 0, 0.6);
}

.toast-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.app-toast.success .toast-icon { color: var(--success); }
.app-toast.error .toast-icon { color: var(--danger); }
.app-toast.info .toast-icon { color: var(--accent); }

.toast-text {
  min-width: 0;
  flex: 1;
  font-size: var(--font-sm);
  line-height: 1.45;
  word-break: break-word;
}
.toast-close {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-faint);
}
.toast-close:hover { color: var(--text); }

.toast-enter-active,
.toast-leave-active,
.toast-move {
  transition: opacity 200ms ease, transform 200ms ease;
}
.toast-leave-active {
  transition-duration: 160ms;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(14px);
}
.toast-leave-to {
  opacity: 0;
}
.toast-leave-active {
  position: absolute;
  right: 0;
  width: 100%;
}
</style>
