<template>
  <div class="search-view">
    <div class="search-box">
      <input
        v-model="q"
        class="search-input"
        placeholder="搜索知识库（页面 / 原始资料）…"
        autofocus
        @keydown.enter="run"
      />
      <div class="mode-switch">
        <button class="btn primary" :disabled="searching" @click="run">搜索</button>
      </div>
    </div>

    <div v-if="searching" class="search-loading muted">
      <AppSpinner :size="14" /> 正在搜索…
    </div>

    <!-- 结果列表 -->
    <div v-if="hits.length" class="hits">
      <div class="hits-head faint small">共 {{ hits.length }} 条结果</div>
      <div v-for="(h, i) in hits" :key="i" class="hit card" @click="openHit(h)">
        <div class="hit-title">
          {{ h.title }}
          <span class="tag" v-if="h.type && h.type !== 'note'">{{ h.type }}</span>
          <span class="tag" v-if="h.refType === 'file'">文件</span>
          <span class="tag tag-label" v-for="t in h.tags" :key="t" :title="`标签：${t}`">#{{ t }}</span>
        </div>
        <div class="hit-meta faint small">
          <span v-if="h.updated_at">更新于 {{ fromNow(h.updated_at) }}</span>
        </div>
        <div class="hit-snippet muted">{{ h.snippet }}</div>
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
      hint="输入关键词搜索 Wiki 页面与原始资料提取文本"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import AppSpinner from '../components/ui/AppSpinner.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import { notify } from '../lib/notify';

const route = useRoute();
const router = useRouter();

const q = ref('');
const hits = ref<any[]>([]);
const searched = ref(false);
const searching = ref(false);

async function run() {
  if (!q.value.trim() || searching.value) return;
  hits.value = [];
  searched.value = false;
  searching.value = true;
  try {
    const { data } = await api.get('/api/search', { params: { q: q.value } });
    hits.value = data.hits;
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
  max-width: 1400px;
  margin: 0 auto;
  padding: 32px 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.search-box { display: flex; gap: 10px; flex-wrap: wrap; }
.search-input { flex: 1; min-width: 240px; padding: 12px 16px; font-size: 16px; border-radius: 4px; }
.mode-switch { display: flex; gap: 6px; }
.search-loading { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: var(--font-md); }
.hits { display: flex; flex-direction: column; gap: 10px; }
.hit { cursor: pointer; transition: border-color 0.12s, box-shadow 0.12s; }
.hit:hover { border-color: var(--border-strong); box-shadow: var(--shadow); }
.hit-title { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tag-label { font-weight: 400; }
.hit-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.hit-snippet { font-size: var(--font-md); line-height: 1.6; }

@media (max-width: 768px) {
  .search-view { padding: 20px 14px; }
  .search-box { flex-direction: column; }
  .search-input { min-width: 0; }
  .mode-switch .btn { flex: 1; justify-content: center; }
}
</style>
