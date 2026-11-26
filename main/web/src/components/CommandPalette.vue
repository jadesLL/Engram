<template>
  <Teleport to="body">
    <div class="cmd-mask" @click.self="close">
      <div
        ref="dialogEl"
        class="cmd-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="全局命令与搜索面板"
        @keydown="onKeydown"
      >
        <div class="cmd-head">
          <Icon name="search" :size="17" class="cmd-search-icon" />
          <input
            ref="inputEl"
            v-model="query"
            type="text"
            class="cmd-input"
            placeholder="搜索页面、设置项或快捷动作…"
            autocomplete="off"
            spellcheck="false"
            aria-label="搜索页面、设置项或快捷动作"
          />
          <kbd class="cmd-esc">ESC</kbd>
        </div>

        <div class="cmd-cats" role="tablist" aria-label="结果分类">
          <button
            v-for="tab in categoryTabs"
            :key="tab.key"
            type="button"
            role="tab"
            class="cmd-cat"
            :aria-selected="category === tab.key"
            :class="{ active: category === tab.key }"
            @click="setCategory(tab.key)"
          >
            {{ tab.label }}
          </button>
        </div>

        <div ref="listEl" class="cmd-list" role="listbox" aria-label="匹配结果">
          <p v-if="loadingPages && !pagesLoaded" class="cmd-hint">正在读取页面索引…</p>
          <template v-else-if="filteredItems.length">
            <button
              v-for="(item, index) in filteredItems"
              :key="item.id"
              type="button"
              role="option"
              class="cmd-row"
              :class="{ active: index === activeIndex }"
              :aria-selected="index === activeIndex"
              @mousemove="activeIndex = index"
              @click="execute(item)"
            >
              <span class="cmd-row-icon"><Icon :name="item.icon" :size="16" /></span>
              <span class="cmd-row-main">
                <span class="cmd-row-title">{{ item.title }}</span>
                <span v-if="item.sub" class="cmd-row-sub">{{ item.sub }}</span>
              </span>
              <span class="cmd-row-tag" :class="`kind-${item.kind}`">{{ item.tag }}</span>
            </button>
          </template>
          <p v-else class="cmd-hint">
            没有匹配「{{ query.trim() }}」的结果，按回车可前往全文搜索页。
          </p>
        </div>

        <div class="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行 / 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { visibleSettingsDomains } from '../lib/settingsDomains';
import { buildSettingsSearchIndex, searchSettings } from '../lib/settingsSearchEntries';
import { registerBackHandler } from '../lib/androidBack';

type PaletteCategory = 'all' | 'page' | 'setting' | 'action';

interface PalettePage {
  id: string;
  title: string;
  path?: string;
  type?: string;
  tags?: string[];
}

interface PaletteItem {
  id: string;
  kind: 'page' | 'setting' | 'action';
  tag: string;
  title: string;
  sub: string;
  icon: string;
  run: () => void;
}

const props = defineProps<{ agentName: string }>();
const emit = defineEmits<{
  close: [];
  'quick-note': [];
  'new-page': [];
  'open-agent': [];
}>();

const router = useRouter();
const app = useAppStore();
const { capabilities, load: loadCaps } = useRuntimeCapabilities();

const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const query = ref('');
const category = ref<PaletteCategory>('all');
const activeIndex = ref(0);
const pages = ref<PalettePage[]>([]);
const pagesLoaded = ref(false);
const loadingPages = ref(false);

let previousFocus: HTMLElement | null = null;
let unregisterBack: (() => void) | null = null;

const categoryTabs: Array<{ key: PaletteCategory; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'page', label: '页面' },
  { key: 'setting', label: '设置' },
  { key: 'action', label: '动作' },
];

const visibleDomains = computed(() =>
  visibleSettingsDomains({
    agent: capabilities.value.features.agentAdmin,
    agentConsole: capabilities.value.features.agentConsole,
    videoConfig: capabilities.value.features.videoConfig,
    serverUpdate: capabilities.value.features.serverUpdate,
    apkUpdate: capabilities.value.features.apkUpdate,
    desktop: capabilities.value.runtime === 'desktop',
  })
);

const settingsIndex = computed(() => buildSettingsSearchIndex(visibleDomains.value));

const actionItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim();
  const nextTheme = app.theme === 'dark' ? 'light' : 'dark';
  const base: PaletteItem[] = [
    {
      id: 'action:quick-note',
      kind: 'action',
      tag: '动作',
      title: '记一条灵感',
      sub: '快捷键 Ctrl+N',
      icon: 'lightbulb',
      run: () => emit('quick-note'),
    },
    {
      id: 'action:new-page',
      kind: 'action',
      tag: '动作',
      title: '新建 Wiki 页面',
      sub: '创建空白文档并进入编辑',
      icon: 'file-plus',
      run: () => emit('new-page'),
    },
    {
      id: 'action:open-agent',
      kind: 'action',
      tag: '动作',
      title: `打开${props.agentName}`,
      sub: '在当前工作区继续对话',
      icon: 'ai',
      run: () => emit('open-agent'),
    },
    {
      id: 'action:toggle-theme',
      kind: 'action',
      tag: '动作',
      title: `切换到${nextTheme === 'dark' ? '深色' : '浅色'}主题`,
      sub: '立即应用并保存外观设置',
      icon: nextTheme === 'dark' ? 'moon' : 'sun',
      run: () => app.setTheme(nextTheme),
    },
    {
      id: 'action:full-search',
      kind: 'action',
      tag: '动作',
      title: q ? `在全文搜索页查找“${q}”` : '前往全文搜索页',
      sub: '搜索正文内容与同义词召回',
      icon: 'search',
      run: () => {
        void router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
      },
    },
  ];
  if (!q) return base;
  const lower = q.toLowerCase();
  return base.filter(
    (item) =>
      item.title.toLowerCase().includes(lower) ||
      item.sub.toLowerCase().includes(lower) ||
      item.id === 'action:full-search'
  );
});

const pageItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim().toLowerCase();
  const matched = q
    ? pages.value.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.path || '').toLowerCase().includes(q) ||
          (p.tags || []).some((t) => t.toLowerCase().includes(q))
      )
    : pages.value;
  return matched.slice(0, 8).map((p) => ({
    id: `page:${p.id}`,
    kind: 'page',
    tag: '页面',
    title: p.title || '未命名页面',
    sub: p.path || '',
    icon: 'pages',
    run: () => {
      void router.push(`/page/${p.id}`);
    },
  }));
});

const settingItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim();
  const hits = q
    ? searchSettings(q, settingsIndex.value).slice(0, 6)
    : settingsIndex.value.filter((h) => h.isGroup).slice(0, 4);
  return hits.map((hit) => ({
    id: `setting:${hit.domain}:${hit.group}:${hit.title}`,
    kind: 'setting',
    tag: '设置',
    title: hit.title,
    sub: hit.path,
    icon: 'settings',
    run: () => {
      void router.push({ path: '/settings', query: { section: hit.domain, anchor: hit.group } });
    },
  }));
});

const filteredItems = computed<PaletteItem[]>(() => {
  if (category.value === 'page') return pageItems.value;
  if (category.value === 'setting') return settingItems.value;
  if (category.value === 'action') return actionItems.value;
  return [...pageItems.value.slice(0, 5), ...settingItems.value.slice(0, 4), ...actionItems.value];
});

function setCategory(next: PaletteCategory): void {
  category.value = next;
  activeIndex.value = 0;
}

function close(): void {
  emit('close');
}

function execute(item: PaletteItem): void {
  close();
  item.run();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  const total = filteredItems.value.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!total) return;
    activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + total) % total;
    void nextTick(() => {
      listEl.value?.querySelector<HTMLElement>('.cmd-row.active')?.scrollIntoView({ block: 'nearest' });
    });
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const hit = filteredItems.value[activeIndex.value];
    if (hit) {
      execute(hit);
    } else {
      const q = query.value.trim();
      close();
      void router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    }
  }
}

async function fetchPages(): Promise<void> {
  if (loadingPages.value || pagesLoaded.value) return;
  loadingPages.value = true;
  try {
    const { data } = await api.get('/api/pages/list');
    const list = Array.isArray(data?.pages) ? data.pages : Array.isArray(data) ? data : [];
    pages.value = list;
    pagesLoaded.value = true;
  } catch {
    pagesLoaded.value = true;
  } finally {
    loadingPages.value = false;
  }
}

onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null;
  void loadCaps();
  void fetchPages();
  unregisterBack = registerBackHandler(() => {
    close();
    return true;
  });
  void nextTick(() => {
    inputEl.value?.focus();
  });
});

onBeforeUnmount(() => {
  unregisterBack?.();
  unregisterBack = null;
  previousFocus?.focus?.();
});
</script>

<style scoped>
.cmd-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: calc(72px + var(--safe-top)) 16px calc(24px + var(--safe-bottom));
  background: var(--mask);
  backdrop-filter: blur(4px);
}

.cmd-dialog {
  width: min(600px, 100%);
  max-height: min(540px, 80vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
}

.cmd-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.cmd-search-icon {
  flex: none;
  color: var(--text-faint);
}

.cmd-input {
  flex: 1;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  font-size: var(--fs-h3);
  color: var(--text);
}

.cmd-input:hover,
.cmd-input:focus {
  background: transparent;
  box-shadow: none;
}

.cmd-esc {
  flex: none;
}

.cmd-cats {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.cmd-cat {
  padding: 4px 10px;
  border-radius: var(--radius-control);
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--text-secondary);
  transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard);
}

.cmd-cat:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.cmd-cat.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.cmd-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cmd-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-control);
  text-align: left;
  transition: background var(--motion-fast) var(--ease-standard);
}

.cmd-row.active,
.cmd-row:hover {
  background: var(--bg-hover);
}

.cmd-row-icon {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.cmd-row.active .cmd-row-icon {
  background: var(--accent-soft);
  color: var(--accent);
}

.cmd-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cmd-row-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text);
}

.cmd-row-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-faint);
}

.cmd-row-tag {
  flex: none;
  padding: 2px 7px;
  border-radius: var(--radius-control);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.cmd-row-tag.kind-page {
  background: var(--badge-concept-soft);
  color: var(--badge-concept);
}

.cmd-row-tag.kind-setting {
  background: var(--badge-note-soft);
  color: var(--badge-note);
}

.cmd-row-tag.kind-action {
  background: var(--badge-idea-soft);
  color: var(--badge-idea);
}

.cmd-hint {
  margin: 0;
  padding: 24px 16px;
  text-align: center;
  font-size: var(--fs-small);
  color: var(--text-faint);
}

.cmd-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: var(--fs-caption);
  color: var(--text-faint);
}

.cmd-foot kbd {
  margin-right: 3px;
}
</style>
