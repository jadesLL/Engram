<template>
  <!-- 最近更新：彩色类型徽章 + 标题 + 目录段 + 相对时间（接口已按更新时间倒序） -->
  <div v-if="shown.length" class="recent-list">
    <button
      v-for="page in shown"
      :key="page.id"
      class="hb-row recent-row"
      type="button"
      @click="$emit('go', `/page/${page.id}`)"
    >
      <span class="hb-badge" :class="pageBadge(page).cls">{{ pageBadge(page).label }}</span>
      <span class="hb-row-main">
        <span class="hb-row-title">{{ page.title }}</span>
        <span class="hb-row-meta">{{ pageBadge(page).meta }}</span>
      </span>
      <span class="hb-row-time">{{ fromNow(page.updated_at) }}</span>
    </button>
  </div>
  <p v-else class="hb-empty">还没有页面。写第一篇，或先记一条灵感。</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { fromNow, pageBadge } from '../../lib/homeBoardData.ts';

const props = defineProps<{ items: any[]; limit: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const shown = computed(() => (props.items || []).slice(0, Math.max(1, props.limit || 6)));
</script>

<style scoped>
.recent-list { display: flex; flex-direction: column; gap: 2px; }
.recent-row { padding: 9px 12px; }
</style>
