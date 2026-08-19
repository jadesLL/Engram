<template>
  <div class="app-empty">
    <Icon v-if="icon" :name="icon" :size="26" class="app-empty-icon" />
    <p class="app-empty-title">{{ title }}</p>
    <p v-if="hint" class="app-empty-hint">{{ hint }}</p>
    <div v-if="$slots.default" class="app-empty-actions">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '../Icon.vue';

withDefaults(defineProps<{ icon?: string; title?: string; hint?: string }>(), {
  icon: '',
  title: '',
  hint: '',
});
</script>

<style scoped>
.app-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 20px;
  text-align: center;
}
.app-empty-icon {
  color: var(--text-faint);
  margin-bottom: 2px;
}
.app-empty-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}
.app-empty-hint {
  margin: 0;
  max-width: 320px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.app-empty-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
</style>
