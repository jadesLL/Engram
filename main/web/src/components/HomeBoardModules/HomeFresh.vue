<template>
  <!-- 本周新增：最近 7 天**创建**的页面（灵感碎片也算），点开就走 -->
  <div v-if="shown.length" class="fresh-list">
    <button
      v-for="page in shown"
      :key="page.id"
      class="hb-row fresh-row"
      type="button"
      @click="$emit('go', `/page/${page.id}`)"
    >
      <span class="hb-badge" :class="pageBadge(page).cls">{{ pageBadge(page).label }}</span>
      <span class="hb-row-main">
        <span class="hb-row-title">{{ page.title }}</span>
        <span class="hb-row-meta">{{ pageBadge(page).meta }}</span>
      </span>
      <span class="hb-row-time">{{ sinceShort(page.created_at) }}</span>
    </button>
  </div>
  <p v-else class="hb-empty">最近 7 天没有新页面。写一篇，或先记一条灵感。</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { pageBadge, sinceShort } from '../../lib/homeBoardData.ts';

const props = defineProps<{ items: any[]; limit: number; bodyHeight?: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const capacity = computed(() => (props.bodyHeight ? Math.max(1, Math.floor(props.bodyHeight / 36)) : 99));
const shown = computed(() => (props.items || []).slice(0, Math.min(Math.max(1, props.limit || 5), capacity.value)));
</script>

<style scoped>
.fresh-list { display: flex; flex-direction: column; gap: 0; flex: 1; min-height: 0; }
.fresh-row { padding: 0; flex: 1; min-height: 36px; }
</style>
