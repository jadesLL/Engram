<template>
  <span
    class="app-spinner"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="status"
    :aria-label="label"
  />
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number; label?: string }>(), {
  size: 12,
  label: '加载中',
});
</script>

<style scoped>
.app-spinner {
  display: inline-block;
  flex-shrink: 0;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: app-spin 0.8s linear infinite;
}
@keyframes app-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
