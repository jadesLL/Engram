<template>
  <div class="settings-group" :class="{ 'is-danger': danger }">
    <div class="group-head">
      <h4 class="group-title">{{ title }}</h4>
      <span v-if="hint" class="group-hint">{{ hint }}</span>
    </div>
    <div class="group-card" :class="{ flush }">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 设置面板内的静态分组（UI 2.0：不再折叠）。
 * Win11 设置式「组标题 + 行式卡片」：标题与说明常驻，内容始终展开，
 * 避免手风琴把关键状态（危险操作、更新源）藏起来。
 * - flush：内容是无内边距的 setting-row 列表时使用（行自带边框与留白）；
 * - danger：危险操作分组，标题与边框用警示色常驻提醒；
 * - defaultOpen 为历史遗留 prop，保留签名兼容旧调用，不再生效。
 */
withDefaults(
  defineProps<{
    title: string;
    hint?: string;
    defaultOpen?: boolean;
    flush?: boolean;
    danger?: boolean;
  }>(),
  { defaultOpen: true, flush: false, danger: false },
);
</script>

<style scoped>
.settings-group {
  margin: 18px 24px;
}
.settings-group:first-of-type {
  margin-top: 20px;
}

/* 组标题：Win11 式小标签，独立于卡片之外 */
.group-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 0 2px 8px;
}
.group-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.group-hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}

.group-card {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
}
.group-card:not(.flush) {
  padding: 4px 16px 16px;
}

/* 危险分组：警示色常驻可见 */
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
</style>
