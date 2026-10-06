<template>
  <!-- 近 N 周热力格：每格一天，颜色深浅 = 那天有改动的页面数 -->
  <div class="hb-card heat-card">
    <div class="heat-grid" :style="{ '--weeks': weeks }">
      <span
        v-for="cell in cells"
        :key="cell.date"
        class="heat-cell"
        :class="[`l${cell.level}`, { future: cell.future }]"
        :title="cell.future ? '' : `${cell.date}：${cell.count} 处改动`"
      />
    </div>
    <div class="heat-foot">
      <span class="muted">近 {{ weeks }} 周改动 {{ total }} 处 · 最勤的一天 {{ max }} 处</span>
      <span class="heat-legend">
        <i class="l0" /><i class="l1" /><i class="l2" /><i class="l3" /><i class="l4" />
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { heatmapDayCounts } from '../../lib/homeBoard.ts';

const props = defineProps<{ pages: any[]; weeks: number }>();

const weeks = computed(() => Math.min(12, Math.max(4, Math.round(props.weeks) || 8)));
const cells = computed(() => heatmapDayCounts(props.pages, weeks.value));
const total = computed(() => cells.value.reduce((sum, cell) => sum + cell.count, 0));
const max = computed(() => cells.value.reduce((top, cell) => Math.max(top, cell.count), 0));
</script>

<style scoped>
.heat-card { padding: 14px 16px 10px; }
.heat-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  /* 按周铺行：每 7 格一行（第 1 行是第 1 周的周日…周六） */
  grid-auto-rows: 1fr;
  gap: 3px;
}
.heat-cell {
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 3px;
  background: var(--bg-tertiary);
}
.heat-cell.future { background: transparent; }
.heat-cell.l1 { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.heat-cell.l2 { background: color-mix(in srgb, var(--accent) 42%, transparent); }
.heat-cell.l3 { background: color-mix(in srgb, var(--accent) 66%, transparent); }
.heat-cell.l4 { background: var(--accent); }
.heat-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
.heat-legend { display: flex; align-items: center; gap: 3px; }
.heat-legend i { width: 10px; height: 10px; border-radius: 3px; background: var(--bg-tertiary); }
.heat-legend i.l1 { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.heat-legend i.l2 { background: color-mix(in srgb, var(--accent) 42%, transparent); }
.heat-legend i.l3 { background: color-mix(in srgb, var(--accent) 66%, transparent); }
.heat-legend i.l4 { background: var(--accent); }
</style>
