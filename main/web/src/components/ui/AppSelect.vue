<template>
  <div
    class="app-select"
    :class="[`v-${variant}`, { 'is-open': open, 'is-disabled': disabled, 'is-placeholder': !currentOption }]"
  >
    <button
      ref="triggerRef"
      :id="id || undefined"
      type="button"
      class="app-select-trigger"
      :disabled="disabled"
      :title="title || undefined"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-label="ariaLabel || undefined"
      :aria-activedescendant="open && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      @click="toggle"
      @keydown="onKeydown"
      @blur="onBlur"
    >
      <span class="app-select-label">{{ currentLabel }}</span>
      <Icon class="app-select-caret" name="chevron-down" :size="12" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="listId"
        ref="menuRef"
        class="app-select-menu"
        :class="{ ready: placed, 'is-up': openUp }"
        :style="menuStyle"
        role="listbox"
        :aria-label="ariaLabel || undefined"
        @pointerdown.prevent
        @contextmenu.prevent
      >
        <div v-if="!options.length" class="app-select-empty">{{ emptyText }}</div>
        <div
          v-for="(option, index) in options"
          :id="optionId(index)"
          :key="option.value"
          class="app-select-option"
          :class="{
            'is-active': index === activeIndex,
            'is-selected': option.value === modelValue,
            'is-disabled': option.disabled,
          }"
          role="option"
          :aria-selected="option.value === modelValue"
          :aria-disabled="option.disabled ? 'true' : undefined"
          @mouseenter="hover(index)"
          @click="pick(index)"
        >
          <span class="app-select-option-label">{{ option.label }}</span>
          <Icon v-if="option.value === modelValue" class="app-select-tick" name="check" :size="12" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
/*
 * 统一自绘下拉（2026-09-25）：全库原生 <select> 的替代实现。
 *
 * 为什么不用原生 select：它的弹层由系统绘制，无法跟应用主题/设计令牌走——Chromium 只认
 * color-scheme 与 option 底色（见 styles/main.css 的 select option 补丁），选中行高亮仍是
 * 系统色；弹层里放不下图标、提示与自定义行高；宽度不受控；移动端会弹系统选择器；截图取证
 * 也抓不到。改为按钮 + Teleport 到 body 的 listbox 后，弹层可完全用 UI 2.0 令牌绘制。
 *
 * 行为对齐原生 select：键盘（↑↓/Home/End/Enter/Space/Esc/首字母）、ARIA（combobox +
 * listbox + aria-activedescendant）、点击外部关闭、禁用态、值未变时不触发 change。
 * Teleport 到 body 是为了不被设置页 .group-card 之类的 overflow: hidden 裁掉。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type CSSProperties } from 'vue';
import Icon from '../Icon.vue';

type SelectOption = { value: T; label: string; disabled?: boolean };

const props = withDefaults(
  defineProps<{
    modelValue: T;
    options: SelectOption[];
    disabled?: boolean;
    /** control 常规控件；chip 编辑器页面类型胶囊；mini 紧凑行内（回收站挂载） */
    variant?: 'control' | 'chip' | 'mini';
    /** 当前值不在选项里时显示的文字 */
    placeholder?: string;
    ariaLabel?: string;
    id?: string;
    title?: string;
    /** 弹层最大高度（还会按视口可用空间再收） */
    menuMaxHeight?: number;
    emptyText?: string;
  }>(),
  {
    disabled: false,
    variant: 'control',
    placeholder: '请选择',
    ariaLabel: '',
    id: '',
    title: '',
    menuMaxHeight: 300,
    emptyText: '无可选项',
  }
);

const emit = defineEmits<{
  'update:modelValue': [value: T];
  change: [value: T];
}>();

const uid = useId();
const listId = `app-select-list-${uid}`;
const optionId = (index: number) => `app-select-opt-${uid}-${index}`;

const triggerRef = ref<HTMLButtonElement>();
const menuRef = ref<HTMLElement>();
const open = ref(false);
const placed = ref(false);
const openUp = ref(false);
const activeIndex = ref(-1);
const menuStyle = ref<CSSProperties>({});

const currentOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const currentLabel = computed(() => currentOption.value?.label || props.placeholder);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/* ── 开关 ─────────────────────────────────────────────── */
function toggle(): void {
  if (open.value) closeMenu(true);
  else openMenu();
}

function openMenu(): void {
  if (open.value || props.disabled) return;
  open.value = true;
  placed.value = false;
  const selected = props.options.findIndex((option) => option.value === props.modelValue && !option.disabled);
  activeIndex.value = selected >= 0 ? selected : firstEnabled();
  bindGlobalListeners();
  void nextTick(() => {
    place();
    requestAnimationFrame(() => {
      placed.value = true;
      scrollActiveIntoView();
    });
  });
}

function closeMenu(refocus = false): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
  unbindGlobalListeners();
  if (refocus) triggerRef.value?.focus();
}

/* ── 落位：跟随触发条，空间不足向上翻，始终夹在视口内 ────── */
function place(): void {
  const trigger = triggerRef.value;
  const menu = menuRef.value;
  if (!trigger || !menu) return;
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  const gap = 4;
  const naturalHeight = menu.scrollHeight;
  const spaceBelow = vh - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  const up = spaceBelow < Math.min(naturalHeight, 180) && spaceAbove > spaceBelow;
  const available = Math.max(120, up ? spaceAbove : spaceBelow);
  const maxHeight = Math.max(120, Math.min(naturalHeight, props.menuMaxHeight, available));
  const height = Math.min(naturalHeight, maxHeight);
  const width = Math.min(Math.max(menu.offsetWidth, rect.width), vw - margin * 2);
  openUp.value = up;
  menuStyle.value = {
    top: `${Math.round(clamp(up ? rect.top - gap - height : rect.bottom + gap, margin, vh - height - margin))}px`,
    left: `${Math.round(clamp(rect.left, margin, Math.max(margin, vw - margin - width)))}px`,
    minWidth: `${Math.round(Math.min(rect.width, vw - margin * 2))}px`,
    maxWidth: `${Math.round(vw - margin * 2)}px`,
    maxHeight: `${Math.round(maxHeight)}px`,
    transformOrigin: up ? 'bottom' : 'top',
  };
}

function scrollActiveIntoView(): void {
  const menu = menuRef.value;
  const active = activeIndex.value >= 0 ? menu?.children[activeIndex.value] as HTMLElement | undefined : undefined;
  if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
}

/* ── 键盘与选择 ───────────────────────────────────────── */
function firstEnabled(): number {
  return props.options.findIndex((option) => !option.disabled);
}

function lastEnabled(): number {
  for (let index = props.options.length - 1; index >= 0; index -= 1) {
    if (!props.options[index].disabled) return index;
  }
  return -1;
}

function setActive(index: number): void {
  activeIndex.value = index;
  scrollActiveIntoView();
}

function hover(index: number): void {
  if (!props.options[index]?.disabled) activeIndex.value = index;
}

function move(delta: number): void {
  const count = props.options.length;
  if (!count) return;
  let index = activeIndex.value;
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count;
    if (!props.options[index].disabled) break;
  }
  setActive(index);
}

function pick(index: number): void {
  const option = props.options[index];
  if (!option || option.disabled) return;
  if (option.value !== props.modelValue) {
    emit('update:modelValue', option.value);
    emit('change', option.value);
  }
  closeMenu(true);
}

/* 首字母定位：600ms 内的连续按键拼成前缀 */
let typeBuffer = '';
let typeTimer = 0;

