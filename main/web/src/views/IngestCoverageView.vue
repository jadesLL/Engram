<template>
  <div class="coverage-view">
    <div class="coverage-head">
      <h2>整理覆盖</h2>
      <div class="head-info muted small">
        <span>共 {{ report.total }} 份原始资料</span>
        <span v-if="attentionCount" class="warn-text">· {{ attentionCount }} 份需要处理</span>
      </div>
      <div class="head-actions">
        <div class="tabs">
          <button class="btn small" :class="{ primary: tab === 'coverage' }" @click="switchTab('coverage')">总览</button>
          <button class="btn small" :class="{ primary: tab === 'history' }" @click="switchTab('history')">提炼轨迹</button>
        </div>
        <button v-if="tab === 'coverage'" class="btn primary" :disabled="retrying || !attentionCount" @click="retryAll">
          {{ retrying ? '入队中…' : attentionCount ? `一键补齐 ${attentionCount} 份` : '全部已整理' }}
        </button>
      </div>
    </div>

    <template v-if="tab === 'coverage'">
    <!-- 覆盖率总览条 -->
    <div v-if="report.total" class="coverage-bar-wrap">
      <div class="coverage-bar">
        <div
          v-for="seg in barSegments"
          :key="seg.status"
          class="bar-seg"
          :style="{ width: seg.percent + '%', background: seg.color }"
          v-tooltip="`${seg.label} ${seg.count}`"
        />
      </div>
      <div class="coverage-legend small">
        <span v-for="seg in barSegments" :key="seg.status" class="legend-item">
          <i :style="{ background: seg.color }" />{{ seg.label }} {{ seg.count }}
        </span>
      </div>
    </div>

    <!-- 需要处理 -->
    <section v-if="grouped.attention.length" class="coverage-section">
      <h3>需要处理<span class="count warn">{{ grouped.attention.length }}</span></h3>
      <div v-for="item in grouped.attention" :key="item.path" class="coverage-item" :class="item.status">
        <span class="status-badge" :data-status="item.status">{{ statusLabel(item.status) }}</span>
        <div class="item-copy">
          <b>{{ item.name }}</b>
          <span class="muted small">{{ item.path }}</span>
          <span v-if="item.error" class="error-text small">{{ item.error }}</span>
        </div>
        <div class="item-actions">
          <button class="btn small" @click="openSource(item.path)">查看</button>
          <button class="btn small primary" :disabled="retrying" @click="retryOne(item)">重新整理</button>
        </div>
      </div>
    </section>

    <!-- 进行中 -->
    <section v-if="grouped.running.length" class="coverage-section">
      <h3>进行中<span class="count dim">{{ grouped.running.length }}</span></h3>
      <div v-for="item in grouped.running" :key="item.path" class="coverage-item running">
        <span class="status-badge" data-status="running">{{ statusLabel(item.status) }}</span>
        <div class="item-copy">
          <b>{{ item.name }}</b>
          <span class="muted small">{{ item.path }}</span>
        </div>
      </div>
    </section>

    <!-- 已整理:点击查看跳转到该资料的提炼轨迹 -->
    <section v-if="grouped.ingested.length" class="coverage-section">
      <details open>
        <summary><h3>已整理<span class="count ok">{{ grouped.ingested.length }}</span></h3></summary>
        <div v-for="item in grouped.ingested" :key="item.path" class="coverage-item ingested">
          <span class="status-badge" data-status="ingested">已整理</span>
          <div class="item-copy">
            <b>{{ item.name }}</b>
            <span class="muted small">{{ item.path }}<template v-if="item.ingestedAt"> · {{ item.ingestedAt.slice(0, 10) }}</template></span>
          </div>
          <div class="item-actions">
            <button class="btn small" v-tooltip="'查看该资料的提炼轨迹'" @click="openHistory(item.path)">查看</button>
          </div>
        </div>
      </details>
    </section>

    <!-- 不支持提炼 -->
    <section v-if="grouped.unsupported.length" class="coverage-section">
      <details>
        <summary><h3>仅保存<span class="count dim">{{ grouped.unsupported.length }}</span></h3></summary>
        <div v-for="item in grouped.unsupported" :key="item.path" class="coverage-item unsupported">
          <span class="status-badge" data-status="unsupported">仅保存</span>
          <div class="item-copy">
            <b>{{ item.name }}</b>
            <span class="muted small">{{ item.path }}</span>
          </div>
          <div class="item-actions">
            <button class="btn small" @click="openSource(item.path)">查看</button>
          </div>
        </div>
      </details>
    </section>

    <p v-if="!report.total" class="faint empty-hint">原始资料目录为空,上传文件后即可整理</p>
    </template>

    <!-- 提炼轨迹 tab -->
    <div v-show="tab === 'history'" class="history-embed">
      <RefinementHistoryPanel :key="historyKey" :initial-path="historyPath" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { notify } from '../lib/notify';
import RefinementHistoryPanel from '../components/RefinementHistoryPanel.vue';

const router = useRouter();
const route = useRoute();
const app = useAppStore();
const report = ref<any>({ total: 0, counts: {}, attention: [], items: [] });
const retrying = ref(false);

/** tab:覆盖 / 提炼轨迹(整合设置里的提炼轨迹,同一入口) */
const tab = ref<'coverage' | 'history'>((route.query.tab === 'history' ? 'history' : 'coverage'));
const historyPath = ref(String(route.query.path || ''));
const historyKey = ref(0);

function switchTab(next: 'coverage' | 'history') {
  tab.value = next;
  router.replace({ query: next === 'history' ? { ...route.query, tab: 'history' } : {} });
}

