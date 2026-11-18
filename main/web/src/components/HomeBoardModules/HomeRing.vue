<template>
  <!-- 库占比：一个环 + 三行明细（环里是最大的那一类占比） -->
  <div class="hb-card ring-card">
    <div class="ring-wrap">
      <div class="ring" :style="{ '--p': Math.round(topRatio * 100) }">
        <span class="ring-value">{{ topValue }}</span>
        <span class="ring-label">{{ topLabel }}</span>
      </div>
      <div class="ring-rows">
        <button v-for="row in rows" :key="row.key" class="ring-row" type="button" @click="$emit('go', row.path)">
          <span class="ring-dot" :style="{ background: row.color }" />
          <span class="ring-name">{{ row.label }}</span>
          <span class="ring-num num">{{ row.value }}</span>
          <span class="ring-pct num">{{ Math.round(row.ratio * 100) }}%</span>
        </button>
      </div>
    </div>
    <p class="ring-foot muted">共 {{ total }} 项 · 占比按三类合计算</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ratioRows } from '../../lib/homeBoard.ts';

const props = defineProps<{ pages: any[]; files: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const COLORS: Record<string, string> = {
  concept: 'var(--badge-concept)',
  entity: 'var(--badge-entity)',
  file: 'var(--badge-idea)',
};
const PATHS: Record<string, string> = {
  concept: '/search?q=概念',
  entity: '/search?q=实体',
  file: '/search?q=原始资料',
};

const data = computed(() => ratioRows(props.pages, props.files));
const rows = computed(() =>
  data.value.rows.map((row) => ({ ...row, color: COLORS[row.key], path: PATHS[row.key] }))
);
const total = computed(() => data.value.total);
const top = computed(() => [...rows.value].sort((left, right) => right.value - left.value)[0]);
const topRatio = computed(() => top.value?.ratio || 0);
const topValue = computed(() => top.value?.value || 0);
const topLabel = computed(() => top.value?.label || '');
</script>

<style scoped>
.ring-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.ring-wrap { display: flex; align-items: center; gap: 16px; flex: 1; min-height: 0; }
.ring {
  --p: 0;
  width: 84px;
  height: 84px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: conic-gradient(var(--accent) calc(var(--p) * 1%), var(--bg-tertiary) 0);
}
.ring::before {
  content: '';
  position: absolute;
  width: 62px;
  height: 62px;
  border-radius: 50%;
  background: var(--card-bg);
}
.ring { position: relative; }
.ring-value,
.ring-label { position: relative; z-index: 1; }
.ring-value { font-family: var(--font-display); font-size: 24px; font-weight: 400; font-variant-numeric: lining-nums tabular-nums; line-height: 1; }
.ring-label { font-size: 10.5px; color: var(--text-faint); }
.ring-rows { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ring-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-height: 26px;
  padding: 0;
  border-radius: 0;
  font-size: 10.5px;
  text-align: left;
}
.ring-row + .ring-row { border-top: 1px solid var(--card-line-soft); }
.ring-row:hover .ring-name { color: var(--accent); }
.ring-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.ring-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; }
.ring-name { color: var(--text-secondary); }
.ring-num { margin-left: auto; font-weight: 650; font-variant-numeric: tabular-nums; }
.ring-pct { width: 32px; text-align: right; color: var(--text-faint); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.ring-foot { margin-top: auto; padding-top: 9px; border-top: 1px solid var(--card-line-soft); font-size: 10px; color: var(--text-faint); }
</style>
