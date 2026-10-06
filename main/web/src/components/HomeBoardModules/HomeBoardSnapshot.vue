<template>
  <!-- 看板快照：任务看板三列各几条，点开进看板 -->
  <div v-if="columns.length" class="hb-card board-card">
    <div class="board-cols">
      <button v-for="col in columns" :key="col.title" class="board-col" type="button" @click="$emit('go', '/tasks')">
        <span class="board-name">{{ col.title }}</span>
        <span class="board-num num" :class="{ over: col.bucket === 'overdue' }">{{ col.cards.length }}</span>
        <span v-for="card in col.cards.slice(0, 2)" :key="card.text" class="board-item">{{ card.text }}</span>
        <span v-if="col.cards.length > 2" class="board-more">还有 {{ col.cards.length - 2 }} 条</span>
      </button>
    </div>
    <p class="board-foot muted">共 {{ total }} 张卡 · 点开进任务看板</p>
  </div>
  <p v-else-if="loading" class="hb-empty">正在读看板…</p>
  <p v-else class="hb-empty">看板上还没有卡片。</p>
</template>

<script setup lang="ts">
/**
 * 看板快照：取任务看板的三类分列（客户与项目 / 团队与例行 / 时间待定与逾期）。
 * 只读快照，不放筛选与操作——那是看板页的职责。
 */
import { computed } from 'vue';
import { boardColumns, type TaskBoard, type TaskBoardColumn } from '../../lib/taskBoard.ts';

const props = defineProps<{ board: TaskBoard | null; loading?: boolean }>();
defineEmits<{ (e: 'go', path: string): void }>();

/** 只留三类来源列 + 逾期，最多四列（模型自己加的分节不进快照） */
const columns = computed<TaskBoardColumn[]>(() =>
  boardColumns(props.board)
    .filter((col) => col.bucket === 'source' || col.bucket === 'overdue')
    .slice(0, 4)
);
const total = computed(() => columns.value.reduce((sum, col) => sum + col.cards.length, 0));
</script>

<style scoped>
.board-card { padding: 12px 14px 10px; }
.board-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.board-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-secondary);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
}
.board-col:hover { border-color: var(--accent); background: var(--card-bg); }
.board-col:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.board-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
  font-size: 10.5px;
}
.board-num { font-size: 17px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.board-num.over { color: var(--danger); }
.board-item {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--card-bg);
  font-size: 11px;
  color: var(--text-secondary);
}
.board-more { color: var(--text-faint); font-size: 10.5px; }
.board-foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 11px; }
@media (max-width: 640px) { .board-cols { grid-template-columns: minmax(0, 1fr); } }
</style>
