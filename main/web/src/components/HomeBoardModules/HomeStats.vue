<template>
  <!-- 知识库概览：概念 / 实体 / 原始资料三类计数，条按最大值归一 -->
  <div class="stats-card">
    <div class="stats-hero">
      <strong class="big num">{{ pages }}</strong>
      <span class="unit">篇知识页面</span>
      <span v-if="words" class="stats-words">全库 {{ formatCount(words, ' 字') }}</span>
    </div>
    <div class="stats-meter" aria-hidden="true">
      <i v-for="row in rows" :key="row.key" :style="{ width: share(row.value), background: `var(--${row.badge})` }" />
    </div>
    <div class="stats-legend">
      <span v-for="row in rows" :key="row.key"><i :style="{ background: `var(--${row.badge})` }" />{{ row.label }} {{ row.value }}</span>
    </div>
    <div class="stats-rows">
      <button v-for="row in rows" :key="row.key" class="stat-row" type="button" @click="$emit('go', row.path)">
        <i class="stat-dot" :style="{ background: `var(--${row.badge})` }" aria-hidden="true" />
        <span class="stat-lb">{{ row.label }}</span>
        <span class="stat-bar"><i :style="{ width: bar(row.value), background: `var(--${row.badge})` }" /></span>
        <span class="stat-vl num">{{ row.value }}</span>
        <span class="stat-share num">{{ sharePct(row.value) }}</span>
      </button>
    </div>
    <p class="stats-foot">
      共 {{ pages }} 个页面<template v-if="words"> · {{ formatCount(words, ' 字') }}</template> · 资料份数 {{ counts.files }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatCount } from '../../lib/homeBoardData.ts';

const props = defineProps<{
  pages: number;
  counts: { concepts: number; entities: number; files: number };
  /** 全库字数（可选：老调用方不传也能用） */
  words?: number;
}>();
defineEmits<{ (e: 'go', path: string): void }>();

const rows = computed(() => [
  { key: 'concept', label: '概念', badge: 'badge-concept', value: props.counts.concepts, path: '/search?q=概念' },
  { key: 'entity', label: '实体', badge: 'badge-entity', value: props.counts.entities, path: '/search?q=实体' },
  { key: 'file', label: '原始资料', badge: 'badge-note', value: props.counts.files, path: '/search?q=原始资料' },
]);

const total = computed(() => Math.max(1, props.counts.concepts + props.counts.entities + props.counts.files));
const max = computed(() => Math.max(props.counts.concepts, props.counts.entities, props.counts.files, 1));
function share(value: number) {
  return `${Math.max(0, (value / total.value) * 100)}%`;
}
function sharePct(value: number) {
  return `${Math.round((value / total.value) * 100)}%`;
}
function bar(value: number) {
  // 下限 6%：计数为 0 时也留一小截，看得出「这根条代表这一类」
  return `${Math.max(6, Math.round((value / max.value) * 100))}%`;
}
</script>

<style scoped>
.stats-card { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0; }
.stats-hero { display: flex; align-items: baseline; gap: 8px; margin-bottom: 13px; min-width: 0; }
.stats-hero .big {
  font-family: var(--font-display);
  font-size: 46px;
  font-weight: 400;
  line-height: .9;
  letter-spacing: -.04em;
  font-variant-numeric: lining-nums tabular-nums;
}
.stats-hero .unit { font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.stats-words { margin-left: auto; font-size: 10px; color: var(--text-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
.stats-meter { display: flex; height: 5px; border-radius: 999px; overflow: hidden; background: var(--card-line-soft); flex: none; }
.stats-meter > i { display: block; height: 100%; }
.stats-legend { display: flex; flex-wrap: wrap; gap: 4px 11px; margin: 8px 0 2px; font-size: 10px; color: var(--text-faint); flex: none; }
.stats-legend > span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.stats-legend i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.stats-rows { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.stat-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-height: 36px;
  padding: 0;
  font-size: 12.5px;
  text-align: left;
  border-radius: 0;
  border-top: 1px solid var(--card-line-soft);
}
.stat-row:first-child { border-top: 0; }
.stat-row:hover .stat-lb { color: var(--text); }
.stat-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.stat-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; }
.stat-lb { flex: none; width: 56px; color: var(--text-secondary); }
.stat-bar {
  flex: 1;
  min-width: 18px;
  height: 4px;
  border-radius: 999px;
  background: var(--card-line-soft);
  overflow: hidden;
}
.stat-bar i { display: block; height: 100%; border-radius: 999px; }
.stat-vl { flex: none; width: 38px; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; }
.stat-share { flex: none; width: 34px; text-align: right; font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.stats-foot {
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--card-line-soft);
  font-size: 10.5px;
  color: var(--text-faint);
}
@container (max-width: 260px) {
  .stat-share { display: none; }
  .stat-lb { width: 46px; }
  .stats-words { display: none; }
}
</style>
