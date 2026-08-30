<template>
  <Teleport to="body">
    <div
      v-if="contextMenuState.open"
      ref="menuEl"
      class="app-context-menu"
      :class="{ ready, 'submenu-left': submenuLeft }"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      aria-label="Engram 操作菜单"
      @contextmenu.prevent
      @keydown="handleKeydown"
    >
      <template v-for="item in contextMenuState.items" :key="item.id">
        <div v-if="item.separatorBefore" class="context-menu-separator" role="separator" />
        <div
          class="context-menu-entry"
          @mouseenter="item.children?.length ? openSubmenu(item.id) : closeSubmenu()"
        >
          <button
            class="context-menu-button"
            type="button"
            role="menuitem"
            :data-menu-id="item.id"
            :aria-haspopup="item.children?.length ? 'menu' : undefined"
            :aria-expanded="item.children?.length ? activeSubmenu === item.id : undefined"
            :disabled="item.disabled"
            v-tooltip="item.disabled && item.hint ? item.hint : undefined"
            @focus="item.children?.length ? openSubmenu(item.id) : closeSubmenu()"
            @pointerdown.prevent
            @click="activate(item)"
          >
            <Icon v-if="item.icon" :name="item.icon" :size="15" />
            <span class="context-menu-label">{{ item.label }}</span>
            <span v-if="item.hint" class="context-menu-hint">{{ item.hint }}</span>
            <kbd v-else-if="item.shortcut" class="context-menu-shortcut">{{ item.shortcut }}</kbd>
            <Icon
              v-if="item.children?.length"
              name="chevron-right"
              :size="14"
              class="context-menu-chevron"
            />
          </button>

          <div
            v-if="item.children?.length"
            v-show="activeSubmenu === item.id"
            class="context-submenu"
            role="menu"
            :aria-label="item.label"
          >
            <template v-for="child in item.children" :key="child.id">
              <div v-if="child.separatorBefore" class="context-menu-separator" role="separator" />
              <button
                class="context-menu-button"
                type="button"
                role="menuitem"
                :data-menu-id="child.id"
                :data-parent-id="item.id"
                :disabled="child.disabled"
                v-tooltip="child.disabled && child.hint ? child.hint : undefined"
                @pointerdown.prevent
                @click="activate(child)"
              >
                <Icon v-if="child.icon" :name="child.icon" :size="15" />
                <span class="context-menu-label">{{ child.label }}</span>
                <span v-if="child.hint" class="context-menu-hint">{{ child.hint }}</span>
                <kbd v-else-if="child.shortcut" class="context-menu-shortcut">{{ child.shortcut }}</kbd>
              </button>
            </template>
          </div>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  closeContextMenu,
  contextMenuState,
  type ContextMenuItem,
} from '../lib/contextMenu';
import Icon from './Icon.vue';

const menuEl = ref<HTMLElement>();
const left = ref(0);
const top = ref(0);
const ready = ref(false);
const activeSubmenu = ref('');
const submenuLeft = ref(false);

const topLevelItems = computed(() => contextMenuState.items);

function itemById(id: string): ContextMenuItem | undefined {
  for (const item of topLevelItems.value) {
    if (item.id === id) return item;
    const child = item.children?.find((candidate) => candidate.id === id);
    if (child) return child;
  }
  return undefined;
}

function openSubmenu(id: string) {
  activeSubmenu.value = id;
}

function closeSubmenu() {
  activeSubmenu.value = '';
}

async function activate(item: ContextMenuItem) {
  if (item.disabled) return;
  if (item.children?.length) {
    activeSubmenu.value = item.id;
    await nextTick();
    menuEl.value
      ?.querySelector<HTMLButtonElement>(`.context-menu-button[data-parent-id="${CSS.escape(item.id)}"]:not(:disabled)`)
      ?.focus();
    return;
  }
  closeContextMenu();
  try {
    await item.action?.();
  } catch (error) {
    console.error('右键菜单操作失败', error);
  }
}

function visibleButtons(): HTMLButtonElement[] {
  return Array.from(
    menuEl.value?.querySelectorAll<HTMLButtonElement>('.context-menu-button:not(:disabled)') || [],
  ).filter((button) => button.offsetParent !== null);
}

function moveFocus(delta: number) {
  const buttons = visibleButtons();
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = current < 0
    ? (delta > 0 ? 0 : buttons.length - 1)
    : (current + delta + buttons.length) % buttons.length;
  buttons[next].focus();
}

