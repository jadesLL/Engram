<template>
  <div class="refinement-history">
    <div class="panel-head">
      <div>
        <h3>提炼轨迹</h3>
        <p>按笔记回看每次提炼的完整流程、阶段输出和失败位置。</p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" :disabled="loading" @click="refresh">
          <Icon name="rotate-right" :size="15" />
          刷新
        </button>
        <button class="btn danger" type="button" :disabled="clearing || !total" @click="clearHistory">
          <Icon name="trash" :size="14" />
          {{ clearing ? '清空中...' : '清空历史' }}
        </button>
      </div>
    </div>

    <div class="history-toolbar">
      <label class="history-search">
        <Icon name="search" :size="15" />
        <input v-model="query" type="search" placeholder="筛选笔记名称、路径或运行 ID" @input="scheduleSearch" />
      </label>
      <select v-model="statusFilter" aria-label="提炼状态" @change="loadRuns(true)">
        <option value="">全部状态</option>
        <option value="running">运行中</option>
        <option value="completed">已完成</option>
        <option value="failed">失败</option>
        <option value="cancelled">已取消</option>
      </select>
      <span class="history-count">{{ total }} 条记录</span>
    </div>

    <p v-if="notice" class="history-notice">{{ notice }}</p>
    <p v-if="error" class="history-error">{{ error }}</p>

    <div v-if="loading && !runs.length" class="history-empty">正在读取提炼轨迹...</div>
    <div v-else-if="!runs.length" class="history-empty">
      {{ query || statusFilter ? '没有匹配的提炼记录。' : '尚无提炼记录。' }}
    </div>
    <div v-else class="history-workspace">
      <aside class="history-list" aria-label="提炼历史记录">
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="history-run"
          :class="{ active: selectedRunId === run.id }"
          @click="selectRun(run.id)"
        >
          <span class="run-state" :class="run.status">{{ statusLabel(run.status) }}</span>
          <strong :title="run.path">{{ noteName(run.path) }}</strong>
          <span class="run-path" :title="run.path">{{ run.path }}</span>
          <span class="run-meta">
            <time>{{ formatDate(run.started_at) }}</time>
            <span>{{ stageDisplayName(run.currentStage) }}</span>
            <span>{{ run.progress }}%</span>
          </span>
          <span class="run-progress" aria-hidden="true">
            <span :style="{ width: `${run.progress}%` }"></span>
          </span>
        </button>
        <button
          v-if="runs.length < total"
          class="load-more"
          type="button"
          :disabled="loadingMore"
          @click="loadRuns(false)"
        >
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
      </aside>

      <main class="trajectory-detail">
        <div v-if="detailLoading && !detail" class="detail-empty">正在读取阶段明细...</div>
        <template v-else-if="detail">
          <header class="trajectory-head">
            <div>
              <div class="trajectory-title-line">
                <h4>{{ noteName(detail.run.path) }}</h4>
                <span class="run-state" :class="detail.run.status">{{ statusLabel(detail.run.status) }}</span>
              </div>
              <p :title="detail.run.path">{{ detail.run.path }}</p>
            </div>
            <dl class="trajectory-summary">
              <div>
                <dt>开始</dt>
                <dd>{{ formatDate(detail.run.started_at) }}</dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd>{{ runDuration(detail.run) }}</dd>
              </div>
              <div>
                <dt>事实</dt>
                <dd>{{ detail.facts.length }}</dd>
              </div>
              <div>
                <dt>页面贡献</dt>
                <dd>{{ detail.contributions.length }}</dd>
              </div>
            </dl>
          </header>

          <section class="flow-section" aria-labelledby="refinement-flow-title">
            <div class="section-title">
              <div>
                <h4 id="refinement-flow-title">完整提炼流程</h4>
                <p>点击节点查看该阶段的审计记录与模型调用。</p>
              </div>
              <span>{{ completedCount }}/{{ detail.trace.length }} 阶段完成</span>
            </div>
            <ol class="flow-track">
              <li
                v-for="(stage, index) in detail.trace"
                :key="stage.id"
                class="flow-step"
                :class="[stage.status, { selected: selectedStageId === stage.id }]"
              >
                <button type="button" @click="selectStage(stage.id)">
                  <span class="step-index">
                    <Icon v-if="stage.status === 'completed'" name="check" :size="12" :stroke-width="2.2" />
                    <Icon v-else-if="stage.status === 'failed'" name="x" :size="12" :stroke-width="2.2" />
                    <span v-else>{{ index + 1 }}</span>
                  </span>
                  <strong>{{ stageDisplayName(stage) }}</strong>
                  <small>{{ stageStatusLabel(stage.status) }}</small>
                </button>
              </li>
            </ol>
          </section>

          <section v-if="selectedStage" class="stage-inspector" aria-labelledby="stage-inspector-title">
            <div class="stage-overview">
              <span class="stage-kicker">阶段 {{ selectedStageIndex + 1 }}</span>
              <h4 id="stage-inspector-title">{{ stageDisplayName(selectedStage) }}</h4>
              <p>{{ selectedStage.description }}</p>
              <dl>
                <div>
                  <dt>状态</dt>
                  <dd>{{ stageStatusLabel(selectedStage.status) }}</dd>
                </div>
                <div>
                  <dt>事件</dt>
                  <dd>{{ selectedStageEvents.length }}</dd>
                </div>
                <div>
                  <dt>模型耗时</dt>
                  <dd>{{ formatDuration(selectedStage.durationMs) }}</dd>
                </div>
                <div>
                  <dt>开始时间</dt>
                  <dd>{{ selectedStage.startedAt ? formatDate(selectedStage.startedAt) : '无记录' }}</dd>
                </div>
              </dl>
              <p v-if="selectedStage.status === 'failed' && detail.run.error" class="stage-failure">
                {{ detail.run.error }}
              </p>
            </div>

            <div class="event-browser">
              <div class="event-list" role="list" aria-label="阶段事件">
                <button
                  v-for="event in selectedStageEvents"
                  :key="`${event.kind}-${event.id}`"
                  type="button"
                  :class="{ active: selectedEventKey === `${event.kind}-${event.id}` }"
                  @click="selectedEventKey = `${event.kind}-${event.id}`"
                >
                  <span class="event-kind">{{ event.kind === 'audit' ? '审计' : '模型' }}</span>
                  <strong>{{ event.stage }}</strong>
                  <small>
                    {{ formatDate(event.at || event.created_at) }}
                    <template v-if="event.duration_ms"> · {{ formatDuration(event.duration_ms) }}</template>
                  </small>
                </button>
                <div v-if="!selectedStageEvents.length" class="event-empty">
                  此阶段没有保留可展开的明细。
                </div>
              </div>
              <div class="event-output">
                <div v-if="selectedEvent" class="event-output-head">
                  <div>
                    <span>{{ selectedEvent.kind === 'audit' ? '阶段输出' : '模型调用' }}</span>
                    <strong>{{ selectedEvent.stage }}</strong>
                  </div>
                  <span v-if="selectedEvent.model_tag">{{ selectedEvent.model_tag }}</span>
                </div>
                <pre v-if="selectedEvent">{{ eventContent(selectedEvent) }}</pre>
                <div v-else class="event-empty">选择一条阶段事件查看输出。</div>
              </div>
            </div>
          </section>
        </template>
        <div v-else class="detail-empty">选择一条提炼记录查看完整轨迹。</div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import Icon from './Icon.vue';

