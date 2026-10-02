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
      <!-- 灵感提炼状态（kind=idea_distill）优先占行尾这一格：它是文件「当前正在发生」的事，
           与提取进度互斥（同一行只有一个 76px 状态位），排在前面才不会被打断 -->
      <span
        v-if="distill"
        class="row-status distill-flag"
        :class="distill.kind"
        v-tooltip="distill.kind === 'running' ? '正在后台提炼这条灵感' : '提炼失败：原文已保存，进成品页可重新提炼'"
      >
        <AppSpinner v-if="distill.kind === 'running'" :size="10" />
        {{ distill.label }}
      </span>
      <span
        v-else-if="job"
        class="row-status ingest-progress"
        v-tooltip="job.detail || job.stage"
      >
        {{ job.stage }} {{ job.progress }}%
      </span>
      <span
        v-else-if="file.distilled"
        class="row-status ingested-flag distilled"
        v-tooltip="'已由外部 Agent 提炼入库（来源证据抽屉可复核）'"
      >已提炼</span>
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
          :href="downloadUrl"
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
import AppSpinner from './ui/AppSpinner.vue';
import { humanError } from '../lib/ingestError';

const props = defineProps<{
  file: any;
  active: boolean;
  selected?: boolean;
  selectionMode?: boolean;
  /** 该文件当前正在进行的提取任务进度，无则 null */
  job?: any;
  /**
   * 灵感提炼状态（Sidebar 按 payload.path 精确匹配后传入），无则 null。
   * 与 `job` 分开传而不是塞进 job：两者文案口径不同（提炼是「提炼中」，提取是阶段 + 百分比），
   * 且 done/pending 按 SPEC 第 6 节不在行上加徽标——判断留在纯函数里（lib/ideaDistill.ts），
   * 组件只负责画出来。
   */
  distill?: { label: string; kind: 'running' | 'failed' } | null;
}>();
const emit = defineEmits(['open', 'toggle-select', 'remove', 'context-menu']);

/** 下载走 /api/files/download：正文带图片的 md 由服务端打包成 zip（md + assets/）。
 *  文件名交给 Content-Disposition，加 download 属性会把 zip 存成 .md。 */
const downloadUrl = computed(() => `/api/files/download?path=${encodeURIComponent(props.file.path)}`);

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
  border-radius: 6px;
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
/* Win11 选中指示条 */
.page-row.active::before {
  content: '';
  position: absolute;
  top: 7px;
  bottom: 7px;
  left: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--sidebar-accent);
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
.ingested-flag.distilled { color: var(--success); }

/* 灵感提炼状态：running 带小转圈（AppSpinner 自转），failed 用告警色。
   位置/悬停让位沿用 .row-status（悬停时状态让给行内操作按钮），不另起一套定位 */
.distill-flag {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}
.distill-flag.running { color: var(--accent); }
.distill-flag.failed { color: var(--danger); }

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
  border-radius: 4px;
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
  border-radius: 4px;
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

/* 触屏（无 hover + 粗指针）：把手指点得到的控件补到 44px，并让勾选框与 ⋯ 各占一端、互不重叠。
   桌面 hover 体验不受影响——这个媒体查询在鼠标设备上不匹配。 */
@media (hover: none) and (pointer: coarse) {
  /* 行高与字号与 PageRow 同一档：列表里两种行混排，尺寸不一致会显得毛糙 */
  .page-row {
    /* 高度交给内容：标题可以折到两行（与 PageRow 同步），写死 40px 会把第二行裁掉 */
    height: auto;
    min-height: 44px;
    padding-block: 6px;
    font-size: 13.5px;
  }

  /* 目录栏文字显示不全（与 PageRow 同一条报障）：原始资料的文件名同样被单行省略号截断，
     长文件名（日期前缀 + 标题）在手机上几乎认不出来。触屏放开到两行。 */
  .page-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.35;
  }

  /* 按住反馈：触屏没有 hover，只有 :active 这一层 */
  .page-row:active {
    background: var(--press-bg);
  }

  /* 下载/删除两个 22px 图标按钮：触屏够不到，已由 ⋯ 菜单原样提供（见 onFileContextMenu） */
  .row-actions { display: none; }

  /* 勾选框：桌面靠 hover 露出，触屏没有 hover，不常显就永远看不见——
     而它是进入多选（Sidebar 的 selectionMode 由「已选中集合非空」推导）的唯一入口。
     14px 方块按不准，热区用透明伪元素铺到行首 44px；纵向吃满整行（行高已抬到 40px），
     行与行紧贴，再往外扩就会盖住上下相邻行，点勾选变成勾隔壁那条。 */
  .check {
    position: relative;
    opacity: 1;
  }
  .check::after {
    content: '';
    position: absolute;
    top: -8px;
    bottom: -8px;
    left: -6px;
    right: -24px;
  }
  /* 文件图标与标题一起让开勾选热区（只推图标即可，标题跟在图标后面） */
  .file-icon { margin-left: 24px; }

  /* 状态标签左移，给右侧 ⋯ 让位 */
  .row-status { right: 30px; max-width: 64px; }

  /* ⋯ 菜单：26px 偏小，热区补到 44×40（横向往内容侧伸，视觉图标位置不变） */
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
  .row-kebab::after {
    content: '';
    position: absolute;
    top: -7px;
    bottom: -7px;
    left: -12px;
    right: -6px;
  }
  .row-kebab:active {
    color: var(--text);
    background: var(--sidebar-active);
  }
}
</style>
