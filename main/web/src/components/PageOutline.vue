<template>
  <div class="page-outline" :class="'mode-' + mode">
    <header class="po-head">
      <span class="po-eyebrow">本页目录</span>
      <span class="po-count">{{ items.length }} 节</span>
      <slot name="head-extra" />
    </header>

    <nav v-if="items.length" class="po-nav" aria-label="本页目录">
      <button
        v-for="(item, index) in items"
        :key="index + '-' + item.text"
        type="button"
        class="po-row"
        :class="{ active: index === activeIndex }"
        :data-level="item.level"
        :aria-current="index === activeIndex ? 'location' : undefined"
        :title="item.text"
        @click="emit('select', index)"
      >
        <span class="po-text">{{ item.text }}</span>
      </button>
    </nav>

    <div v-else class="po-empty">
      <div class="po-empty-box">
        <Icon name="list-tree" :size="22" />
        <strong>本页还没有小标题</strong>
        <p>用 <code>##</code> 开头写一行标题，目录会出现在这里。</p>
      </div>
    </div>

    <footer v-if="items.length" class="po-foot">
      <button type="button" class="po-top" @click="emit('top')">
        <Icon name="chevron-up" :size="12" />
        回到顶部
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import Icon from './Icon.vue';
import type { OutlineItem } from '../lib/outline';

/**
 * 编辑页「本页目录」的共用列表（桌面右侧目录卡 / 窄窗口浮层 / 手机底部面板）。
 * 只负责层级排版、当前章节高亮与空状态；外框（卡片、浮层、底部 sheet）由调用方给，
 * 这样桌面和手机能用同一份计数、空状态与条目样式。
 */
withDefaults(
  defineProps<{
    items: OutlineItem[];
    activeIndex?: number;
    /** card：桌面目录卡；sheet：手机底部面板（44px 行高、更大字号） */
    mode?: 'card' | 'sheet';
  }>(),
  { activeIndex: -1, mode: 'card' }
);

const emit = defineEmits<{
  select: [index: number];
  top: [];
}>();
</script>

<style scoped>
.page-outline {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* ---------- 头部：小标题 + 条数 ---------- */
.po-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 7px 9px;
}
.po-eyebrow {
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.13em;
}
.po-count {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ---------- 条目：层级只靠字号 / 字重 / 缩进，不再渲染 H2/H3 标签 ---------- */
.po-nav {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1px 0 3px;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.14) transparent;
}
.po-nav::-webkit-scrollbar { width: 6px; }
.po-nav::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.12);
  border-radius: 8px;
}
.po-row {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 30px;
  padding: 5px 8px 5px 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.po-row::before {
  content: "";
  position: absolute;
  left: 3px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
}
.po-row[data-level="2"] {
  color: var(--text);
  font-size: 13px;
  font-weight: 560;
}
.po-row[data-level="3"] { padding-left: 24px; }
.po-row[data-level="4"] {
  padding-left: 36px;
  color: var(--text-faint);
  font-size: 12px;
}
.po-row:hover { background: var(--bg-hover); color: var(--text); }
.po-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.po-row.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 620;
}
.po-row.active::before { background: var(--accent); }
.po-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 空状态：虚线提示卡，给一句能直接照做的写法 ---------- */
.po-empty {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 4px 10px;
}
.po-empty-box {
  padding: 16px 13px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 11px;
  text-align: center;
}
.po-empty-box :deep(svg) {
  margin: 0 auto 8px;
  color: var(--text-faint);
}
.po-empty-box strong {
  display: block;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
}
.po-empty-box p {
  margin: 5px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.6;
}
.po-empty-box code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10.5px;
  color: var(--text-secondary);
}

/* ---------- 底部：回到顶部 ---------- */
.po-foot {
  flex: none;
  margin-top: 4px;
  padding: 8px 6px 2px;
  border-top: 1px solid var(--card-line-soft);
}
.po-top {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.po-top:hover { background: var(--accent-soft); color: var(--accent); }

/* ---------- 手机底部面板：44px 行高，头部换成与 sheet 一致的标题 ---------- */
.mode-sheet .po-head {
  gap: 8px;
  align-items: center;
  padding: 2px 10px 10px;
}
.mode-sheet .po-eyebrow {
  color: var(--text);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0;
}
.mode-sheet .po-count {
  margin-left: 0;
  color: var(--text-faint);
  font-size: 11.5px;
}
.mode-sheet .po-nav {
  padding: 2px 3px 4px;
}
.mode-sheet .po-row {
  min-height: 44px;
  padding: 10px 12px 10px 14px;
  border-radius: 8px;
  font-size: 14px;
}
.mode-sheet .po-row[data-level="2"] { font-size: 14px; }
.mode-sheet .po-row[data-level="3"] {
  padding-left: 30px;
  font-size: 13px;
}
.mode-sheet .po-row[data-level="4"] { padding-left: 46px; }
.mode-sheet .po-row::before {
  left: 4px;
  top: 12px;
  bottom: 12px;
}
.mode-sheet .po-empty { padding: 4px 7px 10px; }
.mode-sheet .po-foot {
  margin-top: 2px;
  padding: 6px 8px 0;
}
</style>
