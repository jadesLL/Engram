<template>
  <AppModal
    :open="confirmState.open"
    v-tooltip="confirmState.title"
    width="min(400px, 92vw)"
    :auto-focus="false"
    @close="settleConfirm(false)"
  >
    <p v-if="confirmState.message" class="confirm-message">{{ confirmState.message }}</p>
    <template #footer>
      <button ref="cancelRef" class="btn" @click="settleConfirm(false)">
        {{ confirmState.cancelText || '取消' }}
      </button>
      <button
        ref="okRef"
        class="btn"
        :class="confirmState.danger ? 'danger-solid' : 'primary'"
        @click="settleConfirm(true)"
      >
        {{ confirmState.confirmText || '确定' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { confirmState, settleConfirm } from '../../lib/confirm';

const okRef = ref<HTMLButtonElement>();
const cancelRef = ref<HTMLButtonElement>();

// 破坏性操作默认焦点落在「取消」，防止回车误删
watch(
  () => confirmState.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    (confirmState.danger ? cancelRef.value : okRef.value)?.focus();
  }
);
</script>

<style scoped>
.confirm-message {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
