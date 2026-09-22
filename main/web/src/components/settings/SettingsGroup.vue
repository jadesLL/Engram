<template>
  <div
    class="settings-group"
    :id="anchor || undefined"
    :class="[`level-${resolvedLevel}`, { open }]"
  >
    <button
      class="group-head"
      type="button"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="group-bar" aria-hidden="true" />
      <span class="group-text">
        <span class="group-title">{{ title }}</span>
        <span v-if="hint" class="group-hint">{{ hint }}</span>
      </span>
      <span v-if="displayBadge" class="group-badge" :class="`tone-${displayBadgeTone}`">{{ displayBadge }}</span>
      <span class="group-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
    </button>
    <div v-show="open" class="group-card" :class="{ flush }">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/**
 * 设置面板内的可折叠分组（Win11 式：组标题在卡片外，点标题行展开/收起）。
 *
 * 分级强调（level）——「强调分组」的载体，同一套规则复用到所有面板：
 * - primary  最该先看/需要用户动手的分组：强调色描边 + 浅色渐变标题行 + 状态徽标；
 * - normal   常规分组（默认）；
 * - advanced 高级/低频设置：虚线描边 + 灰底 + 默认收起，日常不占视线；
 * - danger   不可撤销的危险操作：警示色常驻（标题、竖条、描边都是红的）。
 * danger 属性是 level="danger" 的历史写法，两者等价，保留兼容。
 *
 * 其余行为：
 * - flush：内容是无内边距的 setting-row 列表时使用（行自带边框与留白）；
 * - anchor：渲染成 DOM id，供设置页二级导航定位与滚动联动（scroll-spy）使用；
 * - badge / badgeTone：分组状态徽标（如「待配置」「37 项」），一眼看出哪个组有事；
 * - defaultOpen 只决定「用户动手之前」的初始开合：父级异步加载状态（如更新源是否已配置）
 *   到达前允许跟随刷新，一旦用户手动开合过就以用户选择为准；
 * - 组标题行吸顶：设置页改成「一次看一整类」后，长列表滚动时靠它保持上下文。
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
  }>(),
  { defaultOpen: false, flush: false, danger: false, badgeTone: 'muted' },
);

const resolvedLevel = computed(() => props.level ?? (props.danger ? 'danger' : 'normal'));

/**
 * 「高级」分组没给状态时补一个中性标注：分级靠描边+灰底表达，但小屏或快速扫视时
 * 用户需要一个明确的词说明「这组平时不用管」。
 */
const displayBadge = computed(() => props.badge || (resolvedLevel.value === 'advanced' ? '高级' : ''));
const displayBadgeTone = computed(() => (props.badge ? props.badgeTone : 'muted'));

const open = ref(props.defaultOpen);
const touched = ref(false);

watch(
  () => props.defaultOpen,
  (value) => {
    if (!touched.value) open.value = value;
  },
);

function toggle() {
  touched.value = true;
  open.value = !open.value;
}
</script>

<style scoped>
.settings-group {
  margin: 18px 24px;
}
.settings-group:first-of-type {
  margin-top: 20px;
}

/* 组标题行：Win11 式小标签，整行可点展开/收起；吸顶时保持当前分组上下文 */
.group-head {
  position: sticky;
  top: 0;
  z-index: 2;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px 0;
  border-radius: 6px;
  text-align: left;
  /* 不透明底色：吸顶滚动时不能透出下方内容 */
  background: var(--bg);
  transition: background 0.12s ease;
}
.group-head:hover {
  background: var(--bg-hover);
}
.group-head:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* 分级竖条：常规=中性，主分组=强调色，危险=警示色 */
.group-bar {
  flex-shrink: 0;
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: var(--border-strong);
}
.group-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.group-hint {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}
.group-chevron {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  transition: transform 0.15s ease;
}
.settings-group.open .group-chevron {
  transform: rotate(180deg);
}

/* 分组状态徽标：把「这个组有没有事」直接写在标题行上 */
.group-badge {
  flex-shrink: 0;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.group-badge.tone-muted {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.group-badge.tone-accent {
  background: var(--accent-soft);
  color: var(--accent);
}
.group-badge.tone-ok {
  background: var(--success-soft);
  color: var(--success);
}
.group-badge.tone-warn {
  background: var(--warn-soft);
  color: var(--warning);
}
.group-badge.tone-danger {
  background: var(--danger-soft);
  color: var(--danger);
}

.group-card {
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
}
.group-card:not(.flush) {
  padding: 4px 16px 16px;
}

/* ---------- 分级强调 ---------- */
.level-primary .group-bar {
  background: var(--accent);
}
.level-primary .group-head {
  background: linear-gradient(90deg, var(--accent-soft), transparent 62%), var(--bg);
}
.level-primary .group-card {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.level-advanced .group-title {
  color: var(--text-secondary);
}
.level-advanced .group-card {
  border-style: dashed;
  background: var(--bg-secondary);
}

/* 危险分组：警示色常驻可见（收起时标题仍是红色） */
.level-danger .group-title {
  color: var(--danger);
}
.level-danger .group-bar {
  background: var(--danger);
}
.level-danger .group-head {
  background: linear-gradient(90deg, var(--danger-soft), transparent 62%), var(--bg);
}
.level-danger .group-card {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}

@media (max-width: 768px) {
  .settings-group {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .group-chevron {
    transition: none;
  }
}
</style>
