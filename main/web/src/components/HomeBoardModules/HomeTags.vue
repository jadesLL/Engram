<template>
  <!-- 常用标签：Wiki 页的标签按出现次数排（点一个去搜它） -->
  <div v-if="shown.length" class="hb-card tags-card">
    <div class="tag-grid">
      <button
        v-for="item in shown"
        :key="item.tag"
        class="tag-row"
        type="button"
        :title="`搜索带「${item.tag}」标签的页面`"
        @click="$emit('go', `/search?q=${encodeURIComponent(item.tag)}`)"
      >
        <span class="tag-name">{{ item.tag }}</span>
        <span class="tag-bar"><i :style="{ width: bar(item.count) }" /></span>
        <b class="num">{{ item.count }}</b>
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
  bodyHeight?: number;
}>();
defineEmits<{ (e: 'go', path: string): void }>();

const capacity = computed(() => (props.bodyHeight ? Math.max(2, Math.floor(props.bodyHeight / 33) * 2) : 99));
const shown = computed(() => (props.tags || []).slice(0, Math.min(Math.max(1, props.limit || 8), capacity.value)));
const total = computed(() => (props.tags || []).length);
const max = computed(() => Math.max(1, ...shown.value.map((item) => item.count)));
function bar(count: number) {
  return `${Math.max(6, Math.round((count / max.value) * 100))}%`;
}
</script>

<style scoped>
.tags-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.tag-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; flex: 1; min-height: 0; }
.tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 33px;
  flex: 1;
  padding: 0;
  border-radius: 0;
  border-top: 1px solid var(--card-line-soft);
  font-size: 10.5px;
  text-align: left;
  min-width: 0;
}
.tag-row:nth-child(-n+2) { border-top: 0; }
.tag-row:hover .tag-name { color: var(--accent); }
.tag-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.tag-name { flex: 0 1 auto; min-width: 0; max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.tag-bar { flex: 1; min-width: 16px; height: 3px; border-radius: 2px; background: var(--card-line-soft); overflow: hidden; }
.tag-bar i { display: block; height: 100%; border-radius: 2px; background: var(--text-faint); }
.tag-row b { flex: none; width: 18px; text-align: right; font-size: 9.5px; font-weight: 650; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
/* 2 格宽：两列每列只剩约 60px，名字可省略、轨道与计数收窄，避免画出列边界 */
@container (max-width: 260px) {
  .tag-row { gap: 4px; }
  .tag-name { max-width: 48px; }
  .tag-bar { min-width: 10px; }
}
.tags-foot {
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--card-line-soft);
  font-size: 10px;
  color: var(--text-faint);
}
</style>