/** 已整理条目「查看」→ 切到提炼轨迹 tab 并预选该资料的轨迹 */
function openHistory(path: string) {
  historyPath.value = path;
  historyKey.value++; // 强制重建面板以应用 initialPath
  tab.value = 'history';
  router.replace({ query: { tab: 'history', path } });
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  ingested: { label: '已整理', color: 'var(--success, #2e7d32)' },
  outdated: { label: '内容已变更', color: 'var(--warning)' },
  ingest_failed: { label: '整理失败', color: 'var(--danger)' },
  extract_failed: { label: '提取失败', color: 'var(--danger)' },
  extract_blocked: { label: '待配置识别', color: 'var(--text-secondary)' },
  extracting: { label: '提取中', color: 'var(--accent)' },
  running: { label: '整理中', color: 'var(--accent)' },
  pending: { label: '未整理', color: 'var(--text-secondary)' },
  unsupported: { label: '仅保存', color: 'var(--border-strong)' },
};

const attentionCount = computed(() => report.value.attention?.length || 0);

const grouped = computed(() => {
  const items: any[] = report.value.items || [];
  return {
    attention: (report.value.attention || []) as any[],
    running: items.filter((item) => ['running', 'extracting'].includes(item.status)),
    ingested: items.filter((item) => item.status === 'ingested'),
    unsupported: items.filter((item) => item.status === 'unsupported'),
  };
});

const barSegments = computed(() => {
  const order = ['ingested', 'outdated', 'ingest_failed', 'extract_failed', 'extract_blocked', 'running', 'extracting', 'pending', 'unsupported'];
  const total = report.value.total || 1;
  return order
    .map((status) => ({
      status,
      label: STATUS_META[status].label,
      color: STATUS_META[status].color,
      count: report.value.counts?.[status] || 0,
      percent: ((report.value.counts?.[status] || 0) / total) * 100,
    }))
    .filter((seg) => seg.count > 0);
});

function statusLabel(status: string) {
  return STATUS_META[status]?.label || status;
}

async function load() {
  const { data } = await api.get('/api/ingest/coverage');
  report.value = data;
}

async function retryAll() {
  retrying.value = true;
  try {
    const { data } = await api.post('/api/ingest/coverage/retry', {});
    notify.success(data.queued ? `已加入 ${data.queued} 份资料的整理队列` : '没有需要处理的资料');
    await app.refreshJobs();
    await load();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '补齐失败');
  } finally {
    retrying.value = false;
  }
}

async function retryOne(item: any) {
  retrying.value = true;
  try {
    await api.post('/api/ai/ingest', { path: item.path });
    notify.success(`已加入整理队列:${item.name}`);
    await app.refreshJobs();
    await load();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '整理失败');
  } finally {
    retrying.value = false;
  }
}

function openSource(path: string) {
  router.push({ path: '/page', query: { file: path } });
}

onMounted(load);
</script>

<style scoped>
.coverage-view { width: 100%; max-width: 900px; box-sizing: border-box; margin: 0 auto; padding: 32px 24px; }
.coverage-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.coverage-head h2 { margin: 0; }
.head-info { flex: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.warn-text { color: var(--warning); }
.head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head-actions .tabs { display: flex; gap: 4px; }
.history-embed { margin-top: 4px; }
.history-embed :deep(.refinement-history) { padding: 0; }
.coverage-bar-wrap { margin-bottom: 22px; }
.coverage-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--bg-tertiary); }
.bar-seg { height: 100%; transition: width .4s ease; }
.coverage-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; color: var(--text-secondary); }
.legend-item { display: flex; align-items: center; gap: 5px; }
.legend-item i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.coverage-section { margin-bottom: 22px; }
.coverage-section h3 { margin: 0 0 10px; display: flex; align-items: center; gap: 8px; font-size: 15px; }
.coverage-section summary { cursor: pointer; list-style: none; }
.coverage-section summary::-webkit-details-marker { display: none; }
.coverage-section summary h3 { margin: 0; }
.count { min-width: 22px; padding: 0 7px; border-radius: 11px; text-align: center; font-size: 12px; color: #fff; background: var(--accent); }
.count.warn { background: var(--warning); }
.count.ok { background: var(--success, #2e7d32); }
.count.dim { color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border); }
.coverage-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: 8px; }
.coverage-item.ingest_failed, .coverage-item.extract_failed { border-left: 3px solid var(--danger); }
.coverage-item.outdated, .coverage-item.pending { border-left: 3px solid var(--warning); }
.status-badge { flex: 0 0 auto; padding: 2px 8px; border-radius: 9px; font-size: 12px; white-space: nowrap; }
.status-badge[data-status='ingested'] { color: var(--success, #2e7d32); background: color-mix(in srgb, var(--success, #2e7d32) 12%, transparent); }
.status-badge[data-status='ingest_failed'], .status-badge[data-status='extract_failed'] { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.status-badge[data-status='outdated'], .status-badge[data-status='pending'] { color: var(--warning); background: var(--warn-soft); }
.status-badge[data-status='running'], .status-badge[data-status='extracting'] { color: var(--accent); background: var(--accent-soft); }
.status-badge[data-status='extract_blocked'], .status-badge[data-status='unsupported'] { color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border); }
.item-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.item-copy b, .item-copy span { overflow-wrap: anywhere; }
.error-text { color: var(--danger); }
.item-actions { display: flex; gap: 6px; }
.empty-hint { text-align: center; padding: 40px 0; }
@media (max-width: 640px) {
  .coverage-head { align-items: flex-start; flex-direction: column; }
  .coverage-item { align-items: flex-start; flex-direction: column; gap: 8px; }
  .item-actions { width: 100%; }
}
</style>
