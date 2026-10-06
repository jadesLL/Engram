<template>
  <!-- 常用标签：Wiki 页的标签按出现次数排（点一个去搜它） -->
  <div v-if="shown.length" class="hb-card tags-card">
    <div class="tag-cloud">
      <button
        v-for="item in shown"
        :key="item.tag"
        class="tag-chip"
        type="button"
        :title="`搜索带「${item.tag}」标签的页面`"
        @click="$emit('go', `/search?q=${encodeURIComponent(item.tag)}`)"
      >
        <span class="tag-name">{{ item.tag }}</span>
        <span class="tag-count">{{ item.count }}</span>
      </button>
    </div>
    <p class="tags-foot muted">共 {{ total }} 个标签 · 出现最多的 {{ shown.length }} 个</p>
  </div>
  <p v-else class="hb-empty">还没有标签。在页面顶部「+ 标签」里加一个，这里就会长出来。</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  tags: Array<{ tag: string; count: number }>;
  limit?: number;
}>();
defineEmits<{ (e: 'go', path: string): void }>();

const shown = computed(() => (props.tags || []).slice(0, Math.max(1, props.limit || 12)));
const total = computed(() => (props.tags || []).length);
</script>

<style scoped>
.tags-card { padding: 12px 14px 8px; }
.tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11.5px;
  transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
}
.tag-chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.tag-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tag-name { max-width: 10em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-count { font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.tags-foot { padding: 8px 0 4px; font-size: 11px; border-top: 1px solid var(--border); margin-top: 10px; }
</style>
