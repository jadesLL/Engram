<template>
  <div
    class="settings-group"
    :id="anchor || undefined"
    :class="[`level-${resolvedLevel}`]"
  >
    <div class="group-card" :class="{ 'is-collapsed': collapsedState }">
      <div class="group-band" :class="{ collapsible: Boolean(anchor) }" @click="onBandClick">
        <span v-if="groupIcon" class="group-ico" aria-hidden="true">
          <Icon :name="groupIcon" :size="16" />
        </span>
        <span class="group-text">
          <span class="group-title">{{ title }}</span>
          <span v-if="hint" class="group-hint">{{ hint }}</span>
        </span>
        <slot name="actions" />
        <span v-if="badge" class="group-badge" :class="`tone-${badgeTone}`">{{ badge }}</span>
        <button
          v-if="anchor"
          type="button"
          class="group-caret"
          :aria-expanded="collapsedState ? 'false' : 'true'"
          :title="collapsedState ? `展开「${title}」` : `收起「${title}」`"
          @click.stop="toggle"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!collapsedState" class="group-body" :class="{ flush }">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { settingsGroupIcon } from '../../lib/settingsDomains';
import { isGroupCollapsed, toggleGroupCollapsed } from '../../lib/settingsCollapse';

/**
 * 设置面板内的分组卡片：头部色带（图标 + 标题 + 说明 + 徽标）+ 独立卡片。
 * 2026-09-24 起支持折叠：点色带空白处或右侧箭头收起/展开，状态按 anchor
 * 持久化（lib/settingsCollapse.ts）；二级锚点跳转会自动展开目标分组。
 * 视觉样式在 styles/settings.css 全局定义，SyncPanel / UpdatePanel 等不使用
 * 本组件的面板用同一套类名（.settings-group / .group-card / .group-band /
 * .group-caret）手写相同结构，保证全页分组外观与折叠行为一致。
 *
 * props 说明：
 * - anchor：渲染成 DOM id，供二级导航定位、滚动联动与折叠状态持久化使用；
 *   缺省时分组不可折叠（没有可持久化的身份）；
 * - icon：头部识别图标，缺省时按 anchor 在 settingsDomains 里查（分组数据自带 icon）；
 * - badge / badgeTone：分组状态徽标（如「待配置」「37 项」）；
 * - level="danger"（或历史写法 danger）：不可撤销操作，警示色常驻；
 * - level="primary" / "advanced"：不再改变外观，保留仅为兼容；
 * - defaultOpen：折叠初版时代的遗留属性，已无效（折叠状态由用户操作持久化决定）；
 * - flush：内容是无内边距的 setting-row 列表时使用（行自带边框与留白）。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    hint?: string;
    defaultOpen?: boolean;
    flush?: boolean;
    danger?: boolean;
    level?: 'primary' | 'normal' | 'advanced' | 'danger';
    badge?: string;
    badgeTone?: 'accent' | 'ok' | 'warn' | 'danger' | 'muted';
    anchor?: string;
    icon?: string;
  }>(),
  { defaultOpen: true, flush: false, danger: false, badgeTone: 'muted' },
);

const resolvedLevel = computed(() => props.level ?? (props.danger ? 'danger' : 'normal'));
const groupIcon = computed(() => props.icon || (props.anchor ? settingsGroupIcon(props.anchor) : ''));
const collapsedState = computed(() => isGroupCollapsed(props.anchor));

function toggle() {
  toggleGroupCollapsed(props.anchor);
}

/** 点色带空白处也切换折叠；点在按钮/链接/输入框等交互元素上不触发 */
function onBandClick(event: MouseEvent) {
  if (!props.anchor) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, label')) return;
  toggle();
}
</script>
