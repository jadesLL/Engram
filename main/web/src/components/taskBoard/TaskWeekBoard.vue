<template>
  <!-- 周视图：周一到周日 7 列，每列是一天要干的事（窄屏单列竖排，一天一块） -->
  <div class="week-board">
    <section
      v-for="day in days"
      :key="day.date"
      class="day-col"
      :class="{ today: day.date === today, weekend: isWeekend(day.date) }"
    >
      <header class="day-head">
        <span class="day-weekday">{{ weekdayOf(day.date) }}</span>
        <span class="day-date">{{ shortDate(day.date) }}</span>
        <em v-if="day.date === today" class="day-today">今天</em>
        <span class="day-count" :aria-label="`${day.cards.length} 件任务`">{{ day.cards.length }}</span>
      </header>
      <div v-if="day.cards.length" class="day-cards">
        <TaskCardItem
          v-for="card in day.cards"
          :key="taskCardKey(card)"
          :card="card"
          :overdue="isOverdue(card, today)"
          :overdue-days="overdueDays(card, today)"
          :completing="completingKeys.has(taskCardKey(card))"
          @complete="$emit('complete', $event)"
          @open="$emit('open', $event)"
        />
      </div>
      <p v-else class="day-empty">本日暂无</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import TaskCardItem from './TaskCardItem.vue';
import {
  isOverdue,
  isWeekend,
  overdueDays,
  taskCardKey,
  weekdayOf,
  type TaskCard,
  type WeekColumnView,
} from '../../lib/taskBoard';

defineProps<{ days: WeekColumnView[]; today: string; completingKeys: Set<string> }>();
defineEmits<{ (e: 'complete', card: TaskCard): void; (e: 'open', card: TaskCard): void }>();

/** 11/9 */
function shortDate(date: string) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
}
</script>

<style scoped>
.week-board {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
  align-items: start;
}
.day-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  min-height: 170px;
}
.day-col.weekend { background: var(--bg-tertiary); }
.day-col.today {
  border-color: rgba(43, 92, 230, 0.4);
  background: var(--card-bg);
  box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-card);
}
.day-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 1px 2px 7px;
  border-bottom: 1px solid var(--border);
}
.day-weekday { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.day-col.today .day-weekday { color: var(--accent); }
.day-date { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.day-today {
  font-style: normal;
  font-size: 9.5px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  line-height: 16px;
}
.day-count {
  margin-left: auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.day-cards { display: flex; flex-direction: column; gap: 8px; }
.day-empty { margin: 0; padding: 12px 0; text-align: center; font-size: 11.5px; color: var(--text-secondary); }

/* 窄窗口 / 平板竖屏：7 列放不下，改成一天一块竖排（与手机端同一口径） */
@media (max-width: 1024px) {
  .week-board { grid-template-columns: 1fr; }
  .day-col { min-height: 0; }
  .day-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
}
</style>
