<template>
  <div
    class="page-row"
    :class="{ active, selected }"
    role="button"
    tabindex="0"
    :draggable="!touch"
    @click="onClick"
    @keydown.enter.self="onClick"
    @keydown.space.self.prevent="onClick"
    @dragstart="onDragStart"
    @dragend="$emit('drag-end')"
    @contextmenu.prevent="onContextMenu"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endPress"
    @pointercancel="endPress"
    @pointerleave="endPress"
  >
    <span
      class="check"
      :class="{ visible: selectionMode || selected }"
      @pointerdown.stop
      @click.stop="$emit('toggle-select', page)"
    >
      <Icon v-if="selected" name="check" :size="11" />
    </span>
    <span class="page-title" v-tooltip.auto="page.title">{{ page.title }}</span>
    <span class="row-trailing">
      <span class="page-time">{{ timeText }}</span>
      <span class="row-actions" @click.stop>
        <a
          class="row-action-link"
          :href="downloadUrl"
          v-tooltip="`下载 ${page.title}`"
          :aria-label="`下载 ${page.title}`"
        >
          <Icon name="download" :size="13" />
        </a>
        <button
          v-if="page.path.startsWith('Wiki/归档/')"
          type="button"
          v-tooltip="'取消归档'"
          aria-label="取消归档"
          @click="$emit('unarchive', page)"
        >
          <Icon name="restore" :size="13" />
        </button>
        <button v-else type="button" v-tooltip="'归档'" aria-label="归档" @click="$emit('archive', page)">
          <Icon name="archive" :size="13" />
        </button>
        <button type="button" v-tooltip="'删除'" aria-label="删除" @click="$emit('remove', page)">
          <Icon name="trash" :size="13" />
        </button>
      </span>
      <!-- 触屏无 hover：以 ⋯ 常显按钮唤起与右键相同的操作菜单 -->
      <button
        class="row-kebab"
        type="button"
        aria-label="更多操作"
        @pointerdown.stop
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
import { relativeTimeText } from '../lib/pageTime';
import { isTouchPointer, useTouchPointer } from '../lib/pointer';
import { createLongPress } from '../lib/longPress';
import { haptic } from '../lib/haptics';

const props = defineProps<{
  page: any;
  active: boolean;
  selected?: boolean;
  selectionMode?: boolean;
}>();
const emit = defineEmits([
  'open', 'archive', 'unarchive', 'remove', 'toggle-select',
  'drag-start', 'drag-end', 'context-menu', 'long-press',
]);

/**
 * 触屏（无 hover + 粗指针）：拖拽、右键都不可用，改用「长按 500ms 进多选 + 行尾 ⋯ 菜单」。
 * 桌面端完全不受影响（指针是 mouse 时 drag/右键照旧）。
 */
const touch = useTouchPointer();

/** 下载走 /api/files/download：页面正文引用的图片一并打包成 zip（页面 + assets/）。
 *  文件名交给 Content-Disposition，加 download 属性会把 zip 存成 .md。 */
const downloadUrl = computed(() => `/api/files/download?path=${encodeURIComponent(props.page.path)}`);

const longPress = createLongPress({
  onLongPress: () => {
    haptic('tap');
    emit('long-press', props.page);
  },
});

function onPointerDown(e: PointerEvent) {
  longPress.start(e);
}

function onPointerMove(e: PointerEvent) {
  longPress.move(e);
}

function endPress() {
  longPress.end();
}

function onClick() {
  // 长按松手后的那一次 click 要吞掉：否则刚进选择态又被自己取消
  if (longPress.consumeClick()) return;
  if (props.selectionMode) emit('toggle-select', props.page);
  else emit('open', props.page);
}

function onDragStart(e: DragEvent) {
  if (touch.value) {
    e.preventDefault();
    return;
  }
  if (!e.dataTransfer) return;
  e.dataTransfer.setData('text/plain', props.page.id);
  e.dataTransfer.effectAllowed = 'move';
  emit('drag-start', props.page);
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  // 触屏：长按是多选，菜单走行尾 ⋯（WebView 的长按也会派发 contextmenu，不能在这里再开一层）
  if (isTouchPointer()) return;
  emit('context-menu', { x: e.clientX, y: e.clientY, page: props.page });
}

