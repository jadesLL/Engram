<template>
  <div ref="wrapEl" class="export-menu-wrap" @keydown.esc="close">
    <button
      :class="triggerClass"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="busy ? '正在生成导出文件' : '导出当前页面'"
      :disabled="busy"
      v-tooltip="tooltip"
      @click="toggle"
    >
      <Icon name="download" :size="iconSize" />
      <span v-if="showLabel" class="export-label">{{ busy ? '生成中…' : label }}</span>
      <Icon v-if="showCaret" name="chevron-down" :size="12" />
    </button>

    <div v-if="open" class="export-menu" role="menu" aria-label="导出当前页面">
      <button
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="run('pdf')"
      >
        <Icon name="pdf" :size="15" />
        <span class="export-item-text">
          <b>导出为 PDF</b>
          <em>A4 分页 · 文字可选中</em>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="run('image')"
      >
        <Icon name="image" :size="15" />
        <span class="export-item-text">
          <b>导出为长图</b>
          <em>整篇 PNG · 适合分享</em>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { exportPageImage, exportPagePdf } from '../lib/pageExportCapture';
import type { PageExportMeta } from '../lib/pageExport';

/**
 * 「导出」入口（阅读顶栏 / 编辑顶栏共用）。
 *
 * 菜单只放当前页面的两种导出形态；真正的渲染与保存通道在 lib/pageExportCapture.ts。
 * 手机上菜单是普通浮层（不是底部面板）：它只有两个选项，且都带说明文字，
 * 定位在触发按钮右下角比把视线拉到屏幕底部更顺。
 */
const props = withDefaults(defineProps<{
  meta: PageExportMeta;
  triggerClass?: string;
  iconSize?: number;
  label?: string;
  showLabel?: boolean;
  showCaret?: boolean;
  tooltip?: string;
}>(), {
  triggerClass: 'btn small',
  iconSize: 15,
  label: '导出',
  showLabel: true,
  showCaret: true,
  tooltip: '导出当前页面（PDF / 长图）',
});

const wrapEl = ref<HTMLElement>();
const open = ref(false);
const busy = ref(false);

function close(): void {
  open.value = false;
}

function toggle(): void {
  if (busy.value) return;
  open.value = !open.value;
}

async function run(kind: 'pdf' | 'image'): Promise<void> {
  if (busy.value) return;
  open.value = false;
  busy.value = true;
  try {
    if (kind === 'pdf') await exportPagePdf(props.meta);
    else await exportPageImage(props.meta);
  } finally {
    busy.value = false;
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && wrapEl.value?.contains(target)) return;
  close();
}

watch(open, (value) => {
  if (value) document.addEventListener('pointerdown', onPointerDown, true);
  else document.removeEventListener('pointerdown', onPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true);
});
</script>

<style scoped>
.export-menu-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.export-label {
  white-space: nowrap;
}

.export-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  width: 208px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  box-shadow: var(--shadow);
}

.export-menu > button {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.export-menu > button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.export-menu > button:disabled {
  opacity: 0.55;
  cursor: default;
}

.export-menu > button > :deep(svg) {
  margin-top: 2px;
  flex: none;
  color: var(--text-secondary);
}

.export-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.export-item-text b {
  font-size: var(--font-sm);
  font-weight: 600;
  line-height: var(--lh-ui);
}

.export-item-text em {
  color: var(--text-faint);
  font-size: var(--fs-caption);
  font-style: normal;
  line-height: var(--lh-ui);
}
</style>
