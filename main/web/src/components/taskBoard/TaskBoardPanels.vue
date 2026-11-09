<template>
  <!-- 收尾块：已逾期（可手动完成）/ 周期 · 例行 / 其他时间；周视图会把逾期条移到看板上方，这里不重复 -->
  <div class="board-panels" :class="{ two: hideOverdue }">
    <section v-if="!hideOverdue" class="panel overdue">
      <h3><Icon name="alert" :size="13" />已逾期<span class="num">{{ overdue.length }} 件</span></h3>
      <ul v-if="overdue.length" class="rows">
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
      <p v-else class="none">没有逾期任务</p>
    </section>

    <section class="panel periodic">
      <h3><Icon name="refresh" :size="13" />周期 · 例行<span class="num">{{ periodic.length }} 件</span></h3>
      <ul v-if="periodic.length" class="rows">
        <li v-for="card in periodic" :key="taskCardKey(card)" class="row">
          <span class="chip when">{{ card.repeat || card.when || '周期' }}</span>
          <span class="txt" :title="card.text">{{ card.text }}</span>
        </li>
      </ul>
      <p v-else class="none">没有周期事项</p>
    </section>

    <section class="panel">
      <h3><Icon name="calendar" :size="13" />{{ laterTitle }}<span class="num">{{ later.length }} 件</span></h3>
      <ul v-if="later.length" class="rows">
        <li v-for="card in later" :key="taskCardKey(card)" class="row">
          <span class="chip when">{{ card.when || '待定' }}</span>
          <span class="txt" :title="card.text">{{ card.text }}</span>
        </li>
      </ul>
      <p v-else class="none">没有待定事项</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { overdueDays, taskCardKey, type TaskCard } from '../../lib/taskBoard';

defineProps<{
  overdue: TaskCard[];
  periodic: TaskCard[];
  later: TaskCard[];
  laterTitle: string;
  today: string;
  completingKeys: Set<string>;
  /** 周视图把逾期条放到看板上方，这里就不再画一遍 */
  hideOverdue?: boolean;
}>();
defineEmits<{ (e: 'complete', card: TaskCard): void }>();
</script>

<style scoped>
.board-panels {
  display: grid;
  grid-template-columns: 1.15fr 1fr 1fr;
  align-items: start;
  gap: 10px;
  margin-top: 12px;
}
.board-panels.two { grid-template-columns: 1fr 1fr; }
.panel {
  min-width: 0;
  padding: 10px 12px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}
.panel.overdue { border-color: rgba(196, 43, 28, 0.28); background: var(--danger-soft); }
.panel.periodic { border-style: dashed; }
.panel h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.panel.overdue h3 { color: var(--danger); }
.panel .num { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--text-secondary); font-weight: 600; }
.rows { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--text); }
.row .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip {
  flex: none;
  padding: 0 7px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10.5px;
  line-height: 18px;
  white-space: nowrap;
}
.chip.over { background: var(--danger-soft); color: var(--danger); font-weight: 600; }
.panel.overdue .chip.over { background: var(--card-bg); }
.chip.when { background: var(--badge-idea-soft); color: var(--badge-idea); }
.none { margin: 0; padding: 4px 0; font-size: 11.5px; color: var(--text-secondary); }
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
@media (max-width: 1024px) {
  .board-panels, .board-panels.two { grid-template-columns: 1fr; }
}
</style>
