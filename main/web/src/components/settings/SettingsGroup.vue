<template>
  <div class="settings-group" :class="{ 'is-danger': danger, open }">
    <button
      class="group-head"
      type="button"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="group-text">
        <span class="group-title">{{ title }}</span>
        <span v-if="hint" class="group-hint">{{ hint }}</span>
      </span>
      <span class="group-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
    </button>
    <div v-show="open" class="group-card" :class="{ flush }">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * 设置面板内的可折叠分组（Win11 式：组标题在卡片外，点标题行展开/收起）。
 * - flush：内容是无内边距的 setting-row 列表时使用（行自带边框与留白）；
 * - danger：危险操作分组，标题与边框用警示色常驻提醒；
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

function toggle() {
  touched.value = true;
  open.value = !open.value;
}
</script>

<style scoped>
.settings-group {
  margin: 18px 24px;
}
.settings-group:first-of-type {
  margin-top: 20px;
}

/* 组标题行：Win11 式小标签，整行可点展开/收起 */
.group-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  border-radius: 6px;
  text-align: left;
  transition: background 0.12s ease;
}
.group-head:hover {
  background: var(--bg-hover);
}
.group-head:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.group-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.group-hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}
.group-chevron {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  transition: transform 0.15s ease;
}
.settings-group.open .group-chevron {
  transform: rotate(180deg);
}

.group-card {
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
}
.group-card:not(.flush) {
  padding: 4px 16px 16px;
}

/* 危险分组：警示色常驻可见（收起时标题仍是红色） */
.settings-group.is-danger .group-title {
  color: var(--danger);
}
.settings-group.is-danger .group-card {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}

@media (max-width: 768px) {
  .settings-group {
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
