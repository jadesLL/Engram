<template>
  <!-- 近期灵感：只列「原始资料/灵感碎片」里最新记下的几条；空态给「记一条」入口 -->
  <div v-if="shown.length" class="notes-list">
    <button
      v-for="page in shown"
      :key="page.id"
      class="hb-row notes-row"
      type="button"
      @click="$emit('go', `/page/${page.id}`)"
    >
      <span class="notes-bulb" aria-hidden="true"><Icon name="lightbulb" :size="14" /></span>
      <span class="hb-row-main">
        <span class="hb-row-title">{{ page.title }}</span>
        <span class="hb-row-meta">灵感碎片</span>
      </span>
      <span class="hb-row-time">{{ fromNow(page.updated_at) }}</span>
    </button>
  </div>
  <div v-else class="notes-empty">
    <p class="hb-empty">还没有灵感碎片。</p>
    <button class="btn small" type="button" @click="$emit('capture')">
      <Icon name="plus" :size="13" /> 记一条
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { fromNow } from '../../lib/homeBoardData.ts';

const props = defineProps<{ items: any[]; limit: number; bodyHeight?: number }>();
defineEmits<{ (e: 'go', path: string): void; (e: 'capture'): void }>();

const capacity = computed(() => (props.bodyHeight ? Math.max(1, Math.floor(props.bodyHeight / 36)) : 99));
const shown = computed(() => (props.items || []).slice(0, Math.min(Math.max(1, props.limit || 4), capacity.value)));
</script>

<style scoped>
.notes-list { display: flex; flex-direction: column; gap: 0; flex: 1; min-height: 0; }
.notes-row { gap: 10px; padding: 0; flex: 1; min-height: 36px; }
.notes-bulb {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--badge-idea-soft);
  color: var(--badge-idea);
}
.notes-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding-bottom: 8px; }
</style>
