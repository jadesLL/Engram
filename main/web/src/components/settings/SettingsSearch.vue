<template>
  <div class="settings-search-mask" @click.self="close">
    <div class="settings-search" role="dialog" aria-modal="true" aria-label="搜索设置项" @keydown.esc.stop="close">
      <div class="settings-search-field">
        <Icon name="search" :size="18" />
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="settings-search-input"
          placeholder="搜索设置项：备份、端口、模型、同步…"
          autocomplete="off"
          spellcheck="false"
          aria-label="搜索设置项"
          @keydown="onKeydown"
        />
        <kbd class="settings-search-kbd">esc</kbd>
      </div>

      <div class="settings-search-results" role="listbox" aria-label="搜索结果">
        <template v-if="groups.length">
          <div v-for="section in groups" :key="section.label" class="settings-search-section">
            <div class="settings-search-group-label">{{ section.label }}</div>
            <button
              v-for="hit in section.hits"
              :key="hit.group + '|' + hit.title"
              type="button"
              class="settings-search-result"
              :class="{ active: indexOf(hit) === active }"
              role="option"
              :aria-selected="indexOf(hit) === active ? 'true' : 'false'"
              @click="choose(hit)"
              @mousemove="active = indexOf(hit)"
            >
              <span class="settings-search-ico"><Icon :name="iconOf(hit)" :size="17" /></span>
              <span class="settings-search-main">
                <span class="settings-search-title" v-html="highlight(hit.title)" />
                <span class="settings-search-path">{{ hit.path }}</span>
              </span>
              <span class="settings-search-enter">打开 ↵</span>
            </button>
          </div>
        </template>
        <p v-else class="settings-search-empty">
          没有匹配「{{ query.trim() }}」的设置项
          <span class="settings-search-empty-hint">试试「备份」「端口」「同步」「模型」</span>
        </p>
      </div>

      <div class="settings-search-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>esc</kbd> 关闭</span>
        <span v-if="query.trim()" class="settings-search-count">找到 {{ flat.length }} 项</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../Icon.vue';
import type { SettingsDomain } from '../../lib/settingsDomains';
import {
  buildSettingsSearchIndex,
  searchSettings,
  type SettingsSearchHit,
} from '../../lib/settingsSearchEntries';

/**
 * 设置页搜索面板（Ctrl / ⌘ K）。
 *
 * 为什么需要它：设置项分散在 7 个大类、28 个分组里，分组名之外还有「端口」「备份」「模型 Key」
 * 这类行级设置项——只靠目录翻找，用户得先知道它在哪个分类里。这里用一个跨分类索引直接给结果，
 * 结果带「大类 · 分组」面包屑，选中后跳到对应分组并把分组卡闪一下。
 *
 * 键盘：↑/↓ 选择、↵ 打开、esc 关闭、Tab 在面板内循环；打开时记住原焦点，关闭后还原。
 */
const props = defineProps<{ domains: SettingsDomain[] }>();
const emit = defineEmits<{ close: []; jump: [payload: { domain: SettingsDomain['id']; group: string }] }>();

const inputEl = ref<HTMLInputElement | null>(null);
const query = ref('');
const active = ref(0);
let previousFocus: HTMLElement | null = null;

/** 索引只按当前可见的分组构建：能力位隐藏的分组不参与搜索（否则会跳到点不动的死锚点） */
const index = computed(() => buildSettingsSearchIndex(props.domains));

/** 空查询给「常用入口」：几个最常改的分组，按存在性过滤 */
const QUICK_GROUPS = ['data-backup', 'panel-sync', 'panel-update-server', 'agent-builtin', 'account-credentials', 'data-danger'];

const flat = computed<SettingsSearchHit[]>(() => {
  const q = query.value.trim();
  if (q) return searchSettings(q, index.value);
  return QUICK_GROUPS
    .map((groupId) => index.value.find((hit) => hit.isGroup && hit.group === groupId))
    .filter((hit): hit is SettingsSearchHit => Boolean(hit));
});

interface SearchSection { label: string; hits: SettingsSearchHit[] }
const groups = computed<SearchSection[]>(() => {
  const sections: SearchSection[] = [];
  const byLabel = new Map<string, SearchSection>();
  for (const hit of flat.value) {
    const label = props.domains.find((domain) => domain.id === hit.domain)?.label || hit.path;
    let section = byLabel.get(label);
    if (!section) {
      section = { label, hits: [] };
      byLabel.set(label, section);
      sections.push(section);
    }
    section.hits.push(hit);
  }
  return sections;
});

function indexOf(hit: SettingsSearchHit): number {
  return flat.value.indexOf(hit);
}

function iconOf(hit: SettingsSearchHit): string {
  return props.domains.find((domain) => domain.id === hit.domain)?.icon || 'settings';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] || ch);
}

/** 高亮命中片段；先转义再插 <mark>，不把用户输入当 HTML */
function highlight(title: string): string {
  const q = query.value.trim();
  const safe = escapeHtml(title);
  if (!q) return safe;
  const at = safe.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return safe;
  return safe.slice(0, at) + '<mark>' + safe.slice(at, at + q.length) + '</mark>' + safe.slice(at + q.length);
}

function choose(hit: SettingsSearchHit): void {
  emit('jump', { domain: hit.domain, group: hit.group });
  close();
}

function close(): void {
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  const total = flat.value.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!total) return;
    active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + total) % total;
    void nextTick(() => {
      const el = document.querySelector<HTMLElement>('.settings-search-result.active');
      el?.scrollIntoView({ block: 'nearest' });
    });
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const hit = flat.value[active.value];
    if (hit) choose(hit);
    return;
  }
  if (event.key === 'Tab') {
    // 焦点只在面板内循环：输入框 ↔ 结果列表
    const focusables = [
      inputEl.value,
      ...Array.from(document.querySelectorAll<HTMLElement>('.settings-search-result')),
    ].filter((el): el is HTMLElement => Boolean(el));
    if (!focusables.length) return;
    event.preventDefault();
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    const next = focusables[(current + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length];
    next.focus();
  }
}

onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null;
  void nextTick(() => inputEl.value?.focus());
});
onBeforeUnmount(() => {
  previousFocus?.focus?.();
});
</script>
