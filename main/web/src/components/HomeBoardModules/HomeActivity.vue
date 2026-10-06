<template>
  <!-- 最近改动：把最近动过的页面按时间倒着排（时间线样式） -->
  <div v-if="shown.length" class="activity">
    <button
      v-for="page in shown"
      :key="page.id"
      class="activity-item"
      type="button"
      @click="$emit('go', `/page/${page.id}`)"
    >
      <span class="activity-dot" :style="{ background: dotColor(page) }" />
      <span class="activity-main">
        <span class="activity-title">{{ page.title }}</span>
        <span class="hb-row-meta">{{ pageBadge(page).label }} · {{ sinceShort(page.updated_at) }}</span>
      </span>
    </button>
  </div>
  <p v-else class="hb-empty">还没有改动记录。</p>
</template>

<script setup lang="ts">
/**
 * 最近改动：数据源就是页面列表（服务端按 updated_at 倒序给的），与「最近更新」同一批数据，
 * 差别在观感——这条用时间线（点 + 竖线）表达「先后」，最近更新用列表表达「有哪些」。
 */
import { computed } from 'vue';
import { pageBadge, sinceShort } from '../../lib/homeBoardData.ts';

const props = defineProps<{ items: any[]; limit: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const shown = computed(() => (props.items || []).slice(0, Math.max(1, props.limit || 5)));

const COLORS: Record<string, string> = {
  // 键来自 pageBadge().cls（tb-idea / tb-concept / tb-entity / tb-note）：带连字符必须用字符串键
  'tb-idea': 'var(--badge-idea)',
  'tb-concept': 'var(--badge-concept)',
  'tb-entity': 'var(--badge-entity)',
  'tb-note': 'var(--badge-note)',
};
function dotColor(page: any): string {
  return COLORS[pageBadge(page).cls] || 'var(--accent)';
}
</script>

<style scoped>
.activity { display: flex; flex-direction: column; padding-left: 4px; }
.activity-item {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 7px 8px 7px 14px;
  border-radius: 8px;
  text-align: left;
}
.activity-item::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 8px;
  width: 2px;
  background: var(--border);
}
.activity-item:first-child::before { top: 50%; }
.activity-item:last-child::before { bottom: 50%; }
.activity-item:only-child::before { display: none; }
.activity-item:hover { background: var(--bg-secondary); }
.activity-item:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.activity-dot {
  position: absolute;
  top: 50%;
  left: 4px;
  width: 10px;
  height: 10px;
  margin-top: -5px;
  border: 2px solid var(--card-bg);
  border-radius: 50%;
  background: var(--accent);
}
.activity-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.activity-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
}
</style>
