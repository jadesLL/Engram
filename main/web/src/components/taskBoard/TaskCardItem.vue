<template>
  <!-- 一张看板任务卡：正文 + 责任人/时间/客户/端组胶囊 + 依据入口；逾期时右侧常显「完成」 -->
  <article class="task-card" :class="{ over: overdue }">
    <div class="card-head">
      <p class="card-text" :title="card.text">{{ card.text }}</p>
      <button
        v-if="overdue"
        class="complete-task"
        type="button"
        :disabled="completing"
        :aria-label="`标记已完成：${card.text}`"
        v-tooltip="'手动完成，并把点击日期写入 Markdown 文档'"
        @click="$emit('complete', card)"
      >
        <AppSpinner v-if="completing" :size="13" />
        <Icon v-else name="check" :size="13" />
        {{ completing ? '保存中…' : '完成' }}
      </button>
    </div>
    <div class="meta">
      <span v-if="card.owner" class="chip owner" v-tooltip="'责任人'">{{ card.owner }}</span>
      <span
        v-if="card.when || card.repeat"
        class="chip when"
        :title="card.repeat ? `周期：${card.repeat}` : card.when"
      >{{ card.when || card.repeat }}</span>
      <span class="chip customer" :title="card.customer ? '客户' : '没有客户，按端组归到内部工作'">{{ customer }}</span>
      <span v-if="card.customer && card.team" class="chip team" v-tooltip="'端组'">{{ card.team }}</span>
      <span v-if="overdue" class="chip overdue-days">逾期 {{ overdueDays }} 天</span>
    </div>
    <button
      v-if="target.kind !== 'none'"
      class="source"
      type="button"
      v-tooltip="'跳到依据的原文'"
      @click="$emit('open', card)"
    >
      <Icon name="link" :size="12" />{{ target.label }}
    </button>
    <span v-else-if="card.source" class="source plain">{{ card.source }}</span>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { cardCustomer, taskCardTarget, type TaskCard } from '../../lib/taskBoard';

const props = defineProps<{
  card: TaskCard;
  overdue: boolean;
  overdueDays: number;
  completing: boolean;
}>();
defineEmits<{ (e: 'complete', card: TaskCard): void; (e: 'open', card: TaskCard): void }>();

const customer = computed(() => cardCustomer(props.card));
const target = computed(() => taskCardTarget(props.card));
</script>

<style scoped>
.task-card {
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
  transition: box-shadow 150ms ease, transform 150ms ease, border-color 150ms ease;
}
.task-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-card); }
.task-card.over { border-color: rgba(196, 43, 28, 0.3); }
.task-card.over .card-text { color: var(--danger); }
.card-head { display: flex; align-items: flex-start; gap: 12px; }
.card-head .card-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.card-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  max-width: 100%;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip.owner { background: var(--accent-soft); color: var(--accent); }
.chip.when { background: var(--badge-idea-soft); color: var(--badge-idea); }
.chip.customer { background: var(--badge-entity-soft); color: var(--badge-entity); }
.chip.team { background: var(--badge-note-soft); color: var(--badge-note); }
.chip.overdue-days { background: var(--danger-soft); color: var(--danger); font-weight: 600; }
.complete-task {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 5px;
  padding: 5px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
}
.complete-task:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.complete-task:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.complete-task:disabled { opacity: 0.65; cursor: wait; }
.source {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin-top: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source:hover { color: var(--accent); text-decoration: underline; }
.source.plain { cursor: default; }
.source.plain:hover { color: var(--text-faint); text-decoration: none; }
@media (hover: none) and (pointer: coarse) {
  .complete-task { min-height: 44px; min-width: 72px; }
}
@media (max-width: 640px) {
  .card-head { flex-wrap: wrap; gap: 6px; }
  .card-head .card-text { flex-basis: 100%; }
  .complete-task { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .task-card { transition: none; }
  .task-card:hover { transform: none; }
}
</style>
