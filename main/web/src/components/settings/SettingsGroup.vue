<template>
  <div
    class="settings-group"
    :id="anchor || undefined"
    :class="[`level-${resolvedLevel}`]"
  >
    <div class="group-card">
      <div class="group-band">
        <span v-if="groupIcon" class="group-ico" aria-hidden="true">
          <Icon :name="groupIcon" :size="16" />
        </span>
        <span class="group-text">
          <span class="group-title">{{ title }}</span>
          <span v-if="hint" class="group-hint">{{ hint }}</span>
        </span>
        <slot name="actions" />
        <span v-if="badge" class="group-badge" :class="`tone-${badgeTone}`">{{ badge }}</span>
      </div>
      <div class="group-body" :class="{ flush }">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { settingsGroupIcon } from '../../lib/settingsDomains';

/**
 * 设置面板内的分组卡片（2026-09-24 改版）：常开、不折叠，组与组之间靠
 * 「头部色带（图标 + 标题 + 说明 + 徽标）+ 独立卡片 + 大间距」区分。
 * 视觉样式在 styles/settings.css 全局定义，SyncPanel / UpdatePanel / StoragePanel
 * 等不使用本组件的面板用同一套类名（.settings-group / .group-card / .group-band）
 * 手写相同结构，保证全页分组外观一致。
 *
 * props 说明：
 * - anchor：渲染成 DOM id，供设置页二级导航定位与滚动联动（scroll-spy）使用；
 * - icon：头部识别图标，缺省时按 anchor 在 settingsDomains 里查（分组数据自带 icon）；
 * - badge / badgeTone：分组状态徽标（如「待配置」「37 项」）；
 * - level="danger"（或历史写法 danger）：不可撤销操作，警示色常驻；
 * - level="primary" / "advanced"：不再改变外观（改版后分组一律常开平铺），保留仅为兼容；
 * - defaultOpen：折叠时代的遗留属性，已无效，仅为不改动全部调用方而保留；
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
</script>
