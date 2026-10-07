<template>
  <div class="heat-card" title="按页面最近更新时间统计，每篇页面计入一天">
    <div class="heat-summary"><strong>{{ active }}</strong><span>活跃日 <small>近 {{ weeks }} 周</small></span></div>
    <div class="heat-grid" :style="{ '--weeks': weeks }">
      <button v-for="(cell, i) in cells" :key="cell.date" type="button" class="heat-cell" :class="[`l${cell.level}`, { future: cell.future, selected: cell.date === selected }]"
        :style="{ gridColumn: Math.floor(i / 7) + 1, gridRow: i % 7 + 1 }" :disabled="cell.future"
        :aria-label="`${cell.date}：${cell.count} 篇页面最近更新`" :aria-pressed="cell.date === selected"
        :title="cell.future ? '未来日期' : `${cell.date} · ${cell.count} 篇页面最近更新`" @click="selected = cell.date" />
    </div>
    <div class="heat-foot"><span>{{ total }} 篇页面</span><span class="heat-legend">少 <i v-for="level in 5" :key="level" :class="`l${level - 1}`" /> 多</span></div>
    <div v-if="selected" class="heat-detail"><label>查看日期 <input v-model="selected" type="date" :min="cells[0]?.date" :max="today" /></label><p>{{ selected }} · {{ selectedCount }} 篇页面最近更新</p></div>
    <p class="heat-note">按页面最近更新时间统计，每篇页面计入一天。</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { heatmapDayCounts } from '../../lib/homeBoard.ts';
const props = defineProps<{ pages: any[]; weeks: number }>();
const selected = ref('');
const weeks = computed(() => Math.min(12, Math.max(4, Math.round(props.weeks) || 8)));
const cells = computed(() => heatmapDayCounts(props.pages, weeks.value));
const total = computed(() => cells.value.filter((c) => !c.future).reduce((sum, cell) => sum + cell.count, 0));
const active = computed(() => cells.value.filter((cell) => !cell.future && cell.count > 0).length);
const today = computed(() => cells.value.filter((c) => !c.future).at(-1)?.date);
const selectedCount = computed(() => cells.value.find((c) => c.date === selected.value)?.count || 0);
</script>
<style scoped>
.heat-card {
  min-width:0;
}
.heat-summary {
  display:flex;
  gap:12px;
  align-items:center;
  margin-bottom:12px;
}
.heat-summary strong {
  font-size:34px;
  line-height:1;
  font-weight:700;
  letter-spacing:-.05em;
  color:var(--text);
}
.heat-summary span {
  font-size:12px;
  color:var(--text-secondary);
}
.heat-summary small {
  display:block;
  margin-top:4px;
  font-size:10px;
  color:var(--text-faint);
}
.heat-grid {
  display:grid;
  grid-template-columns:repeat(var(--weeks),minmax(0,1fr));
  grid-template-rows:repeat(7,minmax(0,1fr));
  gap:4px;
  width:100%;
  max-width:calc(var(--weeks) * 17px + (var(--weeks) - 1) * 4px);
}
.heat-cell {
  aspect-ratio:1;
  border-radius:4px;
  background:var(--bg-tertiary);
  min-width:0;
  max-height:none;
}
.heat-cell.future {
  opacity:.15;
  cursor:default;
}
.heat-cell:hover:not(:disabled),.heat-cell:focus-visible,.heat-cell.selected {
  outline:2px solid var(--accent);
  outline-offset:1px;
}
.l1 {
  background:color-mix(in srgb,var(--accent) 22%,var(--card-bg));
}
.l2 {
  background:color-mix(in srgb,var(--accent) 42%,var(--card-bg));
}
.l3 {
  background:color-mix(in srgb,var(--accent) 66%,var(--card-bg));
}
.l4 {
  background:var(--accent);
}
.heat-foot {
  display:flex;
  justify-content:space-between;
  gap:8px;
  margin-top:12px;
  font-size:10px;
  color:var(--text-faint);
}
.heat-legend {
  display:flex;
  align-items:center;
  gap:3px;
}
.heat-legend i {
  width:8px;
  height:8px;
  border-radius:2px;
}
.heat-legend .l0 {
  background:var(--bg-tertiary);
}
.heat-note {
  display:none;
  font-size:10px;
  color:var(--text-faint);
  line-height:1.6;
  margin-top:10px;
}
.heat-detail {
  margin-top:16px;
  font-size:12px;
  color:var(--text-secondary);
  line-height:1.8;
}
.heat-detail label {
  display:flex;
  gap:12px;
  align-items:center;
}
.heat-detail input {
  background:var(--bg-secondary);
  color:var(--text);
  border:1px solid var(--border);
  padding:6px 8px;
  border-radius:6px;
  font:inherit;
}
:global(.detail-panel .heat-note) {
  display:block;
}
:global(.detail-panel .heat-grid) {
  max-width:min(500px,100%);
}
@container (min-height:400px) {
  .heat-note {
    display:block;
  }
  .heat-grid {
    max-width:calc(var(--weeks) * 30px + (var(--weeks) - 1) * 4px);
  }
}
</style>
