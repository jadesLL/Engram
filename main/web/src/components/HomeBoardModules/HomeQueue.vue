<template>
  <!-- 等待提炼：刚落盘、还没被 Agent 提炼进 Wiki 的原始资料 / 灵感 -->
  <div v-if="shown.length" class="queue-list">
    <button
      v-for="page in shown"
      :key="page.path"
      class="hb-row queue-row"
      type="button"
      @click="$emit('go', rawMaterialRoute(page))"
    >
      <span class="queue-icon"><Icon :name="isIdea(page) ? 'lightbulb' : 'file'" :size="14" /></span>
      <span class="hb-row-main">
        <span class="hb-row-title">{{ page.name }}</span>
        <span class="hb-row-meta">{{ page.path }}</span>
      </span>
      <span class="hb-pill plain">{{ pendingDistillLabel(page) }}</span>
    </button>
  </div>
  <p v-if="error" class="hb-empty" role="status">{{ error }}</p>
  <p v-else-if="loading && !shown.length" class="hb-empty">正在读取待提炼资料…</p>
  <p v-else-if="!shown.length" class="hb-empty">没有等待提炼的资料。记一条灵感，或把文件拖进收集箱。</p>
</template>

<script setup lang="ts">
/** 与侧栏共用文件接口的账本标记，展示全部资料类型；不推断任务是否在排队。 */
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { pendingDistillOf, pendingDistillLabel, rawMaterialRoute } from '../../lib/homeBoard.ts';

const props = defineProps<{ files: any[]; limit: number; loading: boolean; error: string }>();
defineEmits<{ (e: 'go', path: string): void }>();

const shown = computed(() => pendingDistillOf(props.files, Math.max(1, props.limit || 4)));
function isIdea(page: any): boolean {
  return String(page?.path || '').startsWith('原始资料/灵感碎片/');
}
</script>

<style scoped>
.queue-list { display: flex; flex-direction: column; gap: 2px; }
.queue-row { padding: 9px 12px; gap: 10px; }
.queue-icon {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-secondary);
}
</style>
