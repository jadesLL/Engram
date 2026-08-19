<template>
  <Teleport to="body">
    <Transition :name="placement === 'right' ? 'app-modal-side' : 'app-modal'">
      <div
        v-if="open"
        class="app-modal-mask"
        :class="{ right: placement === 'right' }"
        @click.self="onMaskClick"
      >
        <div
          ref="dialogRef"
          class="app-modal card"
          :class="{ right: placement === 'right' }"
          :style="{ width: resolvedWidth }"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <header class="app-modal-head">
            <div class="app-modal-title">
              <h3 :id="titleId">{{ title }}</h3>
              <slot name="subtitle" />
            </div>
            <button class="btn icon" aria-label="关闭" @click="emit('close')">
              <Icon name="x" :size="16" />
            </button>
          </header>
          <div class="app-modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="app-modal-foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import Icon from '../Icon.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 部分调用方（抽屉、预览类弹窗）无标题 */
    title?: string;
    /** center 居中对话框；right 右侧滑出面板 */
    placement?: 'center' | 'right';
    width?: string;
    closeOnMask?: boolean;
    /** 内容由调用方自行管理焦点时关闭（如 ConfirmHost） */
    autoFocus?: boolean;
  }>(),
  { placement: 'center', width: '', closeOnMask: true, autoFocus: true, title: '' }
);

const emit = defineEmits<{ close: [] }>();

const titleId = `app-modal-title-${useId()}`;
const dialogRef = ref<HTMLElement>();
let previousActive: HTMLElement | null = null;

const resolvedWidth = computed(
  () => props.width || (props.placement === 'right' ? 'min(420px, 92vw)' : 'min(560px, 94vw)')
);

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousActive = document.activeElement as HTMLElement | null;
      await nextTick();
      if (props.autoFocus) dialogRef.value?.focus();
    } else if (previousActive?.isConnected) {
      previousActive.focus();
      previousActive = null;
    }
  }
);

function onMaskClick() {
  if (props.closeOnMask) emit('close');
}

function focusables(): HTMLElement[] {
  const root = dialogRef.value;
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && (active === first || active === dialogRef.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.app-modal-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 15, 15, 0.38);
}
:global(html.dark) .app-modal-mask {
  background: rgba(0, 0, 0, 0.52);
}
.app-modal-mask.right {
  justify-content: flex-end;
  padding: 0;
}

.app-modal {
  max-height: min(860px, 92vh);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  outline: none;
}
.app-modal.right {
  height: 100%;
  max-height: none;
  border: none;
  border-left: 1px solid var(--border);
  border-radius: 0;
}

.app-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}
.app-modal-title h3 {
  margin: 0;
}
.app-modal-title p {
  margin: 5px 0 0;
}

.app-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.app-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.app-modal-enter-active,
.app-modal-leave-active,
.app-modal-side-enter-active,
.app-modal-side-leave-active {
  transition: opacity 160ms ease;
}
.app-modal-enter-active .app-modal,
.app-modal-leave-active .app-modal,
.app-modal-side-enter-active .app-modal,
.app-modal-side-leave-active .app-modal {
  transition: transform 160ms ease, opacity 160ms ease;
}
.app-modal-enter-from,
.app-modal-leave-to,
.app-modal-side-enter-from,
.app-modal-side-leave-to {
  opacity: 0;
}
.app-modal-enter-from .app-modal,
.app-modal-leave-to .app-modal {
  transform: translateY(8px) scale(0.99);
}
.app-modal-side-enter-from .app-modal,
.app-modal-side-leave-to .app-modal {
  transform: translateX(24px);
}
</style>
