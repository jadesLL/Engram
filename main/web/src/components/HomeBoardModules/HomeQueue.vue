<template>
  <!-- 等待提炼：刚落盘、还没被 Agent 提炼进 Wiki 的原始资料 / 灵感 -->
  <div v-if="shown.length" class="queue-list">
    <button
      v-for="page in shown"
      :key="page.id"
      class="hb-row queue-row"
      type="button"
      @click="$emit('go', `/page/${page.id}`)"
    >
      <span class="queue-icon"><Icon :name="isIdea(page) ? 'lightbulb' : 'file'" :size="14" /></span>
      <span class="hb-row-main">
        <span class="hb-row-title">{{ page.title }}</span>
        <span class="hb-row-meta">{{ isIdea(page) ? '灵感碎片 · 已落盘' : '原始资料 · 待提炼' }}</span>
      </span>
      <span class="hb-pill" :class="{ plain: !newest(page) }">{{ newest(page) ? '排队' : '等待' }}</span>
    </button>
  </div>
  <p v-else class="hb-empty">没有等待提炼的资料。记一条灵感，或把文件拖进收集箱。</p>
</template>

<script setup lang="ts">
/**
 * 「等待提炼」近似口径：原始资料/ 下最近改动、且不在「对话/」里的几篇。
 *
 * 真·提炼状态在 Agent 侧（提炼完成后会写回 Wiki 并给来源打「已提炼」标记），
 * 首页这里不引入新的状态源：按「刚刚落盘的原始资料」展示，落盘后本来就要等提炼。
 * 若要精确状态，接口侧需要新增一个「未提炼来源」的只读端点（这次不做）。
 */
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { pendingDistillOf } from '../../lib/homeBoard.ts';

const props = defineProps<{ pages: any[]; limit: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const shown = computed(() => pendingDistillOf(props.pages, Math.max(1, props.limit || 4)));
function isIdea(page: any): boolean {
  return String(page?.path || '').startsWith('原始资料/灵感碎片/');
}
/** 最近一条打「排队」，其余打「等待」：避免每行都是同一个胶囊 */
function newest(page: any): boolean {
  return shown.value[0]?.id === page?.id;
}
</script>

<style scoped>
.queue-list { display: flex; flex-direction: column; gap: 2px; }
.queue-row { padding: 9px 12px; gap: 10px; }
.queue-icon {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-secondary);
}
</style>