function typeahead(event: KeyboardEvent): void {
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
  typeBuffer += event.key.toLowerCase();
  window.clearTimeout(typeTimer);
  typeTimer = window.setTimeout(() => {
    typeBuffer = '';
  }, 600);
  const count = props.options.length;
  const start = activeIndex.value >= 0 ? activeIndex.value : 0;
  for (let step = 1; step <= count; step += 1) {
    const index = (start + step) % count;
    const option = props.options[index];
    if (!option.disabled && option.label.toLowerCase().startsWith(typeBuffer)) {
      setActive(index);
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (!open.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
      if (event.key === 'ArrowUp') activeIndex.value = lastEnabled();
    }
    return;
  }
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      closeMenu(true);
      break;
    case 'Tab':
      closeMenu();
      break;
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Home':
      event.preventDefault();
      setActive(firstEnabled());
      break;
    case 'End':
      event.preventDefault();
      setActive(lastEnabled());
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      pick(activeIndex.value);
      break;
    default:
      typeahead(event);
  }
}

function onBlur(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && menuRef.value?.contains(next)) return;
  closeMenu();
}

/* ── 全局监听：仅展开期间挂载 ─────────────────────────── */
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (!target) return;
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  closeMenu();
}

function onViewportChange(): void {
  if (open.value) place();
}

function bindGlobalListeners(): void {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
}

function unbindGlobalListeners(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
}

/* 值被外部改写（如父组件重置表单）时，展开中的高亮同步过去 */
watch(
  () => props.modelValue,
  () => {
    if (!open.value) return;
    const selected = props.options.findIndex((option) => option.value === props.modelValue && !option.disabled);
    activeIndex.value = selected >= 0 ? selected : firstEnabled();
  }
);

onBeforeUnmount(() => {
  unbindGlobalListeners();
  window.clearTimeout(typeTimer);
});

defineExpose({ open: openMenu, close: () => closeMenu() });
</script>

<style scoped>
.app-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
}

/* ── 触发条：与全局 input/textarea/select 同一套令牌 ────── */
.app-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--control-border-strong);
  border-radius: var(--radius-control);
  background: var(--control-bg);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
}
.app-select-trigger:hover:not(:disabled) { background: var(--control-bg-hover); }
.app-select-trigger:focus-visible,
.app-select.is-open .app-select-trigger {
  outline: none;
  background: var(--control-bg-hover);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent);
}
.app-select-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.55;
  background: var(--control-bg);
}

.app-select-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.app-select.is-placeholder .app-select-label { color: var(--text-faint); }
.app-select-caret {
  flex: none;
  color: var(--text-faint);
  transition: transform 140ms ease;
}
.app-select.is-open .app-select-caret { transform: rotate(180deg); }

/* chip：编辑器页面类型胶囊（软色强调，箭头在胶囊内） */
.app-select.v-chip .app-select-trigger {
  gap: 4px;
  height: 24px;
  padding: 0 8px 0 10px;
  border-color: transparent;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.app-select.v-chip .app-select-trigger:hover:not(:disabled),
.app-select.v-chip.is-open .app-select-trigger {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.app-select.v-chip .app-select-caret { color: var(--accent); }

/* mini：列表行内紧凑控件（回收站「挂载到…」） */
.app-select.v-mini .app-select-trigger {
  gap: 4px;
  height: 28px;
  max-width: 160px;
  padding: 0 6px 0 9px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

/* ── 弹层（Teleport 到 body，fixed 落位）──────────────── */
.app-select-menu {
  position: fixed;
  z-index: var(--z-menu);
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  box-shadow: var(--shadow);
  overflow-y: auto;
  overscroll-behavior: contain;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 120ms ease, transform 120ms ease;
}
.app-select-menu.is-up { transform: translateY(4px); }
.app-select-menu.ready { opacity: 1; transform: none; }

.app-select-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.35;
  white-space: nowrap;
  cursor: pointer;
}
.app-select-option.is-active {
  background: var(--bg-hover);
  color: var(--text);
}
.app-select-option.is-selected {
  color: var(--accent);
  font-weight: 600;
}
.app-select-option.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.app-select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.app-select-tick { flex: none; color: var(--accent); }
.app-select-empty {
  padding: 8px 9px;
  color: var(--text-faint);
  font-size: var(--font-sm);
}
</style>
