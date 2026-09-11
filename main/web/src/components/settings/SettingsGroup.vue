<template>
  <details
    class="settings-group-card"
    :class="{ 'is-danger': danger }"
    :open="open"
    @toggle="onToggle"
  >
    <summary class="group-summary" @click="onSummaryClick">
      <span class="group-chevron" aria-hidden="true" />
      <span class="group-text">
        <span class="group-title">{{ title }}</span>
        <span v-if="hint" class="group-hint">{{ hint }}</span>
      </span>
    </summary>
    <div class="group-body" :class="{ flush }">
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * 设置面板内的可折叠分组卡片（基于原生 details/summary，键盘与读屏可用）。
 * - flush：内容是无内边距的 setting-row 列表时使用（行自带边框与留白）；
 * - danger：危险操作分组，标题与边框用警示色；
 * - defaultOpen 只决定「用户动手之前」的初始开合：父级异步加载状态（如更新源是否已配置）
 *   到达前允许跟随刷新，一旦用户手动开合过就以用户选择为准。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    hint?: string;
    defaultOpen?: boolean;
    flush?: boolean;
    danger?: boolean;
  }>(),
  { defaultOpen: false, flush: false, danger: false },
);

const open = ref(props.defaultOpen);
const touched = ref(false);

watch(
  () => props.defaultOpen,
  (value) => {
    if (!touched.value) open.value = value;
  },
);

function onToggle(event: Event) {
  open.value = (event.target as HTMLDetailsElement).open;
}

function onSummaryClick() {
  touched.value = true;
}
</script>

<style scoped>
.settings-group-card {
  margin: 16px 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card-bg);
}
.group-summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 13px 16px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.group-summary::-webkit-details-marker {
  display: none;
}
.group-chevron {
  flex: 0 0 auto;
  /* 与首行文字垂直居中对齐：hint 换行时箭头不跟着下沉 */
  margin-top: 6px;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--text-faint);
  transition: transform 0.15s ease;
}
.settings-group-card[open] .group-chevron {
  transform: rotate(90deg);
}
.group-summary:hover {
  background: var(--bg-hover);
}
.group-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.group-text {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
}
.group-hint {
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.group-body {
  padding: 4px 16px 16px;
  border-top: 1px solid var(--border);
}
.group-body.flush {
  padding: 0;
}

/* 危险分组：收起时警示色标题仍可见，起到常驻提醒作用 */
.settings-group-card.is-danger {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}
.settings-group-card.is-danger .group-title {
  color: var(--danger);
}
.settings-group-card.is-danger > .group-summary {
  background: color-mix(in srgb, var(--danger) 5%, var(--bg));
}

@media (max-width: 768px) {
  .settings-group-card {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .group-chevron {
    transition: none;
  }
}
</style>
