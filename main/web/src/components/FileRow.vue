<template>
  <div
    class="page-row file-row"
    :class="{ active, selected }"
    role="button"
    tabindex="0"
    @click="onClick"
    @keydown.enter.self="onClick"
    @keydown.space.self.prevent="onClick"
    @contextmenu.prevent="onRowContextMenu"
  >
    <span
      class="check"
      :class="{ visible: selectionMode || selected, on: selected }"
      @click.stop="$emit('toggle-select', file)"
    >
      <Icon v-if="selected" name="check" :size="11" />
    </span>
    <Icon
      :name="fileIcon(file.ext)"
      :size="16"
      :stroke-width="1.7"
      :class="['file-icon', fileIconClass(file.ext)]"
    />
    <span class="page-title" v-tooltip.auto="file.name">{{ file.name }}</span>
    <span class="row-trailing">
      <span
        v-if="job"
        class="row-status ingest-progress"
        v-tooltip="job.detail || job.stage"
      >
        {{ job.stage }} {{ job.progress }}%
      </span>
      <span
        v-else-if="file.extractionStatus === 'failed'"
        class="row-status ingested-flag failed"
        v-tooltip="file.extractionError ? `提取失败：${humanError(file.extractionError)}` : '提取失败，可重试'"
      >提取失败</span>
      <span
        v-else-if="file.extractionStatus === 'partial'"
        class="row-status ingested-flag warning"
        v-tooltip="file.extractionError || '部分页面无文字层，识别交由外部 Agent'"
      >部分提取</span>
      <span
        v-else-if="file.extractionStatus === 'completed'"
        class="row-status ingested-flag extracted"
        v-tooltip="'文字已提取，可被检索；提炼由外部 Agent 处理'"
      >已提取</span>
      <span
        v-else-if="file.extractionStatus"
        class="row-status ingested-flag unsupported"
        v-tooltip="'待提取'"
      >待提取</span>
      <span class="row-actions" @click.stop>
        <a
          class="row-action-link"
          :href="rawUrl"
          :download="file.name"
          v-tooltip="`下载 ${file.name}`"
          :aria-label="`下载 ${file.name}`"
        >
          <Icon name="download" :size="13" />
        </a>
        <button type="button" v-tooltip="'删除'" aria-label="删除" @click="$emit('remove', file)">
          <Icon name="trash" :size="13" />
        </button>
      </span>
      <!-- 触屏无 hover：以 ⋯ 常显按钮唤起操作菜单 -->
      <button
        class="row-kebab"
        type="button"
        aria-label="更多操作"
        @click.stop="onKebab"
      >
        <Icon name="more" :size="15" />
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import { humanError } from '../lib/ingestError';

const props = defineProps<{
  file: any;
  active: boolean;
  selected?: boolean;
  selectionMode?: boolean;
  /** 该文件当前正在进行的提取任务进度，无则 null */
  job?: any;
}>();
const emit = defineEmits(['open', 'toggle-select', 'remove', 'context-menu']);

const rawUrl = computed(() => `/api/files/raw?path=${encodeURIComponent(props.file.path)}`);

function onClick() {
  if (props.selectionMode) emit('toggle-select', props.file);
  else emit('open', props.file);
}

function emitContextMenu(x: number, y: number) {
  emit('context-menu', {
    x,
    y,
    file: props.file,
  });
}

function onRowContextMenu(e: MouseEvent) {
  emitContextMenu(e.clientX, e.clientY);
}

function onKebab(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  emitContextMenu(rect.right, rect.bottom);
}

function fileIcon(ext: string): string {
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['docx', 'doc'].includes(ext)) return 'word';
  if (['xlsx', 'xls'].includes(ext)) return 'excel';
  if (['pptx', 'ppt'].includes(ext)) return 'ppt';
  return 'attach';
}

function fileIconClass(ext: string): string {
  return `file-icon-${fileIcon(ext)}`;
}
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
  font-size: 12.5px;
  outline: none;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}
.page-row:hover { background: var(--sidebar-hover); }
.page-row:focus-visible { box-shadow: inset 0 0 0 2px var(--sidebar-accent); }
.page-row.active {
  color: var(--text);
  background: var(--sidebar-selection);
  box-shadow: inset 0 0 0 1px var(--sidebar-selection-border);
  font-weight: 500;
}
.page-row.selected { background: var(--sidebar-selection-strong); }

.check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: #fff;
  opacity: 0;
  transition: opacity 150ms ease, background 150ms ease, border-color 150ms ease;
}
.page-row:hover .check,
.page-row:focus-within .check,
.check.visible { opacity: 1; }
.check.on {
  border-color: var(--sidebar-accent);
  background: var(--sidebar-accent);
  opacity: 1;
}

.file-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-secondary);
  opacity: 0.76;
}
.file-icon-markdown { color: var(--file-markdown); opacity: 0.94; }
.file-icon-word { color: var(--file-word); opacity: 0.94; }
.file-icon-excel { color: var(--file-excel); opacity: 0.94; }
.file-icon-ppt { color: var(--file-ppt); opacity: 0.94; }
.file-icon-pdf { color: var(--file-pdf); opacity: 0.94; }

.page-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-trailing {
  position: relative;
  width: 76px;
  height: 100%;
  flex-shrink: 0;
}
.row-status {
  position: absolute;
  top: 50%;
  right: 0;
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateY(-50%);
  transition: opacity 150ms ease;
}
.page-row:hover .row-status,
.page-row:focus-within .row-status { opacity: 0; }

.ingested-flag {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--success);
  font-size: 10px;
}
.ingested-flag::before {
  content: '';
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: 50%;
  background: currentColor;
}
.ingested-flag.failed { color: var(--danger); }
.ingested-flag.unsupported { color: var(--text-faint); }
.ingested-flag.warning { color: var(--warning); }
.ingested-flag.extracted { color: var(--accent); }

.ingest-progress {
  padding: 1px 5px;
  border-radius: 6px;
  color: var(--sidebar-accent);
  background: var(--sidebar-selection);
  font-size: 10px;
  line-height: 17px;
  font-variant-numeric: tabular-nums;
}

.row-actions {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  padding-left: 3px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  background: transparent;
  transition: opacity 150ms ease;
}
.page-row:hover .row-actions,
.page-row:focus-within .row-actions {
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
.row-actions button:hover,
.row-actions button:focus-visible {
  color: var(--text);
  background: var(--sidebar-active);
  outline: none;
}
.row-action-link {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-faint);
  text-decoration: none;
}
.row-action-link:hover,
.row-action-link:focus-visible {
  color: var(--text);
  background: var(--sidebar-active);
  outline: none;
}

/* 触屏：hover 行内按钮不可用，改用 ⋯ 菜单；状态标签左移避免被遮 */
.row-kebab {
  display: none;
}

@media (hover: none) and (pointer: coarse) {
  .row-actions { display: none; }
  .row-status { right: 28px; max-width: 48px; }
  .row-kebab {
    position: absolute;
    top: 50%;
    right: 0;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 6px;
    color: var(--text-faint);
    transform: translateY(-50%);
  }
  .row-kebab:active {
    color: var(--text);
    background: var(--sidebar-active);
  }
}
</style>
