<template>
  <div
    ref="rootEl"
    class="back-trail"
    @mouseenter="onPointerEnter"
    @mouseleave="closeMenuSoon"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown.esc="closeMenu"
  >
    <!-- 触发器由调用方给出（编辑顶部条 / 沉浸阅读工具栏样式不同），这里只负责悬停与面板 -->
    <slot :open="open" />

    <div v-if="open" class="back-trail-menu" role="menu" aria-label="返回轨迹">
      <p class="back-trail-head">返回轨迹 · 共 {{ items.length }} 层</p>
      <button
        v-for="item in items"
        :key="item.id"
        class="back-trail-item"
        type="button"
        role="menuitem"
        v-tooltip.auto.right="item.title || '未命名页面'"
        @click="select(item.id)"
      >
        <Icon :name="item.depth === 1 ? 'undo' : 'file'" :size="14" />
        <span class="back-trail-title">{{ item.title || '未命名页面' }}</span>
        <span class="back-trail-depth">{{ item.label }}</span>
      </button>
      <p class="back-trail-foot">点任意一层直接跳回 · Alt+← 逐层返回</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 「返回上一页」按钮的悬停下拉：列出返回轨迹里所有能回去的页面（文件）名称。
 *
 * - 触发区与面板同属一个 hover 容器，鼠标从按钮移进面板不会中途收起；
 * - 触屏（hover: none）没有悬停语义，不弹面板，点击触发器仍是原来的逐层返回；
 * - 键盘聚焦（:focus-visible）同样弹面板，Esc / 焦点移开 / 点别处 / 滚动都收起；
 * - 面板自带文案，触发器因此不再挂 tooltip，避免气泡与面板同时出现。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { trailMenuItems, type PageTrailEntry } from '../lib/pageTrail';

const props = defineProps<{
  /** 返回轨迹（栈底 → 栈顶），栈顶即「上一页」 */
  trail: PageTrailEntry[];
}>();

const emit = defineEmits<{ (event: 'select', id: string): void }>();

/** 鼠标从按钮斜着移进面板的宽限时间 */
const CLOSE_DELAY_MS = 140;

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const items = computed(() => trailMenuItems(props.trail));
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 实时判断以覆盖运行中的 hover 能力变化（折叠屏形态切换 / DevTools 模拟） */
function hoverable() {
  return window.matchMedia('(hover: hover)').matches;
}

function onPointerEnter() {
  if (!hoverable()) return;
  openMenu();
}

function onFocusIn(event: FocusEvent) {
  // 鼠标/触摸点击也会聚焦按钮：只有键盘聚焦才弹面板，免得点一下就闪出列表
  if (!(event.target as HTMLElement | null)?.matches?.(':focus-visible')) return;
  openMenu();
}

function openMenu() {
  clearCloseTimer();
  if (!props.trail.length) return;
  open.value = true;
}

function closeMenuSoon() {
  clearCloseTimer();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    open.value = false;
  }, CLOSE_DELAY_MS);
}

function closeMenu() {
  clearCloseTimer();
  open.value = false;
}

function select(id: string) {
  closeMenu();
  emit('select', id);
}

function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/* ===== 收起路径：鼠标移开、Esc、焦点移走、点别处、滚动 ===== */

function onFocusOut(event: FocusEvent) {
  // 焦点在触发区与面板之间移动不算离开；移到别处（含焦点丢失）就收起
  const next = event.relatedTarget as Node | null;
  if (next && rootEl.value?.contains(next)) return;
  closeMenu();
}

function onDocPointerDown(event: PointerEvent) {
  const target = event.target as Node | null;
  if (target && rootEl.value?.contains(target)) return;
  closeMenu();
}

function onDocKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMenu();
}

/** 面板是 abspos 的，滚一下锚点就跑了；监听只在展开期间挂着 */
watch(open, (value) => {
  if (value) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeydown);
    window.removeEventListener('scroll', closeMenu, true);
    window.removeEventListener('resize', closeMenu);
  }
});

onBeforeUnmount(() => {
  clearCloseTimer();
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeydown);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
});
</script>

<style scoped>
.back-trail {
  position: relative;
  display: inline-flex;
  flex: none;
}
.back-trail-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: var(--z-menu);
  width: max-content;
  min-width: 200px;
  max-width: 320px;
  max-height: 300px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  box-shadow: var(--shadow);
  text-align: left;
}
.back-trail-head,
.back-trail-foot {
  margin: 0;
  padding: 5px 8px;
  color: var(--text-faint);
  font-size: 11.5px;
  white-space: nowrap;
}
.back-trail-head {
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.back-trail-foot {
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
.back-trail-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.back-trail-item:hover,
.back-trail-item:focus-visible {
  background: var(--bg-hover);
  color: var(--text);
}
.back-trail-item :deep(svg) {
  flex: none;
  color: var(--text-faint);
}
.back-trail-item:hover :deep(svg) {
  color: var(--accent);
}
.back-trail-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back-trail-depth {
  flex: none;
  color: var(--text-faint);
  font-size: 11.5px;
}
</style>
