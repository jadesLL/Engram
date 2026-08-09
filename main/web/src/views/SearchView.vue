<template>
  <div class="search-view">
    <div class="search-box">
      <input
        v-model="q"
        class="search-input"
        placeholder="搜索知识库，或直接向 AI 提问…"
        autofocus
        @keydown.enter="run"
      />
      <div class="mode-switch">
        <button class="btn" :class="{ primary: mode === 'search' }" @click="mode = 'search'; run()">搜索</button>
        <button class="btn" :class="{ primary: mode === 'think' }" @click="mode = 'think'; run()">问 AI</button>
      </div>
    </div>

    <div v-if="mode === 'think' && searched" class="think-result">
      <span>问题已交给 Agent。</span>
      <button class="btn small" @click="app.aiDrawerOpen = true">打开助手</button>
    </div>

    <!-- 结果列表 -->
    <div v-if="hits.length" class="hits">
      <div class="hits-head faint small">
        {{ mode === 'think' ? '引用来源' : `共 ${hits.length} 条结果` }}
      </div>
      <div v-for="(h, i) in hits" :key="i" class="hit card" @click="openHit(h)">
        <div class="hit-title">
          <span class="hit-index" v-if="mode === 'think'">[{{ i + 1 }}]</span>
          {{ h.title }}
          <span class="tag" v-if="h.type && h.type !== 'note'">{{ h.type }}</span>
          <span class="tag" v-if="h.refType === 'file'">文件</span>
        </div>
        <div class="hit-meta faint small">
          <span v-for="e in h.evidence" :key="e" class="tag">{{ e }}</span>
          <span v-if="h.updated_at">更新于 {{ fromNow(h.updated_at) }}</span>
          <span v-if="h.staleDays > 180" class="stale">⚠ {{ h.staleDays }} 天未更新</span>
        </div>
        <div class="hit-snippet muted">{{ h.heading ? `#${h.heading} — ` : '' }}{{ h.snippet }}</div>
      </div>
    </div>
    <p v-else-if="mode === 'search' && searched" class="faint empty-hint">没有找到相关内容</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useAssistantStore } from '../stores/assistant';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const assistant = useAssistantStore();

const q = ref('');
const mode = ref<'search' | 'think'>('search');
const hits = ref<any[]>([]);
const searched = ref(false);

async function run() {
  if (!q.value.trim()) return;
  hits.value = [];
  searched.value = false;
  if (mode.value === 'search') {
    const { data } = await api.get('/api/search', { params: { q: q.value } });
    hits.value = data.hits;
    searched.value = true;
  } else {
    await assistant.openWith(q.value, { route: route.fullPath }, true);
    searched.value = true;
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
  max-width: 780px;
  margin: 0 auto;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.search-box { display: flex; gap: 10px; flex-wrap: wrap; }
.search-input { flex: 1; min-width: 240px; padding: 12px 16px; font-size: 16px; border-radius: 10px; }
.mode-switch { display: flex; gap: 6px; }
.think-result { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; color: var(--text-secondary); }
.hits { display: flex; flex-direction: column; gap: 10px; }
.hit { cursor: pointer; transition: border-color 0.15s; }
.hit:hover { border-color: var(--accent); }
.hit-title { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.hit-index { color: var(--accent); }
.hit-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.hit-snippet { font-size: 13px; line-height: 1.6; }
.stale { color: var(--warn); }
.empty-hint { text-align: center; padding: 40px 0; }
</style>
