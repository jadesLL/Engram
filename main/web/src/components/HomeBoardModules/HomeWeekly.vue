<template>
  <!-- 本周动态：最近 7 天各分区的新增 / 改动 / 字数（行的顺序固定：概念 → 实体 → 其它页面 → 灵感碎片） -->
  <div v-if="rows.length" class="hb-card weekly-card">
    <div class="week-hero"><strong class="big num">{{ totals.updated }}</strong><span>本周改动</span></div>
    <button v-for="row in rows" :key="row.key" class="week-row" type="button" @click="$emit('go', pathOf(row))">
      <span class="week-label">{{ row.label }}</span>
      <span class="week-bar"><i :style="{ width: bar(row) }" /></span>
      <span class="week-counts">
        <span v-if="row.created" class="week-new">+{{ row.created }}</span>
        <span class="week-words num">{{ formatCount(row.words, ' 字') }}</span>
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
.weekly-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.week-hero { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; flex: none; }
.week-hero .big {
  font-family: var(--font-display);
  font-size: 38px;
  font-weight: 400;
  line-height: .9;
  letter-spacing: -.03em;
  font-variant-numeric: lining-nums tabular-nums;
}
.week-hero span { font-size: 10.5px; color: var(--text-faint); }
.week-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-height: 33px;
  padding: 0;
  text-align: left;
  border-radius: 0;
  border-top: 1px solid var(--card-line-soft);
}
.week-row:first-of-type { border-top: 0; }
.week-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.week-label { flex: none; width: 52px; font-size: 11px; color: var(--text-secondary); }
.week-bar {
  flex: 1;
  min-width: 24px;
  height: 4px;
  border-radius: 999px;
  background: var(--card-line-soft);
  overflow: hidden;
}
.week-bar i { display: block; height: 100%; border-radius: 999px; background: var(--accent); opacity: .8; }
.week-counts { flex: none; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.week-new { font-size: 10px; font-weight: 650; color: var(--badge-idea); }
.week-words { font-size: 10px; color: var(--text-muted, var(--text-faint)); }
/* 2 格宽：标签列 + 轨道 + 计数放不下，轨道让位、计数改为右对齐可省略 */
@container (max-width: 260px) {
  .week-label { width: 42px; }
  .week-bar { min-width: 12px; }
  .week-counts { flex: 1; justify-content: flex-end; min-width: 0; }
  .week-words { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.week-foot {
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--card-line-soft);
  font-size: 10.5px;
  color: var(--text-muted, var(--text-faint));
}
</style>