async function handleKeydown(event: KeyboardEvent) {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.context-menu-button');
  if (event.key === 'Escape') {
    event.preventDefault();
    closeContextMenu();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    visibleButtons()[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    visibleButtons().at(-1)?.focus();
  } else if (event.key === 'ArrowRight' && target) {
    const item = itemById(target.dataset.menuId || '');
    if (!item?.children?.length) return;
    event.preventDefault();
    openSubmenu(item.id);
    await nextTick();
    menuEl.value
      ?.querySelector<HTMLButtonElement>(`.context-menu-button[data-parent-id="${CSS.escape(item.id)}"]:not(:disabled)`)
      ?.focus();
  } else if (event.key === 'ArrowLeft' && target?.dataset.parentId) {
    event.preventDefault();
    const parentId = target.dataset.parentId;
    closeSubmenu();
    menuEl.value
      ?.querySelector<HTMLButtonElement>(`.context-menu-button[data-menu-id="${CSS.escape(parentId)}"]`)
      ?.focus();
  }
}

async function positionMenu() {
  ready.value = false;
  activeSubmenu.value = '';
  left.value = contextMenuState.x;
  top.value = contextMenuState.y;
  await nextTick();
  const menu = menuEl.value;
  if (!menu) return;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  left.value = Math.max(margin, Math.min(contextMenuState.x, window.innerWidth - rect.width - margin));
  top.value = Math.max(margin, Math.min(contextMenuState.y, window.innerHeight - rect.height - margin));
  submenuLeft.value = left.value + rect.width + 226 > window.innerWidth - margin;
  ready.value = true;
  await nextTick();
  visibleButtons()[0]?.focus({ preventScroll: true });
}

function closeForPointer(event: PointerEvent) {
  if (!menuEl.value?.contains(event.target as Node)) closeContextMenu();
}

function closeForNativeMenu(event: MouseEvent) {
  if (!event.defaultPrevented && !menuEl.value?.contains(event.target as Node)) {
    closeContextMenu();
  }
}

function closeForViewportChange() {
  closeContextMenu();
}

watch(() => contextMenuState.version, positionMenu);

onMounted(() => {
  document.addEventListener('pointerdown', closeForPointer, true);
  window.addEventListener('contextmenu', closeForNativeMenu);
  window.addEventListener('resize', closeForViewportChange);
  window.addEventListener('blur', closeForViewportChange);
  window.addEventListener('scroll', closeForViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeForPointer, true);
  window.removeEventListener('contextmenu', closeForNativeMenu);
  window.removeEventListener('resize', closeForViewportChange);
  window.removeEventListener('blur', closeForViewportChange);
  window.removeEventListener('scroll', closeForViewportChange, true);
});
</script>

<style scoped>
.app-context-menu {
  position: fixed;
  z-index: var(--z-menu);
  width: 226px;
  max-width: calc(100vw - 16px);
  padding: 5px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--bg);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  color: var(--text);
  opacity: 0;
  pointer-events: none;
}

.app-context-menu.ready {
  opacity: 1;
  pointer-events: auto;
}

.context-menu-entry {
  position: relative;
}

.context-menu-button {
  width: 100%;
  min-height: 32px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: 5px;
  color: var(--text-secondary);
  text-align: left;
}

.context-menu-button:hover,
.context-menu-button:focus-visible {
  outline: 0;
  background: var(--bg-hover);
  color: var(--text);
}

.context-menu-button:disabled {
  color: var(--text-faint);
  cursor: default;
  opacity: 0.72;
}

.context-menu-button:disabled:hover {
  background: transparent;
}

.context-menu-label {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-menu-hint,
.context-menu-shortcut {
  color: var(--text-faint);
  font-family: inherit;
  font-size: 10px;
  white-space: nowrap;
}

.context-menu-chevron {
  margin-left: 2px;
}

.context-menu-separator {
  height: 1px;
  margin: 4px 5px;
  background: var(--border);
}

.context-submenu {
  position: absolute;
  top: -5px;
  left: calc(100% + 5px);
  width: 220px;
  padding: 5px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--bg);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}

.submenu-left .context-submenu {
  right: calc(100% + 5px);
  left: auto;
}

@media (max-width: 640px) {
  .app-context-menu {
    width: min(226px, calc(100vw - 16px));
  }
  .context-submenu {
    width: min(210px, calc(100vw - 24px));
  }
}
</style>
