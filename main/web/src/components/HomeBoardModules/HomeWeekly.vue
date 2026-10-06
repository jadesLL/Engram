<template>
  <!-- 本周动态：最近 7 天各分区的新增 / 改动 / 字数（行的顺序固定：概念 → 实体 → 其它页面 → 灵感碎片） -->
  <div v-if="rows.length" class="hb-card weekly-card">
    <button v-for="row in rows" :key="row.key" class="week-row" type="button" @click="$emit('go', pathOf(row))">
      <span class="week-label">{{ row.label }}</span>
      <span class="week-bar"><i :style="{ width: bar(row) }" /></span>
      <span class="week-counts">
        <span v-if="row.created" class="week-new">+{{ row.created }}</span>
        <span class="week-words">{{ formatCount(row.words, ' 字') }}</span>
      </span>
    </button>
    <p class="week-foot muted">近 7 天新增 {{ totals.created }} 篇 · 改动 {{ totals.updated }} 篇 · 合计 {{ formatCount(totals.words, ' 字') }}</p>
  </div>
  <p v-else class="hb-empty">近 7 天还没有改动。写点东西，这里就会长出来。</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatCount } from '../../lib/homeBoardData.ts';
import type { WeeklyStat } from '../../lib/homeBoard.ts';

const props = defineProps<{ rows: WeeklyStat[]; days?: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

/** 行上的分区落点：概念/实体去各自搜索结果，其它页面与灵感碎片同理 */
const PATHS: Record<string, string> = {
  concept: '/search?q=概念',
  entity: '/search?q=实体',
  note: '/search?q=Wiki',
  idea: '/search?q=灵感碎片',
};
function pathOf(row: WeeklyStat): string {
  return PATHS[row.key] || '/search';
}

const max = computed(() => Math.max(1, ...props.rows.map((row) => row.words)));
function bar(row: WeeklyStat): string {
  return `${Math.max(6, Math.round((row.words / max.value) * 100))}%`;
}

const totals = computed(() =>
  props.rows.reduce(
    (acc, row) => ({ created: acc.created + row.created, updated: acc.updated + row.updated, words: acc.words + row.words }),
    { created: 0, updated: 0, words: 0 }
  )
);
</script>

<style scoped>
.weekly-card { padding: 8px 14px 6px; }
.week-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  text-align: left;
  border-radius: 8px;
}
.week-row + .week-row { border-top: 1px solid var(--border); }
.week-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.week-label { flex: none; width: 58px; font-size: 12.5px; color: var(--text-secondary); }
.week-bar {
  flex: 1;
  min-width: 24px;
  height: 5px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.week-bar i { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
.week-counts { flex: none; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.week-new { font-size: 11px; font-weight: 600; color: var(--badge-idea); }
.week-words { font-size: 11px; color: var(--text-faint); }
.week-foot { padding: 8px 0 4px; font-size: 11px; border-top: 1px solid var(--border); }
</style>
