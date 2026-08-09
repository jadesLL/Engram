<template>
  <div
    class="page-row"
    :class="{ active, selected }"
    role="button"
    tabindex="0"
    @click="onClick"
    @keydown.enter.self="onClick"
    @keydown.space.self.prevent="onClick"
  >
    <span
      class="check"
      :class="{ visible: selectionMode || selected }"
      @click.stop="$emit('toggle-select', page)"
    >
      <Icon v-if="selected" name="check" :size="11" />
    </span>
    <span class="page-title" :title="page.title">{{ page.title }}</span>
    <span class="row-trailing">
      <span class="page-time">{{ timeText }}</span>
      <span class="row-actions" @click.stop>
        <button
          v-if="page.path.startsWith('Wiki/归档/')"
          type="button"
          title="取消归档"
          aria-label="取消归档"
          @click="$emit('unarchive', page)"
        >
          <Icon name="restore" :size="13" />
        </button>
        <button v-else type="button" title="归档" aria-label="归档" @click="$emit('archive', page)">
          <Icon name="archive" :size="13" />
        </button>
        <button type="button" title="删除" aria-label="删除" @click="$emit('remove', page)">
          <Icon name="trash" :size="13" />
        </button>
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  page: any;
  active: boolean;
  selected?: boolean;
  selectionMode?: boolean;
}>();
const emit = defineEmits(['open', 'archive', 'unarchive', 'remove', 'toggle-select']);

function onClick() {
  if (props.selectionMode) emit('toggle-select', props.page);
  else emit('open', props.page);
}

const timeText = computed(() => {
  const iso = props.page.updated_at;
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return '今天';
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
});
</script>

<style scoped>
.page-row {
  position: relative;
  height: 30px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  outline: none;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}
.page-row:hover { background: var(--sidebar-hover); }
.page-row:focus-visible { box-shadow: inset 0 0 0 2px var(--sidebar-accent); }
.page-row.active {
  background: var(--sidebar-selection);
  box-shadow: inset 0 0 0 1px var(--sidebar-selection-border);
  font-weight: 500;
}
.page-row.selected { background: var(--sidebar-selection-strong); }
.check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  opacity: 0;
  transition: opacity 150ms ease, background 150ms ease, border-color 150ms ease;
}
.page-row:hover .check, .page-row:focus-within .check, .check.visible { opacity: 1; }
.page-row.selected .check {
  background: var(--sidebar-accent);
  border-color: var(--sidebar-accent);
  opacity: 1;
}
.page-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-trailing {
  position: relative;
  width: 64px;
  height: 100%;
  flex-shrink: 0;
}
.page-time {
  position: absolute;
  top: 50%;
  right: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  white-space: nowrap;
  transform: translateY(-50%);
  transition: opacity 150ms ease;
}
.row-actions {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  gap: 1px;
  padding-left: 3px;
  background: transparent;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease;
}
.page-row:hover .page-time, .page-row:focus-within .page-time { opacity: 0; }
.page-row:hover .row-actions, .page-row:focus-within .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.row-actions button {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 5px;
  color: var(--text-faint);
}
.row-actions button:hover, .row-actions button:focus-visible {
  background: var(--sidebar-active);
  color: var(--text);
  outline: none;
}

@media (prefers-reduced-motion: reduce) {
  .page-row,
  .check,
  .page-time,
  .row-actions {
    transition-duration: 0.01ms;
  }
}
</style>
