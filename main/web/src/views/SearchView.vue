<template>
  <div class="search-view">
    <!-- 命令面板式搜索盒：输入框与按钮合并为一个整体 -->
    <div class="search-box" :class="{ focused: boxFocused }">
      <Icon name="search" :size="17" class="search-box-icon" />
      <input
        v-model="q"
        class="search-input"
        placeholder="搜索知识库（页面 / 原始资料）…"
        autofocus
        @focus="boxFocused = true"
        @blur="boxFocused = false"
        @keydown.enter="run"
      />
      <button class="search-go" :disabled="searching" @click="run">搜索</button>
    </div>

    <!-- 范围筛选 -->
    <div class="filter-chips" role="radiogroup" aria-label="搜索范围">
      <button
        v-for="option in scopeOptions"
        :key="option.value"
        type="button"
        role="radio"
        :aria-checked="scope === option.value"
        :class="{ on: scope === option.value }"
        @click="scope = option.value"
      >{{ option.label }}</button>
    </div>

    <div v-if="searching" class="search-loading muted">
      <AppSpinner :size="14" /> 正在搜索…
    </div>

    <!-- 结果列表 -->
    <div v-if="filteredHits.length" class="hits">
      <div class="hits-head faint small">共 {{ filteredHits.length }} 条结果 · 用时 {{ elapsedMs }}ms</div>
      <div v-for="(h, i) in filteredHits" :key="i" class="hit" @click="openHit(h)">
        <div class="hit-title">
          <span class="hit-name">{{ h.title }}</span>
          <span v-if="h.refType === 'file'" class="hit-badge file">原始资料</span>
          <span v-else-if="h.type && h.type !== 'note'" class="hit-badge">{{ typeLabel(h.type) }}</span>
          <span v-if="h.updated_at" class="hit-time">更新于 {{ fromNow(h.updated_at) }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="hit-snippet" v-html="snippetHtml(h.snippet)"></div>
        <div v-if="h.tags?.length" class="hit-tags">
          <span v-for="t in h.tags" :key="t">#{{ t }}</span>
        </div>
      </div>
    </div>
    <AppEmptyState
      v-else-if="searched"
      icon="search"
      title="没有找到相关内容"
      hint="换个关键词试试；深度问答与提炼交给你的外部 Agent（MCP search 工具 / engram search）"
    />
    <AppEmptyState
      v-else-if="!searching"
      icon="search"
      title="搜索知识库"
      hint="输入关键词搜索 Wiki 页面与原始资料提取文本，回车即搜"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import AppSpinner from '../components/ui/AppSpinner.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import Icon from '../components/Icon.vue';
import { notify } from '../lib/notify';

const route = useRoute();
const router = useRouter();

const q = ref('');
const hits = ref<any[]>([]);
const searched = ref(false);
const searching = ref(false);
const boxFocused = ref(false);
const elapsedMs = ref(0);
const scope = ref<'all' | 'page' | 'file'>('all');

const scopeOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'page' as const, label: '页面' },
  { value: 'file' as const, label: '原始资料' },
];

const filteredHits = computed(() =>
  scope.value === 'all' ? hits.value : hits.value.filter((h) => h.refType === scope.value)
);

const TYPE_LABELS: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织', project: '项目', other: '其他',
};
function typeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}

async function run() {
  if (!q.value.trim() || searching.value) return;
  hits.value = [];
  searched.value = false;
  searching.value = true;
  const started = performance.now();
  try {
    const { data } = await api.get('/api/search', { params: { q: q.value } });
    hits.value = data.hits;
    elapsedMs.value = Math.max(1, Math.round(performance.now() - started));
    searched.value = true;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '搜索失败，请稍后重试');
  } finally {
    searching.value = false;
  }
}

function openHit(h: any) {
  if (h.refType === 'page') router.push(`/page/${h.refId}`);
  else router.push({ path: '/page', query: { file: h.path } });
}

/* 摘要清洗：剔除 Markdown 语法符号，再对查询词做 <mark> 高亮（先转义防注入） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function cleanSnippet(s: string): string {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_~`>]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function snippetHtml(snippet: string): string {
  const cleaned = escapeHtml(cleanSnippet(snippet));
  const terms = q.value.trim().split(/\s+/).filter(Boolean).map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  if (!terms.length) return cleaned;
  return cleaned.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>');
}

function fromNow(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return '今天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

onMounted(() => {
  if (route.query.q) {
    q.value = route.query.q as string;
    run();
  }
});
</script>

<style scoped>
.search-view {
  max-width: 720px;
  margin: 0 auto;
  padding: 48px 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 命令面板式搜索盒 */
.search-box {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 6px 0 16px;
  border: 1px solid var(--control-border-strong);
  border-radius: 12px;
  background: var(--card-bg);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.search-box.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft), 0 4px 14px -4px rgba(0, 0, 0, 0.12);
}
.search-box-icon { flex: none; color: var(--text-faint); }
.search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 15px;
}
.search-input:hover, .search-input:focus { background: transparent; box-shadow: none; }
.search-go {
  flex: none;
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 600;
  transition: background 120ms ease;
}
.search-go:hover { background: var(--accent-hover); }
.search-go:disabled { opacity: 0.5; cursor: not-allowed; }

/* 范围筛选 chips */
.filter-chips { display: flex; gap: 8px; }
.filter-chips button {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 12px;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.filter-chips button:hover { border-color: var(--border-strong); color: var(--text); }
.filter-chips button.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
  font-weight: 600;
}

.search-loading { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: var(--font-md); }

/* 结果卡片 */
.hits { display: flex; flex-direction: column; gap: 10px; }
.hit {
  padding: 14px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.hit:hover { border-color: var(--accent); box-shadow: var(--shadow); }
.hit-title { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.hit-name { font-size: 14.5px; font-weight: 650; }
.hit-badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 600;
}
.hit-badge.file { background: var(--success-soft); color: var(--success); }
.hit-time { margin-left: auto; flex: none; font-size: 11px; color: var(--text-faint); }
.hit-snippet {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.65;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.hit-snippet :deep(mark) {
  background: rgba(255, 213, 79, 0.45);
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
}
html.dark .hit-snippet :deep(mark) { background: rgba(255, 213, 79, 0.3); }
.hit-tags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.hit-tags span {
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--bg-secondary);
  color: var(--text-faint);
  font-size: 11px;
}

@media (max-width: 768px) {
  .search-view { padding: 24px 14px; }
  .hit-time { display: none; }
}
</style>
