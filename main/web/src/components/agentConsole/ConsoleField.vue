<template>
  <div class="console-field">
    <span class="console-field-label">
      {{ label }}
      <small v-if="hint">{{ hint }}</small>
    </span>
    <div class="console-field-control">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 控制台表单行：左标题（+ 灰说明）、右控件。
 * 版式与设置页 .setting-row 同一套（168px 标签列 + 自适应控件列），
 * 收窄时由外层面板的容器查询切成单列（见各面板的 @container 规则）。
 */
withDefaults(defineProps<{ label: string; hint?: string }>(), { hint: '' });
</script>

<style scoped>
.console-field {
  display: grid;
  grid-template-columns: minmax(120px, 168px) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 9px 0;
}
.console-field-label {
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.45;
}
.console-field-label small {
  display: block;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.45;
}
.console-field-control {
  min-width: 0;
}

@container (max-width: 520px) {
  .console-field {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
}
</style>
