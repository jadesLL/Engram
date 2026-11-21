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
.board-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.board-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; flex: 1; min-height: 0; }
.board-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--card-line-soft);
  border-radius: 8px;
  background: var(--bg-secondary);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease;
}
.board-col:hover { border-color: var(--border-strong); background: var(--bg-tertiary); }
.board-col:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.board-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
  font-size: 9.5px;
}
.board-num {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 400;
  line-height: 1;
  font-variant-numeric: lining-nums tabular-nums;
}
.board-num.over { color: var(--danger); }
.board-item {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 6px;
  border-radius: 5px;
  background: var(--card-bg);
  font-size: 10px;
  color: var(--text-secondary);
}
.board-more { color: var(--text-faint); font-size: 9.5px; }
.board-foot { margin-top: auto; padding-top: 9px; border-top: 1px solid var(--card-line-soft); font-size: 10px; color: var(--text-faint); }
@container (max-width: 420px) {
  .board-cols { grid-template-columns: 1fr; gap: 0; }
  .board-col {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    padding: 0;
    border: 0;
    border-top: 1px solid var(--card-line-soft);
    border-radius: 0;
    background: transparent;
  }
  .board-col:first-child { border-top: 0; }
  .board-name { flex: 1; font-size: var(--fs-caption); }
  .board-num { order: 2; font-size: var(--fs-h1); }
  .board-item, .board-more { display: none; }
}
</style>