type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type StageStatus = 'completed' | 'current' | 'failed' | 'pending';

interface TraceStage {
  id: string;
  label: string;
  annotation?: string;
  description: string;
  status: StageStatus;
  eventCount: number;
  durationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
}

interface HistoryRun {
  id: string;
  path: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, number>;
  error: string | null;
  currentStage: TraceStage;
  progress: number;
}

interface TraceEvent {
  id: number;
  kind: 'audit' | 'semantic';
  stage: string;
  at?: string;
  created_at?: string;
  input_hash?: string | null;
  payload?: unknown;
  model_tag?: string;
  status?: string;
  output?: string;
  error?: string;
  duration_ms?: number;
}

interface HistoryDetail {
  run: HistoryRun & {
    content_hash: string;
    commit_status: string;
    derived_status: string;
    llm_prompt_tokens?: number;
  };
  sourceVersion: Record<string, unknown> | null;
  facts: Array<Record<string, unknown>>;
  contributions: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  audit: Array<Omit<TraceEvent, 'kind'>>;
  semanticEvents: Array<Omit<TraceEvent, 'kind'>>;
  trace: TraceStage[];
}

const PAGE_SIZE = 40;
const runs = ref<HistoryRun[]>([]);
const total = ref(0);
const query = ref('');
const statusFilter = ref('');
const selectedRunId = ref('');
const detail = ref<HistoryDetail | null>(null);
const selectedStageId = ref('');
const selectedEventKey = ref('');
const loading = ref(false);
const loadingMore = ref(false);
const detailLoading = ref(false);
const clearing = ref(false);
const error = ref('');
const notice = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

