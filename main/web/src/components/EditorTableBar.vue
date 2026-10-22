<template>
  <div
    class="table-bar"
    role="toolbar"
    aria-label="表格操作"
    :style="{ top: `${top}px`, left: `${left}px` }"
    @mousedown.prevent
    @contextmenu.prevent
  >
    <span class="tb-group">
      <span class="tb-label">行</span>
      <button
        v-for="item in rowActions"
        :key="item.action"
        type="button"
        class="tb-btn"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        :aria-label="item.label"
        v-tooltip="item.disabled ? item.hint : item.label"
        @click="emit('action', item.action)"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="path in item.paths" :key="path" :d="path" />
        </svg>
      </button>
    </span>
    <span class="tb-sep" aria-hidden="true"></span>
    <span class="tb-group">
      <span class="tb-label">列</span>
      <button
        v-for="item in columnActions"
        :key="item.action"
        type="button"
        class="tb-btn"
        :class="{ danger: item.danger }"
        :aria-label="item.label"
        v-tooltip="item.label"
        @click="emit('action', item.action)"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="path in item.paths" :key="path" :d="path" />
        </svg>
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TableEditAction } from '../lib/markdownTable';

const props = defineProps<{
  /** 相对 .editor-wrap 的定位（像素） */
  top: number;
  left: number;
  /** 视觉行号：0 是表头行 */
  row: number;
}>();

const emit = defineEmits<{ (e: 'action', action: TableEditAction): void }>();

interface ActionItem {
  action: TableEditAction;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  paths: string[];
}

/* 行/列两组各三个按钮：插入方向用「箭头 + ═ 线」表达（线代表新行/新列），
 * 删除统一用垃圾桶（靠「行 / 列」分组标签区分删的是哪一种）。
 * 表头行删不掉（Markdown 表格必须有表头），按钮置灰并说明原因。 */
const TRASH = ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'];
const rowActions = computed<ActionItem[]>(() => [
  {
    action: 'row-above',
    label: '在上方插入行',
    paths: ['M4 4h16', 'M12 20v-8', 'm8 12 4-4 4 4'],
  },
  {
    action: 'row-below',
    label: '在下方插入行',
    paths: ['M4 20h16', 'M12 4v8', 'm8 8 4 4 4-4'],
  },
  {
    action: 'row-remove',
    label: '删除当前行',
    hint: '表头行不能删除',
    disabled: props.row <= 0,
    danger: true,
    paths: TRASH,
  },
]);

const columnActions: ActionItem[] = [
  {
    action: 'col-left',
    label: '在左侧插入列',
    paths: ['M4 4v16', 'M20 12h-8', 'm16 8-4 4 4 4'],
  },
  {
    action: 'col-right',
    label: '在右侧插入列',
    paths: ['M20 4v16', 'M4 12h8', 'm8 8 4 4-4 4'],
  },
  {
    action: 'col-remove',
    label: '删除当前列',
    danger: true,
    paths: TRASH,
  },
];
</script>

<style scoped>
.table-bar {
  position: absolute;
  z-index: var(--z-popup);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 5px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-raised);
  user-select: none;
  animation: table-bar-in 120ms ease-out;
}
.tb-group { display: inline-flex; align-items: center; gap: 1px; }
.tb-label {
  padding: 0 3px 0 1px;
  font-size: 10.5px;
  line-height: 1;
  color: var(--text-tertiary, var(--text-secondary));
}
.tb-sep {
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: var(--border);
}
.tb-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.tb-btn:hover { background: var(--bg-hover); color: var(--text); }
.tb-btn.danger:hover { color: var(--danger, #d94f3d); }
.tb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.tb-btn:disabled:hover { background: transparent; color: var(--text-secondary); }
.tb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@keyframes table-bar-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}
/* 触屏：按钮撑到 34px，手指点得准（面板仍在表格上方一行内可见） */
@media (hover: none) and (pointer: coarse) {
  .tb-btn { width: 34px; height: 34px; }
  .tb-sep { height: 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .table-bar { animation: none; }
}
</style>
