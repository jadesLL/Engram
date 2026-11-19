<template>
  <!-- 分区导航：按 Wiki 目录（概念 / 实体 / 项目 / 归档）与原始资料分类，点一下去对应的搜索结果 -->
  <div class="hb-card sections-card">
    <button
      v-for="entry in shown"
      :key="entry.key"
      class="section-row"
      type="button"
      @click="$emit('go', `/search?q=${entry.label}`)"
    >
      <span class="section-ic"><Icon :name="iconOf(entry.key)" :size="15" /></span>
      <span class="section-main">
        <span class="section-label">{{ entry.label }}</span>
        <span class="hb-row-meta">{{ entry.path }}</span>
      </span>
      <span class="hb-pill plain">{{ entry.count }}</span>
    </button>
    <p v-if="!entries.length" class="hb-empty">知识库还没有分类目录。</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import type { SectionEntry } from '../../lib/homeBoard.ts';

const props = defineProps<{ entries: SectionEntry[]; bodyHeight?: number }>();
const shown = computed(() => (props.entries || []).slice(0, props.bodyHeight ? Math.max(1, Math.floor(props.bodyHeight / 36)) : 99));
defineEmits<{ (e: 'go', path: string): void }>();

/** 目录图标：不新造图标资源，用已有的语义接近的一组 */
const ICONS: Record<string, string> = {
  concept: 'graph',
  entity: 'user',
  project: 'report',
  archive: 'archive',
  doc: 'folder',
  idea: 'lightbulb',
};
function iconOf(key: string): string {
  return ICONS[key] || 'folder';
}
</script>

<style scoped>
.sections-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.section-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  flex: 1;
  min-height: 36px;
  text-align: left;
  /* 行本身没有底色，圆角只会把 border-top 分隔线两端弯起来 */
  border-radius: 0;
}
.section-row + .section-row { border-top: 1px solid var(--card-line-soft); }
.section-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.section-ic {
  width: 28px;
  height: 28px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-secondary);
}
.section-row:hover .section-ic { background: var(--accent-soft); color: var(--accent); }
.section-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.section-label { font-size: 12.5px; font-weight: 600; color: var(--text); }
</style>
