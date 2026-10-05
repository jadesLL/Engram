<template>
  <!-- 知识库概览：概念 / 实体 / 原始资料三类计数，条按最大值归一 -->
  <div class="hb-card stats-card">
    <button v-for="row in rows" :key="row.key" class="stat-row" type="button" @click="$emit('go', row.path)">
      <span class="stat-ic" :style="{ background: `var(--${row.badge}-soft)`, color: `var(--${row.badge})` }">
        <Icon :name="row.icon" :size="14" />
      </span>
      <span class="stat-lb">{{ row.label }}</span>
      <span class="stat-bar"><i :style="{ width: bar(row.value), background: `var(--${row.badge})` }" /></span>
      <span class="stat-vl">{{ row.value }}</span>
    </button>
    <p class="stats-foot muted">共 {{ pages }} 个页面 · 资料份数 {{ counts.files }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';

const props = defineProps<{
  pages: number;
  counts: { concepts: number; entities: number; files: number };
}>();
defineEmits<{ (e: 'go', path: string): void }>();

const rows = computed(() => [
  { key: 'concept', label: '概念', icon: 'graph', badge: 'badge-concept', value: props.counts.concepts, path: '/search?q=概念' },
  { key: 'entity', label: '实体', icon: 'user', badge: 'badge-entity', value: props.counts.entities, path: '/search?q=实体' },
  { key: 'file', label: '原始资料', icon: 'archive', badge: 'badge-idea', value: props.counts.files, path: '/search?q=原始资料' },
]);

const max = computed(() => Math.max(props.counts.concepts, props.counts.entities, props.counts.files, 1));
function bar(value: number) {
  // 下限 6%：计数为 0 时也留一小截，看得出「这根条代表这一类」
  return `${Math.max(6, Math.round((value / max.value) * 100))}%`;
}
</script>

<style scoped>
.stats-card { padding: 8px 14px 6px; }
.stat-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  font-size: 12.5px;
  text-align: left;
  border-radius: 8px;
}
.stat-row + .stat-row { border-top: 1px solid var(--border); }
.stat-row:hover .stat-lb { color: var(--text); }
.stat-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.stat-ic {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}
.stat-lb { color: var(--text-secondary); }
.stat-bar {
  width: 56px;
  flex: none;
  height: 4px;
  margin-left: auto;
  border-radius: 2px;
  background: var(--bg-tertiary);
  overflow: hidden;
}
.stat-bar i { display: block; height: 100%; border-radius: 2px; }
.stat-vl { flex: none; min-width: 22px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.stats-foot { padding: 8px 0 4px; font-size: 11px; border-top: 1px solid var(--border); }
</style>