const selectedStage = computed(() =>
  detail.value?.trace.find((stage) => stage.id === selectedStageId.value) || null
);
const selectedStageIndex = computed(() =>
  detail.value?.trace.findIndex((stage) => stage.id === selectedStageId.value) ?? -1
);
const completedCount = computed(() =>
  detail.value?.trace.filter((stage) => stage.status === 'completed').length || 0
);
const selectedStageEvents = computed<TraceEvent[]>(() => {
  if (!detail.value || !selectedStageId.value) return [];
  const matches = (stage: string) => eventStageId(stage) === selectedStageId.value;
  return [
    ...detail.value.audit.filter((event) => matches(event.stage)).map((event) => ({
      ...event,
      kind: 'audit' as const,
    })),
    ...detail.value.semanticEvents.filter((event) => matches(event.stage)).map((event) => ({
      ...event,
      kind: 'semantic' as const,
    })),
  ].sort((left, right) =>
    String(left.at || left.created_at).localeCompare(String(right.at || right.created_at))
  );
});
const selectedEvent = computed(() =>
  selectedStageEvents.value.find((event) => `${event.kind}-${event.id}` === selectedEventKey.value) || null
);

function eventStageId(stage: string): string {
  const base = stage.replace(/^ingest-/, '').split(':')[0];
  if (['map', 'map_split', 'map_failed'].includes(base)) return 'map';
  return base;
}

function noteName(path: string): string {
  const name = path.split('/').pop() || path;
  return name.replace(/\.[^.]+$/, '');
}

function statusLabel(status: string): string {
  return {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }[status] || status;
}

function stageStatusLabel(status: StageStatus): string {
  return {
    completed: '已完成',
    current: '当前阶段',
    failed: '失败位置',
    pending: '等待',
  }[status];
}

function stageDisplayName(stage: Pick<TraceStage, 'label' | 'annotation'>): string {
  return stage.annotation ? `${stage.label}（${stage.annotation}）` : stage.label;
}

function formatDate(value?: string | null): string {
  if (!value) return '无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDuration(ms: number): string {
  if (!ms) return '无计量';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

function runDuration(run: HistoryRun): string {
  const start = new Date(run.started_at).getTime();
  const end = new Date(run.finished_at || Date.now()).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '无记录';
  return formatDuration(Math.max(0, end - start));
}

function eventContent(event: TraceEvent): string {
  const content: Record<string, unknown> = {};
  if (event.status) content.status = event.status;
  if (event.input_hash) content.inputHash = event.input_hash;
  if (event.error) content.error = event.error;
  if (event.payload !== undefined) content.payload = event.payload;
  if (event.output) {
    try {
      content.output = JSON.parse(event.output);
    } catch {
      content.output = event.output;
    }
  }
  return JSON.stringify(content, null, 2);
}

function selectStage(stageId: string) {
  selectedStageId.value = stageId;
  const first = [
    ...(detail.value?.audit || []).filter((event) => eventStageId(event.stage) === stageId).map((event) => ({
      ...event,
      kind: 'audit' as const,
    })),
    ...(detail.value?.semanticEvents || []).filter((event) => eventStageId(event.stage) === stageId).map((event) => ({
      ...event,
      kind: 'semantic' as const,
    })),
  ][0];
  selectedEventKey.value = first ? `${first.kind}-${first.id}` : '';
}

async function loadDetail(runId: string) {
  detailLoading.value = true;
  error.value = '';
  try {
    const { data } = await api.get(`/api/ingest/history/${encodeURIComponent(runId)}`);
    detail.value = data;
    const preferred = data.trace.find((stage: TraceStage) =>
      ['current', 'failed'].includes(stage.status)
    ) || [...data.trace].reverse().find((stage: TraceStage) => stage.status === 'completed') || data.trace[0];
    selectStage(preferred.id);
  } catch (requestError: any) {
    detail.value = null;
    error.value = requestError.response?.data?.error || '提炼轨迹读取失败。';
  } finally {
    detailLoading.value = false;
  }
}

async function selectRun(runId: string) {
  if (selectedRunId.value === runId && detail.value) return;
  selectedRunId.value = runId;
  await loadDetail(runId);
}

async function loadRuns(reset: boolean) {
  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = '';
  try {
    const offset = reset ? 0 : runs.value.length;
    const { data } = await api.get('/api/ingest/history', {
      params: {
        limit: PAGE_SIZE,
        offset,
        q: query.value.trim() || undefined,
        status: statusFilter.value || undefined,
      },
    });
    runs.value = reset ? data.runs : [...runs.value, ...data.runs];
    total.value = data.total;
    if (reset) {
      const nextId = runs.value.some((run) => run.id === selectedRunId.value)
        ? selectedRunId.value
        : runs.value[0]?.id || '';
      selectedRunId.value = nextId;
      if (nextId) await loadDetail(nextId);
      else detail.value = null;
    }
  } catch (requestError: any) {
    error.value = requestError.response?.data?.error || '提炼历史读取失败。';
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadRuns(true), 260);
}

async function refresh() {
  notice.value = '';
  await loadRuns(true);
}

async function clearHistory() {
  if (!confirm('确定清空已完成、失败和已取消的提炼历史吗？知识正文、事实来源和页面贡献不会被删除。')) return;
  clearing.value = true;
  notice.value = '';
  error.value = '';
  try {
    const { data } = await api.delete('/api/ingest/history');
    notice.value = `已清空 ${data.hidden || 0} 条历史记录；运行中的提炼仍保留。`;
    selectedRunId.value = '';
    detail.value = null;
    await loadRuns(true);
  } catch (requestError: any) {
    error.value = requestError.response?.data?.error || '提炼历史清空失败。';
  } finally {
    clearing.value = false;
  }
}

onMounted(async () => {
  await loadRuns(true);
  pollTimer = setInterval(() => {
    if (runs.value.some((run) => run.status === 'running')) void loadRuns(true);
  }, 5000);
});

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer);
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.refinement-history {
  min-width: 0;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px 20px;
  border-bottom: 1px solid var(--border);
}

