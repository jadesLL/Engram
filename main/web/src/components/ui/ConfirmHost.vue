<template>
  <AppModal
    :open="confirmState.open"
    v-tooltip="confirmState.title"
    width="min(400px, 92vw)"
    :auto-focus="false"
    @close="settleConfirm(false)"
  >
    <p v-if="confirmState.message" class="confirm-message">{{ confirmState.message }}</p>
    <input
      v-if="hasInput"
      ref="inputRef"
      v-model="inputValue"
      class="confirm-input"
      type="text"
      :placeholder="confirmState.placeholder"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="settleConfirm(true, inputValue)"
    />
    <template #footer>
      <button ref="cancelRef" class="btn" @click="settleConfirm(false)">
        {{ confirmState.cancelText || '取消' }}
      </button>
      <button
        ref="okRef"
        class="btn"
        :class="confirmState.danger ? 'danger-solid' : 'primary'"
        @click="submit"
      >
        {{ confirmState.confirmText || '确定' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { confirmState, settleConfirm } from '../../lib/confirm';

// 输入模式 = 提供了预填值或占位符（只传 value 不传 placeholder 的 promptDialog 也要渲染输入框）
const hasInput = computed(
  () => confirmState.placeholder !== undefined || confirmState.value !== undefined
);

const okRef = ref<HTMLButtonElement>();
const cancelRef = ref<HTMLButtonElement>();
const inputRef = ref<HTMLInputElement>();
const inputValue = ref('');

function submit() {
  settleConfirm(true, hasInput.value ? inputValue.value : undefined);
}

watch(
  () => confirmState.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    // 输入框模式：预填默认值并聚焦输入框，回车直接提交
    if (hasInput.value) {
      inputValue.value = confirmState.value ?? '';
      inputRef.value?.focus();
      inputRef.value?.select();
      return;
    }
    // 破坏性操作默认焦点落在「取消」，防止回车误删
    (confirmState.danger ? cancelRef.value : okRef.value)?.focus();
  }
);
</script>

<style scoped>
.confirm-message {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-input {
  width: 100%;
  margin-top: 10px;
  padding: 7px 11px;
  border: 1px solid var(--control-border);
  border-bottom-color: var(--control-border-strong);
  border-radius: 6px;
  background: var(--control-bg);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
}

.confirm-input:focus {
  background: var(--control-bg-hover);
  border-bottom-color: var(--accent);
  box-shadow: inset 0 -1px 0 var(--accent);
}
</style>