function onKebab(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  emit('context-menu', { x: rect.right, y: rect.bottom, page: props.page });
}

/** 行尾「多久以前」：口径只有 lib/pageTime 一处（满窗目录行用的是同一个函数） */
const timeText = computed(() => relativeTimeText(props.page.updated_at));
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
  /* 触屏上纵向滑动列表不要被行内手势接管；长按判定自己处理横向漂移。
     同时关掉 WebView 原生文本选择：否则长按行标题会与 App 的长按多选同时触发，
     松手后残留两个系统选择手柄（真机验收观察项）。 */
  touch-action: pan-y;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
}
.page-row:hover { background: var(--sidebar-hover); }
.page-row:focus-visible { box-shadow: inset 0 0 0 2px var(--sidebar-accent); }
.page-row.active {
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
.page-row.long-pressing { background: var(--press-bg); }
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
  font-variant-numeric: tabular-nums;
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
  border-radius: 4px;
  color: var(--text-faint);
}
.row-actions button:hover, .row-actions button:focus-visible {
  background: var(--sidebar-active);
  color: var(--text);
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
.row-action-link:hover, .row-action-link:focus-visible {
  color: var(--text);
  background: var(--sidebar-active);
  outline: none;
}

/* 触屏：hover 行内按钮不可用，改用 ⋯ 菜单；时间标签左移避免被遮 */
.row-kebab {
  display: none;
}

/* 触屏（无 hover + 粗指针）：把手指点得到的控件补到 44px，并让勾选框与 ⋯ 各占一端、互不重叠。
   桌面 hover 体验不受影响——这个媒体查询在鼠标设备上根本不匹配。 */
@media (hover: none) and (pointer: coarse) {
  /* 行高 30px → 40px、字号 12.5px → 13.5px：手机上原来又扁又小，点按容易点错、标题也读不清 */
  .page-row {
    /* 高度改由内容撑：标题允许折到两行（见 .page-title 的 line-clamp），
       写死 40px 会把第二行裁掉 */
    height: auto;
    min-height: 44px;
    padding-block: 6px;
    font-size: 13.5px;
  }

  /* 按住反馈：触屏没有 hover，只有 :active 这一层（底色跟着行的 6px 圆角，不会出现方角） */
  .page-row:active {
    background: var(--press-bg);
  }

  /* 下载/归档/删除三个 22px 图标按钮：触屏上够不到，已由 ⋯ 菜单原样提供（见 onContextMenu） */
  .row-actions { display: none; }

  /* 每行「几分钟前」的小字在手机上纯属噪声：标题被挤成省略号，信息量却几乎为零。
     触屏不显示，把 34px 让给标题；桌面 hover 照旧。 */
  .page-time { display: none; }

  /* 行尾只剩一颗 ⋯：trailing 占位从 64px 收到 30px */
  .row-trailing { width: 30px; }

  /*
   * 多选勾选框只在「已经进入多选」时出现（长按任意行进入，或行尾 ⋯ → 多选）。
   * 旧版在触屏上常显方框：整列 40 行都是空框，既像文件管理器又白吃 44px 行首宽度，
   * 标题被挤到两行还不够。桌面端仍保持 hover 才露出。
   */
  .check { display: none; }
  .check.visible {
    display: flex;
    border-color: var(--border);
    opacity: 1;
  }

  /* 目录栏文字显示不全（用户报障）：单行省略号把 20 个字的页面名截成
     「华北区域经销商年度对账与返…」，一排页面看着一模一样，根本选不出要开哪一篇。
     触屏上放开到两行：常见的中文长标题能整句读完；真超长再折两行后省略。
     行本身是 flex 容器（勾选框 / 标题 / ⋯ 三段），标题用 -webkit-box 才能在行内多行截断。 */
  .page-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.35;
  }

  /* ⋯ 菜单：26px 同样偏小，热区补到 44×40（横向往标题侧伸，视觉图标位置不变） */
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

@media (prefers-reduced-motion: reduce) {
  .page-row,
  .check,
  .page-time,
  .row-actions {
    transition-duration: 0.01ms;
  }
}
</style>