.panel-head h3,
.trajectory-head h4,
.section-title h4,
.stage-overview h4 {
  margin: 0;
  letter-spacing: 0;
}

.panel-head h3 {
  font-size: 17px;
}

.panel-head p,
.section-title p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-actions .btn {
  min-height: 34px;
  justify-content: center;
}

.history-toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 132px auto;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.history-search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-faint);
}

.history-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent);
}

.history-search input {
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
}

.history-toolbar select {
  width: 132px;
}

.history-count {
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}

.history-notice,
.history-error {
  margin: 0;
  padding: 9px 18px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.history-notice {
  color: var(--success);
}

.history-error,
.stage-failure {
  color: var(--danger);
}

.history-empty,
.detail-empty {
  padding: 52px 20px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

.history-workspace {
  display: grid;
  grid-template-columns: 286px minmax(0, 1fr);
  min-height: 680px;
}

.history-list {
  max-height: 780px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}

.history-run {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  text-align: left;
}

.history-run:hover {
  background: var(--bg-hover);
}

.history-run.active {
  background: var(--bg-tertiary);
  box-shadow: inset 3px 0 0 var(--accent);
}

.history-run strong,
.run-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-run strong {
  grid-row: 1;
  font-size: 12px;
}

.run-state {
  justify-self: start;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

.run-state.running {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--accent);
}

.run-state.completed {
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
  color: var(--success);
}

.run-state.failed,
.run-state.cancelled {
  background: color-mix(in srgb, var(--danger) 10%, var(--bg));
  color: var(--danger);
}

.run-path {
  grid-column: 1 / -1;
  color: var(--text-faint);
  font-size: 10px;
}

.run-meta {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 10px;
}

.run-progress {
  grid-column: 1 / -1;
  height: 2px;
  margin-top: 5px;
  overflow: hidden;
  background: var(--border);
}

.run-progress > span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.load-more {
  width: 100%;
  padding: 12px;
  color: var(--accent);
  font-size: 11px;
}

.load-more:hover {
  background: var(--bg-hover);
}

.trajectory-detail {
  min-width: 0;
  overflow: hidden;
}

.trajectory-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  padding: 20px 22px;
  border-bottom: 1px solid var(--border);
}

.trajectory-title-line {
  display: flex;
  align-items: center;
  gap: 9px;
}

.trajectory-title-line h4 {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trajectory-head > div > p {
  max-width: 68ch;
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trajectory-summary {
  display: grid;
  grid-template-columns: repeat(4, auto);
  gap: 18px;
  margin: 0;
}

.trajectory-summary div,
.stage-overview dl div {
  min-width: 0;
}

.trajectory-summary dt,
.stage-overview dt {
  color: var(--text-faint);
  font-size: 9px;
}

.trajectory-summary dd,
.stage-overview dd {
  margin: 3px 0 0;
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.flow-section {
  padding: 20px 22px 22px;
  border-bottom: 1px solid var(--border);
}

.section-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.section-title h4 {
  font-size: 13px;
}

.section-title > span {
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.flow-track {
  display: flex;
  min-width: max-content;
  margin: 20px 0 0;
  padding: 0 4px;
  list-style: none;
}

.flow-section {
  overflow-x: auto;
}

.flow-step {
  position: relative;
  width: 126px;
}

.flow-step:not(:last-child)::after {
  position: absolute;
  top: 15px;
  left: 58px;
  width: 102px;
  height: 2px;
  background: var(--border-strong);
  content: "";
}

.flow-step.completed:not(:last-child)::after {
  background: var(--success);
}

.flow-step button {
  position: relative;
  z-index: 1;
  width: 102px;
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 4px;
  color: var(--text-secondary);
  text-align: center;
}

.step-index {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 700;
}

.flow-step button strong {
  font-size: 10px;
  white-space: nowrap;
}

.flow-step button small {
  color: var(--text-faint);
  font-size: 9px;
  white-space: nowrap;
}

.flow-step.completed .step-index {
  border-color: var(--success);
  background: var(--success);
  color: #fff;
}

.flow-step.current .step-index {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 13%, transparent);
}

.flow-step.failed .step-index {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}

.flow-step.selected button strong {
  color: var(--text);
}

.flow-step.selected .step-index {
  outline: 2px solid var(--text);
  outline-offset: 3px;
}

.stage-inspector {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  min-height: 320px;
}

.stage-overview {
  padding: 20px;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}

.stage-kicker {
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}

.stage-overview h4 {
  margin-top: 5px;
  font-size: 15px;
}

.stage-overview > p {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.stage-overview dl {
  display: grid;
  gap: 12px;
  margin: 20px 0 0;
}

.stage-failure {
  padding-top: 12px;
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}

.event-browser {
  min-width: 0;
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
}

.event-list {
  max-height: 390px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.event-list button {
  width: 100%;
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 3px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  text-align: left;
}

.event-list button:hover,
.event-list button.active {
  background: var(--bg-hover);
}

.event-list button.active {
  box-shadow: inset 2px 0 0 var(--accent);
}

.event-kind {
  color: var(--accent);
  font-size: 8px;
  font-weight: 700;
}

.event-list strong {
  max-width: 100%;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-list small {
  color: var(--text-faint);
  font-size: 9px;
}

.event-output {
  min-width: 0;
  background: color-mix(in srgb, var(--bg-secondary) 62%, var(--bg));
}

.event-output-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
}

.event-output-head div {
  min-width: 0;
}

.event-output-head span {
  color: var(--text-faint);
  font-size: 9px;
}

.event-output-head strong {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-output pre {
  max-height: 340px;
  margin: 0;
  overflow: auto;
  padding: 14px;
  background: transparent;
  color: var(--text-secondary);
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.event-empty {
  padding: 28px 14px;
  color: var(--text-faint);
  font-size: 10px;
  text-align: center;
}

@media (max-width: 1080px) {
  .history-workspace {
    grid-template-columns: 244px minmax(0, 1fr);
  }

  .trajectory-head {
    grid-template-columns: 1fr;
  }

  .trajectory-summary {
    justify-content: start;
  }

  .stage-inspector {
    grid-template-columns: 180px minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .panel-head {
    align-items: stretch;
    flex-direction: column;
    padding: 18px;
  }

  .panel-actions {
    width: 100%;
  }

  .panel-actions .btn {
    flex: 1;
  }

  .history-toolbar {
    grid-template-columns: minmax(0, 1fr) 120px;
    padding: 12px;
  }

  .history-count {
    grid-column: 1 / -1;
  }

  .history-workspace {
    display: block;
  }

  .history-list {
    max-height: 300px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .trajectory-head,
  .flow-section {
    padding-right: 16px;
    padding-left: 16px;
  }

  .trajectory-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stage-inspector,
  .event-browser {
    grid-template-columns: 1fr;
  }

  .stage-overview,
  .event-list {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .stage-overview dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .event-list {
    max-height: 210px;
  }
}

@media (max-width: 480px) {
  .history-toolbar {
    grid-template-columns: 1fr;
  }

  .history-toolbar select {
    width: 100%;
  }

  .history-count {
    grid-column: auto;
  }

  .trajectory-summary {
    gap: 12px;
  }

  .section-title {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
