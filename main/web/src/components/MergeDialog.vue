<template>
  <AppModal
    :open="mergeState.open"
    title="合并页面"
    :close-on-mask="!merging"
    @close="onClose"
  >
    <template v-if="source">
      <div class="merge-source">
        <Icon name="merge" :size="16" />
        <span class="merge-source-label">源页面</span>
        <span class="merge-source-title">{{ source.title }}</span>
        <span class="merge-type-tag">{{ typeLabel(source.type) }}</span>
      </div>

      <div v-if="!target" class="merge-picker">
        <div class="merge-search-field">
          <Icon name="search" :size="14" class="search-icon" />
          <input
            ref="searchInput"
            v-model="query"
            placeholder="搜索要合并到的目标页面"
            @keydown.enter="pickFirst"
          />
        </div>
        <div class="merge-page-list">
          <button
            v-for="p in filteredPages"
            :key="p.id"
            type="button"
            class="merge-page-item"
            :class="{ 'same-type': p.type === source.type }"
            @click="target = p"
          >
            <span class="merge-page-title" :title="p.title">{{ p.title }}</span>
            <span class="merge-type-tag">{{ typeLabel(p.type) }}</span>
          </button>
          <p v-if="!filteredPages.length" class="merge-empty">
            {{ query ? '没有匹配的页面' : '暂无可选页面' }}
          </p>
        </div>
      </div>

      <div v-else class="merge-confirm">
        <div class="merge-direction">
          <div class="merge-role">
            <span class="merge-role-tag" :class="{ absorbed: !swapped }">保留</span>
            <span class="merge-role-title">{{ swapped ? source.title : target.title }}</span>
          </div>
          <button
            type="button"
            class="merge-swap-btn"
            title="交换保留/合并方向"
            :disabled="merging"
            @click="swapped = !swapped"
          >
            <Icon name="move-diagonal" :size="15" />
            <span>交换</span>
          </button>
          <div class="merge-role">
            <span class="merge-role-tag" :class="{ absorbed: swapped }">归档</span>
            <span class="merge-role-title">{{ swapped ? target.title : source.title }}</span>
          </div>
        </div>
        <p class="merge-warning">
          <Icon name="archive" :size="13" />
          「{{ swapped ? target.title : source.title }}」将被归档，其独有内容由 AI 语义合并到「{{ swapped ? source.title : target.title }}」。
        </p>
        <button type="button" class="merge-reselect" :disabled="merging" @click="target = null; swapped = false">
          重新选择目标
        </button>
      </div>

      <p v-if="error" class="merge-error">{{ error }}</p>
    </template>

    <template #footer>
      <button class="btn ghost" :disabled="merging" @click="onClose">取消</button>
      <button
        class="btn primary"
        :disabled="!target || merging"
        @click="doMerge"
      >
        {{ merging ? '合并中…' : '确认合并' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { mergeState, closeMergeDialog } from '../lib/mergeDialog';
import { notify } from '../lib/notify';
import AppModal from './ui/AppModal.vue';
import Icon from './Icon.vue';

const app = useAppStore();

const TYPE_LABELS: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织',
  place: '地点', work: '作品', project: '产品', other: '其他',
  doc: '文档', note: '笔记',
};
function typeLabel(type: string) {
  return TYPE_LABELS[type] || '未分类';
}

const source = computed(() => mergeState.source);
const allPages = ref<any[]>([]);
const query = ref('');
const target = ref<any | null>(null);
const swapped = ref(false);
const merging = ref(false);
const error = ref('');
const searchInput = ref<HTMLInputElement>();

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase('zh-CN'));

const filteredPages = computed(() => {
  if (!source.value) return [];
  const others = allPages.value.filter((p) => p.id !== source.value!.id);
  const filtered = normalizedQuery.value
    ? others.filter((p) => p.title?.toLocaleLowerCase('zh-CN').includes(normalizedQuery.value))
    : others;
  return [...filtered].sort((a, b) => {
    const aSame = a.type === source.value!.type ? 0 : 1;
    const bSame = b.type === source.value!.type ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    return (a.title || '').localeCompare(b.title || '', 'zh-CN');
  });
});

async function loadPages() {
  try {
    const { data } = await api.get('/api/pages/list');
    allPages.value = data.pages;
  } catch { /* 保留空列表 */ }
}

function pickFirst() {
  if (filteredPages.value.length) target.value = filteredPages.value[0];
}

function onClose() {
  if (merging.value) return;
  reset();
  closeMergeDialog();
}

function reset() {
  query.value = '';
  target.value = null;
  swapped.value = false;
  error.value = '';
  allPages.value = [];
}

async function doMerge() {
  if (!target.value || !source.value || merging.value) return;
  merging.value = true;
  error.value = '';
  const keepId = swapped.value ? source.value.id : target.value.id;
  const otherId = swapped.value ? target.value.id : source.value.id;
  try {
    await api.post('/api/pages/merge', { keepId, otherId });
    notify.success(`已合并「${source.value.title}」到「${target.value.title}」`);
    app.bumpSidebar();
    reset();
    closeMergeDialog();
  } catch (e: any) {
    error.value = e.response?.data?.error || e?.message || '合并失败，请稍后重试';
  } finally {
    merging.value = false;
  }
}

watch(
  () => mergeState.open,
  async (open) => {
    if (open) {
      reset();
      await loadPages();
      await nextTick();
      searchInput.value?.focus();
    }
  },
);
</script>

<style scoped>
.merge-source {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 7px;
  background: var(--sidebar-control);
  color: var(--text-secondary);
  font-size: 13px;
}
.merge-source-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}
.merge-source-label {
  color: var(--text-faint);
  font-size: 11px;
}
.merge-type-tag {
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  color: var(--text-faint);
  font-size: 10.5px;
}

.merge-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.merge-search-field {
  position: relative;
  display: flex;
  align-items: center;
  height: 34px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--sidebar-control);
}
.merge-search-field:focus-within {
  border-color: var(--sidebar-accent);
  box-shadow: 0 0 0 3px var(--sidebar-focus-ring);
}
.search-icon {
  position: absolute;
  left: 9px;
  color: var(--text-faint);
  pointer-events: none;
}
.merge-search-field input {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: inherit;
  padding: 0 10px 0 30px;
  background: transparent;
  font-size: 13px;
  outline: none;
}
.merge-page-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.merge-page-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.merge-page-item:hover {
  background: var(--sidebar-hover);
  border-color: var(--sidebar-control-border);
  color: var(--text);
}
.merge-page-item.same-type::after {
  content: '同类型';
  margin-left: auto;
  font-size: 10px;
  color: var(--sidebar-accent);
  opacity: 0.7;
}
.merge-page-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.merge-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
}

.merge-confirm {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.merge-direction {
  display: flex;
  align-items: stretch;
  gap: 10px;
}
.merge-role {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--sidebar-control);
}
.merge-role-tag {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-faint);
}
.merge-role-tag.absorbed {
  color: var(--danger);
}
.merge-role-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.merge-swap-btn {
  align-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font-size: 10px;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}
.merge-swap-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--sidebar-hover);
}
.merge-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--warning, #f59e0b) 10%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.merge-warning :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
}
.merge-reselect {
  align-self: flex-start;
  padding: 2px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--sidebar-accent);
  font-size: 12px;
  cursor: pointer;
}
.merge-reselect:hover {
  text-decoration: underline;
}
.merge-error {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  font-size: 12px;
}
</style>
