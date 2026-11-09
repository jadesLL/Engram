<template>
  <!-- 周视图上方的逾期条：逾期一般就几条，先摆在看板之前，免得多任务那一列把这块顶出首屏 -->
  <section v-if="overdue.length" class="overdue-bar">
    <h3>
      <Icon name="alert" :size="13" />已逾期
      <span class="num">{{ overdue.length }} 件</span>
      <span class="hint">先补这些</span>
    </h3>
    <ul class="rows">
      <li v-for="card in overdue" :key="taskCardKey(card)" class="row">
        <span class="chip over">逾期 {{ overdueDays(card, today) }} 天</span>
        <span class="txt" :title="card.text">{{ card.text }}</span>
        <button
          class="complete-task"
          type="button"
          :disabled="completingKeys.has(taskCardKey(card))"
          :aria-label="`标记已完成：${card.text}`"
          @click="$emit('complete', card)"
        >
          <AppSpinner v-if="completingKeys.has(taskCardKey(card))" :size="13" />
          <Icon v-else name="check" :size="13" />
          {{ completingKeys.has(taskCardKey(card)) ? '保存中…' : '完成' }}
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { overdueDays, taskCardKey, type TaskCard } from '../../lib/taskBoard';

defineProps<{ overdue: TaskCard[]; today: string; completingKeys: Set<string> }>();
defineEmits<{ (e: 'complete', card: TaskCard): void }>();
</script>

<style scoped>
.overdue-bar {
  margin-bottom: 12px;
  padding: 10px 12px 11px;
  border: 1px solid rgba(196, 43, 28, 0.28);
  border-radius: var(--radius);
  background: var(--danger-soft);
}
.overdue-bar h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--danger);
}
.overdue-bar .num { font-variant-numeric: tabular-nums; }
.overdue-bar .hint { font-weight: 500; color: var(--text-secondary); }
.rows { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--text); }
.row .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip {
  flex: none;
  padding: 0 7px;
  border-radius: 9px;
  background: var(--card-bg);
  color: var(--danger);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
}
.complete-task {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11.5px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}
.complete-task:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.complete-task:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.complete-task:disabled { opacity: 0.65; cursor: wait; }
@media (hover: none) and (pointer: coarse) {
  .complete-task { min-height: 44px; min-width: 72px; justify-content: center; }
}
</style>
