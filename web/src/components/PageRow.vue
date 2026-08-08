<template>
  <div class="page-row" :class="{ active, selected }" @click="onClick">
    <span
      class="check"
      :class="{ visible: selectionMode || selected }"
      @click.stop="$emit('toggle-select', page)"
    >
      <Icon v-if="selected" name="check" :size="11" />
    </span>
    <span class="page-title" :title="page.title">{{ page.title }}</span>
    <span class="page-time">{{ timeText }}</span>
    <span class="row-actions" @click.stop>
      <button
        v-if="page.path.startsWith('Wiki/归档/')"
        title="取消归档（恢复到对应分区）"
        @click="$emit('unarchive', page)"
      >
        <Icon name="restore" :size="13" />
      </button>
      <button v-else title="归档" @click="$emit('archive', page)">
        <Icon name="archive" :size="13" />
      </button>
      <button title="删除" @click="$emit('remove', page)"><Icon name="trash" :size="13" /></button>
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
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13.5px;
  position: relative;
}
.page-row:hover { background: var(--bg-hover); }
.page-row.active { background: var(--bg-active); font-weight: 500; }
.page-row.selected { background: var(--accent-soft); }
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
  transition: opacity 0.1s;
}
.page-row:hover .check, .check.visible { opacity: 1; }
.page-row.selected .check {
  background: var(--accent);
  border-color: var(--accent);
  opacity: 1;
}
.page-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page-time { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
.page-row:hover .page-time { display: none; }
.row-actions { display: none; gap: 2px; flex-shrink: 0; }
.page-row:hover .row-actions { display: flex; }
.row-actions button {
  display: flex;
  padding: 2px 3px;
  border-radius: 4px;
  color: var(--text-faint);
}
.row-actions button:hover { background: var(--bg-active); color: var(--text); }
</style>
