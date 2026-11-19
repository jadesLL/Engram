<template>
  <!-- 近期待办：逾期最优先，再按看板窗口内的日期顺序，周期与待定垫后（口径见 lib/homeBoard.ts） -->
  <div v-if="shown.length" class="tasks-list hb-card">
    <button
      v-for="(card, index) in shown"
      :key="index"
      class="mini-task"
      type="button"
      :title="card.text"
      @click="$emit('go', '/tasks')"
    >
      <span class="mini-check" aria-hidden="true" />
      <span class="mini-main">
        <span class="mini-text">{{ card.text }}</span>
        <span v-if="taskMeta(card)" class="mini-meta">{{ taskMeta(card) }}</span>
      </span>
      <span class="mini-date num" :class="{ over: isOverdueCard(card) }">{{ dueLabel(card) }}</span>
    </button>
  </div>
  <p v-else-if="loading" class="hb-empty">正在读看板…</p>
  <div v-else class="tasks-empty">
    <p class="hb-empty">本周还没有排上的事。</p>
    <button class="btn small" type="button" @click="$emit('go', '/tasks')">打开任务看板</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { dueLabel, isOverdueCard, taskMeta } from '../../lib/homeBoardData.ts';
import type { TaskCard } from '../../lib/taskBoard.ts';

const props = defineProps<{ cards: TaskCard[]; limit: number; loading?: boolean; bodyHeight?: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const capacity = computed(() => (props.bodyHeight ? Math.max(1, Math.floor(props.bodyHeight / 49)) : 99));
const shown = computed(() => (props.cards || []).slice(0, Math.min(Math.max(1, props.limit || 3), capacity.value)));
</script>

<style scoped>
.tasks-list { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.mini-task {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  flex: 1;
  min-height: 49px;
  padding: 7px 0;
  text-align: left;
  /* 分隔线用 border-top 画：圆角必须归零，否则会继承全局 button 的 999px 胶囊圆角，两端弯成弧线 */
  border-radius: 0;
  border-top: 1px solid var(--card-line-soft);
}
.mini-task:first-child { border-top: 0; }
.mini-task:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.mini-check {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 2px;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
}
.mini-task:hover .mini-check { border-color: var(--accent); }
.mini-main { flex: 1; min-width: 0; }
/* 单行标题：卡内行高预算 49px 只够「一行标题 + 来源」，放两行会让来源溢出到
   行边界外、被下一行的 1px 分隔线压住；完整标题在悬停 tooltip 与任务看板里。 */
.mini-text {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.42;
  color: var(--text);
}
.mini-meta {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-muted, var(--text-faint));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-date {
  flex: none;
  margin-top: 1px;
  font-size: 10px;
  font-weight: 650;
  color: var(--badge-idea);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.mini-date.over { color: var(--danger); }
.tasks-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-bottom: 8px; }
</style>
