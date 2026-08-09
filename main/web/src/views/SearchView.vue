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

    <!-- think 模式 -->
    <div v-if="mode === 'think' && (answer || streaming)" class="think-result card">
      <div class="think-head">
        <span>AI 综合回答</span>
        <button v-if="!streaming && answer" class="btn small save-btn" @click="saveToQueries">
          {{ savedFlag ? '已保存 ✓' : '保存到查询' }}
        </button>
      </div>
      <div class="think-answer" v-html="renderMd(answer)"></div>
      <span v-if="streaming" class="cursor">▍</span>
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
    <p v-else-if="searched && !streaming" class="faint empty-hint">没有找到相关内容</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ssePost } from '../api';

const route = useRoute();
const router = useRouter();

const q = ref('');
const mode = ref<'search' | 'think'>('search');
const hits = ref<any[]>([]);
const answer = ref('');
const streaming = ref(false);
const searched = ref(false);
const savedFlag = ref(false);

/** 把本次问答保存为 Wiki/查询 下的页面 */
async function saveToQueries() {
  const title = `问答：${q.value.slice(0, 40)}`;
  const refs = hits.value.map((h, i) => `- [${i + 1}] [[${h.title}]]（${h.path}）`).join('\n');
  const content = [
    `# ${title}`,
    '',
    `> 提问时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 问题',
    '',
    q.value,
    '',
    '## 回答',
    '',
    answer.value,
    '',
    '## 引用来源',
    '',
    refs,
    '',
  ].join('\n');
  const { data } = await api.post('/api/pages', { dir: 'Wiki/查询', title });
  await api.put(`/api/pages/${data.meta.id}`, { content, title, type: 'note', tags: ['问答'] });
  savedFlag.value = true;
}

async function run() {
  if (!q.value.trim() || streaming.value) return;
  hits.value = [];
  answer.value = '';
  searched.value = false;
  savedFlag.value = false;
  if (mode.value === 'search') {
    const { data } = await api.get('/api/search', { params: { q: q.value } });
    hits.value = data.hits;
    searched.value = true;
  } else {
    streaming.value = true;
    try {
      await ssePost('/api/search/think', { q: q.value }, {
        onDelta: (d) => (answer.value += d),
        onEvent: (ev, data) => {
          if (ev === 'hits') hits.value = data.hits;
          if (ev === 'error') answer.value += `\n⚠ ${data.message}`;
        },
      });
    } catch (e: any) {
      answer.value += `\n⚠ ${e.message}`;
    } finally {
      streaming.value = false;
      searched.value = true;
    }
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

function renderMd(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>')
    .replace(/^#+\s*(.+)$/gm, '<b>$1</b>')
    .replace(/^[-*] (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
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
.think-result { line-height: 1.8; }
.think-head { font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.save-btn { font-weight: 400; }
.think-answer :deep(.cite) { color: var(--accent); font-weight: 600; }
.think-answer :deep(code) { background: var(--bg-tertiary); padding: 0 5px; border-radius: 4px; font-size: 12px; }
.cursor { animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0; } }
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
