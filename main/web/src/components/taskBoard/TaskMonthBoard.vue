<template>
  <!-- 月视图：整月日历（点某天 → 切到那一周处理）+ 各周负载 -->
  <div class="month-board">
    <div class="weekday-row" aria-hidden="true">
      <span v-for="weekday in WEEKDAYS" :key="weekday">{{ weekday }}</span>
    </div>
    <div class="month-grid">
      <div
        v-for="cell in model.cells"
        :key="cell.date"
        class="cell"
        :class="{ dim: !cell.inMonth, weekend: cell.weekend, today: cell.date === today, 'has-tasks': cardsOf(cell.date).length > 0 }"
      >
        <button
          v-if="cell.inMonth"
          class="cell-btn"
          type="button"
          :aria-label="ariaOf(cell.date)"
          @click="$emit('pick', cell.date)"
        >
          <span class="cell-date">
            {{ cell.day }}
            <em v-if="cell.date === today">今天</em>
            <span class="cell-weekday">{{ weekdayOf(cell.date) }}</span>
          </span>
          <span
            v-for="card in cardsOf(cell.date).slice(0, 2)"
            :key="taskCardKey(card)"
            class="cell-task"
            :class="{ over: isOverdue(card, today) }"
            :title="card.text"
          >{{ card.text }}</span>
          <span v-if="cardsOf(cell.date).length > 2" class="cell-more">还有 {{ cardsOf(cell.date).length - 2 }} 件</span>
        </button>
        <span v-else class="cell-date">{{ cell.day }}</span>
      </div>
    </div>

    <section class="week-load">
      <h3>
        <Icon name="activity" :size="13" />各周负载
        <span class="note">本月 {{ monthTotal }} 件<template v-if="model.overdue.length"> · 逾期 {{ model.overdue.length }} 件</template></span>
      </h3>
      <div v-for="week in model.weeks" :key="week.start" class="load-row" :class="{ current: week.current }">
        <span class="load-label">第 {{ week.index }} 周<em>{{ shortDate(week.start) }} – {{ shortDate(week.end) }}</em></span>
        <span class="load-track"><i :style="{ width: barWidth(week.count) }" /></span>
        <span class="load-val">{{ week.count }} 件</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { isOverdue, taskCardKey, weekdayOf, type MonthBoardModel } from '../../lib/taskBoard';

const props = defineProps<{ model: MonthBoardModel; today: string }>();
defineEmits<{ (e: 'pick', date: string): void }>();

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function cardsOf(date: string) {
  return props.model.byDate[date] || [];
}

function shortDate(date: string) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
}

const monthTotal = computed(() => props.model.weeks.reduce((sum, week) => sum + week.count, 0));
const maxLoad = computed(() => Math.max(1, ...props.model.weeks.map((week) => week.count)));

function barWidth(count: number) {
  return `${Math.max(count ? 6 : 0, Math.round((count / maxLoad.value) * 100))}%`;
}

function ariaOf(date: string) {
  const count = cardsOf(date).length;
  const [, month, day] = date.split('-');
  return `${Number(month)} 月 ${Number(day)} 日，${count ? `${count} 件任务` : '没有安排'}，点开看这一周`;
}
</script>

<style scoped>
.weekday-row {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
  padding-bottom: 4px;
}
.weekday-row span { text-align: center; font-size: 11px; color: var(--text-faint); }
.month-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.cell {
  min-width: 0;
  min-height: 62px;
  padding: 5px 6px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--card-bg);
}
.cell.dim { background: var(--bg-tertiary); }
.cell.weekend { background: var(--bg-secondary); }
.cell.today { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.cell-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cell-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.cell-date {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.cell.today .cell-date { color: var(--accent); }
.cell-date em {
  font-style: normal;
  font-size: 9.5px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
}
.cell-weekday { display: none; font-size: 10px; font-weight: 500; color: var(--text-faint); }
.cell-task {
  display: block;
  padding: 0 5px;
  border-left: 2px solid var(--accent);
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--text);
  font-size: 10.5px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-task.over { border-left-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
.cell-more { font-size: 10px; color: var(--text-faint); }
.week-load {
  margin-top: 14px;
  padding: 12px 14px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}
.week-load h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 650;
}
.week-load .note { font-size: 11.5px; font-weight: 500; color: var(--text-faint); }
.load-row {
  display: grid;
  grid-template-columns: 128px 1fr 46px;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.load-label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.load-label em { font-style: normal; margin-left: 6px; font-size: 11px; color: var(--text-faint); }
.load-row.current .load-label { color: var(--accent); font-weight: 600; }
.load-track { height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
.load-track i { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
.load-val { text-align: right; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

/* 手机档：7 列日历读不清，改成「有任务的日子」列表，点一行照旧进那一周 */
@media (max-width: 640px) {
  .weekday-row { display: none; }
  .month-grid { display: flex; flex-direction: column; gap: 6px; }
  .cell { min-height: 0; padding: 8px 10px; }
  .cell.dim, .cell:not(.has-tasks):not(.today) { display: none; }
  .cell-btn { flex-direction: column; gap: 5px; }
  .cell-date { gap: 6px; font-size: 12px; }
  .cell-weekday { display: inline; }
  .load-row { grid-template-columns: 1fr 52px; }
  .load-track { display: none; }
}
</style>
