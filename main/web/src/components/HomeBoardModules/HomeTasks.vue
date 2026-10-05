<template>
  <!-- 近期待办：逾期最优先，再按看板窗口内的日期顺序，周期与待定垫后（口径见 lib/homeBoard.ts） -->
  <div v-if="shown.length" class="tasks-list hb-card">
    <button
      v-for="(card, index) in shown"
      :key="index"
      class="mini-task"
      type="button"
      @click="$emit('go', '/tasks')"
    >
      <span class="mini-check" aria-hidden="true" />
      <span class="mini-main">
        <span class="mini-text">{{ card.text }}</span>
        <span v-if="taskMeta(card)" class="mini-meta">{{ taskMeta(card) }}</span>
      </span>
      <span class="hb-pill" :class="{ over: isOverdueCard(card) }">{{ dueLabel(card) }}</span>
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

const props = defineProps<{ cards: TaskCard[]; limit: number; loading?: boolean }>();
defineEmits<{ (e: 'go', path: string): void }>();

const shown = computed(() => (props.cards || []).slice(0, Math.max(1, props.limit || 3)));
</script>

<style scoped>
.tasks-list { display: flex; flex-direction: column; padding: 8px 14px; }
.mini-task {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  text-align: left;
}
.mini-task + .mini-task { border-top: 1px solid var(--border); }
.mini-check {
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 2px;
  border: 1.5px solid var(--border-strong, var(--border));
  border-radius: 6px;
  transition: border-color 150ms ease;
}
.mini-task:hover .mini-check { border-color: var(--accent); }
.mini-task:focus-visible { outline: none; }
.mini-task:focus-visible .mini-check { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.mini-main { flex: 1; min-width: 0; }
.mini-text { display: block; font-size: 13px; font-weight: 500; line-height: 1.45; color: var(--text); }
.mini-meta {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tasks-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-bottom: 8px; }
</style>
