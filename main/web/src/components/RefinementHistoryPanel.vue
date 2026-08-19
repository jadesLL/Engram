<template>
  <div class="refinement-history">
    <div class="panel-head">
      <div>
        <h3>提炼轨迹</h3>
        <p>每份原始资料保留一条完整轨迹，多次提炼与失败尝试合并到对应阶段。</p>
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

    <div v-if="loading && !runs.length" class="history-empty">
      <AppSpinner :size="14" /> 正在读取提炼轨迹...
    </div>
    <AppEmptyState
      v-else-if="!runs.length"
      v-tooltip="query || statusFilter ? '没有匹配的提炼记录。' : '尚无提炼记录。'"
    />
    <div v-else class="history-workspace">
      <aside class="history-list" aria-label="提炼历史记录">
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="history-run"
          :class="[run.status, { active: selectedRunId === run.id }]"
          @click="selectRun(run.id)"
        >
          <span class="run-color-bar" aria-hidden="true"></span>
          <span class="run-head">
            <strong v-tooltip.auto="run.path">{{ noteName(run.path) }}</strong>
            <span class="run-badges">
              <span class="run-state" :class="run.status">
                <span class="run-state-dot" aria-hidden="true"></span>
                {{ statusLabel(run.status) }}
              </span>
              <span v-if="run.failureCount" class="run-failure-count">{{ run.failureCount }} 次失败</span>
            </span>
          </span>
          <span class="run-path" v-tooltip.auto="run.path">{{ run.path }}</span>
          <span class="run-meta">
            <time>{{ formatDate(run.started_at) }}</time>
            <span class="meta-sep" aria-hidden="true">·</span>
            <span>{{ run.runCount }} 次提炼</span>
            <span class="meta-sep" aria-hidden="true">·</span>
            <span>{{ stageDisplayName(run.currentStage) }}</span>
          </span>
          <span class="run-progress" role="progressbar" :aria-valuenow="run.progress" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: `${run.progress}%` }"></span>
            <span class="run-progress-label">{{ run.progress }}%</span>
          </span>
        </button>
        <button
          v-if="runs.length < total"
          class="load-more"
          type="button"
          :disabled="loadingMore"
          @click="loadRuns(false)"
        >
          {{ loadingMore ? '加载中...' : `加载更多（剩余 ${total - runs.length} 条）` }}
        </button>
      </aside>

      <main class="trajectory-detail">
        <div v-if="detailLoading && !detail" class="detail-empty">
          <AppSpinner :size="14" /> 正在读取阶段明细...
        </div>
        <template v-else-if="detail">
          <header class="trajectory-head">
            <div class="trajectory-title-block">
              <div class="trajectory-title-line">
                <h4>{{ noteName(detail.run.path) }}</h4>
                <span class="run-state" :class="detail.run.status">
                  <span class="run-state-dot" aria-hidden="true"></span>
                  {{ statusLabel(detail.run.status) }}
                </span>
                <span v-if="detail.run.failureCount" class="run-failure-count">
                  {{ detail.run.failureCount }} 次失败
                </span>
              </div>
              <p v-tooltip.auto="detail.run.path">{{ detail.run.path }}</p>
            </div>
          </header>

          <!-- 概览按钮(不在蛇形线上,独立于流程图) -->
          <div class="snake-toolbar">
            <button
              type="button"
              class="snake-overview-btn"
              :class="{ active: !selectedStageId }"
              @click="selectedStageId = ''"
            >
              <strong>概览</strong>
              <span>{{ completedCount }}/{{ detail.trace.length }} 阶段完成</span>
            </button>
          </div>

          <!-- 蛇形流程:两行节点+行内引导条+行间向下箭头(纯 CSS flex,不穿过节点) -->
          <div class="snake-wrap" aria-label="提炼阶段">
            <div class="snake-flow">
              <template v-for="(row, ri) in snakeRows" :key="ri">
                <div class="snake-row" :class="{ reversed: row.reversed }">
                  <template v-for="(node, ci) in row.nodes" :key="node.id">
                    <div v-if="ci > 0" class="snake-node-gap" aria-hidden="true">
                      <span class="guide-bar"></span>
                    </div>
                    <button
                      type="button"
                      class="snake-node"
                      :class="[node.status, { active: selectedStageId === node.id }]"
                      v-tooltip="stageDisplayName(node.stage)"
                      @click="selectStage(node.id)"
                    >
                      <span class="snake-node-pill">{{ stageShortName(node.stage) }}</span>
                      <span class="snake-node-num">{{ node.index + 1 }}</span>
                    </button>
                  </template>
                </div>
                <!-- 转折行:复刻节点行的占位结构(节点宽+间隙),竖条落在行尾节点槽位中心 -->
                <div v-if="ri < snakeRows.length - 1" class="snake-turn" aria-hidden="true">
                  <template v-for="(n, ci) in row.nodes" :key="n.id">
                    <span v-if="ci > 0" class="turn-gap"></span>
                    <span v-if="ci < row.nodes.length - 1" class="turn-spacer"></span>
                  </template>
                  <span class="guide-bar vertical"></span>
                </div>
              </template>
            </div>
          </div>

          <!-- 概览 tab:关键产出汇总 + 流程进度 -->
          <section v-if="!selectedStageId" class="overview-section" aria-labelledby="overview-title">
            <dl class="stat-strip" role="list">
              <div class="stat-cell" role="listitem">
                <dt>最近提炼</dt>
                <dd>{{ formatDate(detail.run.started_at) }}</dd>
              </div>
              <div class="stat-cell" role="listitem">
                <dt>提炼次数</dt>
                <dd class="stat-num">{{ detail.run.runCount }}</dd>
              </div>
              <div class="stat-cell" :class="{ 'stat-bad': detail.run.failureCount }" role="listitem">
                <dt>失败次数</dt>
                <dd class="stat-num">{{ detail.run.failureCount }}</dd>
              </div>
              <div class="stat-cell" role="listitem">
                <dt>事实</dt>
                <dd class="stat-num">{{ detail.facts.length }}</dd>
              </div>
              <div class="stat-cell" role="listitem">
                <dt>页面贡献</dt>
                <dd class="stat-num">{{ detail.contributions.length }}</dd>
              </div>
              <div class="stat-cell" role="listitem">
                <dt>阶段进度</dt>
                <dd class="stat-num">{{ completedCount }}/{{ detail.trace.length }}</dd>
              </div>
            </dl>
            <div
              v-if="overviewFacts.length || overviewContributions.length || overviewQuestions.length"
              class="overview-body"
            >
              <div v-if="overviewFacts.length" class="overview-block">
                <h5>关键事实<span class="block-count">{{ overviewFacts.length }}</span></h5>
                <ul>
                  <li v-for="fact in overviewFacts" :key="String(fact.fact_id)">
                    <span class="ov-fact-text">{{ shortText(fact.statement, 160) }}</span>
                    <span
                      v-if="Array.isArray(fact.sources) && fact.sources.length"
                      class="ov-fact-sources"
                    >{{ fact.sources.length }} 来源</span>
                  </li>
                </ul>
              </div>
              <div v-if="overviewContributions.length" class="overview-block">
                <h5>页面贡献<span class="block-count">{{ overviewContributions.length }}</span></h5>
                <ul>
                  <li v-for="c in overviewContributions" :key="String(c.page_id)">
                    <span class="ov-contrib-title">{{ c.title || noteName(String(c.path || '')) }}</span>
                    <span class="ov-contrib-summary">{{ shortText(c.summary, 120) }}</span>
                    <span class="ov-contrib-meta">
                      <span v-if="c.active" class="ov-contrib-active">活跃</span>
                      <span class="ov-contrib-confidence">{{ Math.round((Number(c.confidence) || 0) * 100) }}%</span>
                    </span>
                  </li>
                </ul>
              </div>
              <div v-if="overviewQuestions.length" class="overview-block">
                <h5>待确认问题<span class="block-count">{{ overviewQuestions.length }}</span></h5>
                <ul>
                  <li v-for="q in overviewQuestions" :key="String(q.id)">
                    <span class="ov-question-text">{{ shortText(q.question, 140) }}</span>
                    <span class="ov-question-status" :class="String(q.status || 'open')">
                      {{ questionStatusLabel(String(q.status || 'open')) }}
                    </span>
                  </li>
                </ul>
              </div>
            </div>
            <p v-else class="overview-empty muted small">本次提炼没有产出事实、页面贡献或待确认问题。</p>
          </section>

          <!-- 阶段 tab:选中阶段的详情 + 事件明细 -->
          <section v-if="selectedStage" class="stage-inspector" aria-labelledby="stage-inspector-title">
            <div class="stage-overview">
              <div class="stage-head-line">
                <span class="stage-kicker">阶段 {{ String(selectedStageIndex + 1).padStart(2, '0') }}</span>
                <h4 id="stage-inspector-title">{{ stageDisplayName(selectedStage) }}</h4>
                <span class="stage-state-pill" :class="selectedStage.status">
                  {{ stageStatusLabel(selectedStage.status) }}
                </span>
              </div>
              <p class="stage-desc">{{ selectedStage.description }}</p>
              <div class="stage-chips">
                <span class="stage-chip"><i>事件</i>{{ selectedStageEvents.length }}</span>
                <span class="stage-chip"><i>到达</i>{{ selectedStage.attemptCount }}</span>
                <span class="stage-chip" :class="{ bad: selectedStage.failureCount }"><i>失败</i>{{ selectedStage.failureCount }}</span>
                <span class="stage-chip"><i>耗时</i>{{ formatDuration(selectedStage.durationMs) }}</span>
                <span class="stage-chip"><i>开始</i>{{ selectedStage.startedAt ? formatDate(selectedStage.startedAt) : '无记录' }}</span>
              </div>
              <p v-if="selectedStage.failureCount" class="stage-failure">
                <Icon name="activity" :size="13" />
                该阶段共有 {{ selectedStage.failureCount }} 次失败尝试,失败详情已合并到右侧事件列表。
              </p>
            </div>

            <div class="event-browser">
              <div class="event-list" role="list" aria-label="阶段事件">
                <button
                  v-for="event in selectedStageEvents"
                  :key="eventKey(event)"
                  type="button"
                  :class="{ active: selectedEventKey === eventKey(event) }"
                  @click="selectEvent(event)"
                >
                  <span class="event-kind">
                    第 {{ event.attemptNumber || 1 }} 次 · {{ event.kind === 'audit' ? '审计' : '模型' }}
                  </span>
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
                  <div class="output-head-actions">
                    <span v-if="selectedEvent.model_tag">{{ selectedEvent.model_tag }}</span>
                    <div class="output-mode" role="tablist" aria-label="输出查看方式">
                      <button
                        type="button"
                        role="tab"
                        :aria-selected="outputMode === 'summary'"
                        :class="{ active: outputMode === 'summary' }"
                        @click="outputMode = 'summary'"
                      >
                        摘要
                      </button>
                      <button
                        type="button"
                        role="tab"
                        :aria-selected="outputMode === 'raw'"
                        :class="{ active: outputMode === 'raw' }"
                        @click="outputMode = 'raw'"
                      >
                        原始数据
                      </button>
                    </div>
                  </div>
                </div>
                <div
                  v-if="selectedEvent && outputMode === 'summary' && selectedEventSummary"
                  class="human-output"
                  :class="selectedEventSummary.tone"
                >
                  <div class="human-output-title">
                    <span class="summary-mark" aria-hidden="true">
                      <Icon
                        :name="selectedEventSummary.tone === 'danger' ? 'x' : 'check'"
                        :size="13"
                        :stroke-width="2.2"
                      />
                    </span>
                    <div>
                      <strong>{{ selectedEventSummary.title }}</strong>
                      <p>{{ selectedEventSummary.description }}</p>
                    </div>
                  </div>
                  <dl v-if="selectedEventSummary.metrics.length" class="summary-metrics">
                    <div v-for="metric in selectedEventSummary.metrics" :key="metric.label">
                      <dt>{{ metric.label }}</dt>
                      <dd>{{ metric.value }}</dd>
                    </div>
                  </dl>
                  <ul v-if="selectedEventSummary.bullets.length" class="summary-bullets">
                    <li v-for="item in selectedEventSummary.bullets" :key="item">{{ item }}</li>
                  </ul>
                </div>
                <pre v-else-if="selectedEvent && outputMode === 'raw'">{{ eventContent(selectedEvent) }}</pre>
                <div v-else class="event-empty">选择一条阶段事件查看输出。</div>
              </div>
            </div>
          </section>
        </template>
        <AppEmptyState v-else v-tooltip="'选择一份原始资料查看完整轨迹。'" />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { humanError, shortText } from '../lib/ingestError';
import Icon from './Icon.vue';
import AppSpinner from './ui/AppSpinner.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import { confirmDialog } from '../lib/confirm';

type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type StageStatus = 'completed' | 'current' | 'failed' | 'pending';

interface TraceStage {
  id: string;
  label: string;
  annotation?: string;
  description: string;
  status: StageStatus;
  eventCount: number;
  attemptCount: number;
  failureCount: number;
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
  runCount: number;
  failureCount: number;
  completedCount: number;
}

interface TraceEvent {
  id: number;
  run_id?: string;
  attemptNumber?: number;
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

interface HumanSummary {
  title: string;
  description: string;
  tone: 'success' | 'neutral' | 'danger';
  metrics: Array<{ label: string; value: string }>;
  bullets: string[];
}

interface LoadOptions {
  preserveSelection?: boolean;
  silent?: boolean;
}

interface HistoryDetail {
  run: HistoryRun & {
    content_hash: string;
    commit_status: string;
    derived_status: string;
    llm_prompt_tokens?: number;
  };
  sourceVersion: Record<string, unknown> | null;
  attempts: Array<HistoryRun & { attemptNumber: number }>;
  facts: Array<Record<string, unknown>>;
  contributions: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  audit: Array<Omit<TraceEvent, 'kind'>>;
  semanticEvents: Array<Omit<TraceEvent, 'kind'>>;
  trace: TraceStage[];
}

const PAGE_SIZE = 40;

/** initialPath:从整理覆盖视图跳入时,按原始资料路径预选对应轨迹 */
const props = withDefaults(defineProps<{ initialPath?: string }>(), { initialPath: '' });

const runs = ref<HistoryRun[]>([]);
const total = ref(0);
const query = ref('');
const statusFilter = ref('');
const selectedRunId = ref('');
const detail = ref<HistoryDetail | null>(null);
const selectedStageId = ref('');
const selectedEventKey = ref('');
const outputMode = ref<'summary' | 'raw'>('summary');
const loading = ref(false);
const loadingMore = ref(false);
const detailLoading = ref(false);
const clearing = ref(false);
const error = ref('');
const notice = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollInFlight = false;

const selectedStage = computed(() =>
  detail.value?.trace.find((stage) => stage.id === selectedStageId.value) || null
);
const selectedStageIndex = computed(() =>
  detail.value?.trace.findIndex((stage) => stage.id === selectedStageId.value) ?? -1
);
const completedCount = computed(() =>
  detail.value?.trace.filter((stage) => stage.status === 'completed').length || 0
);
/** 收集某阶段的全部审计与模型事件，按时间排序 */
function eventsForStage(stageId: string): TraceEvent[] {
  if (!detail.value || !stageId) return [];
  const matches = (stage: string) => eventStageId(stage) === stageId;
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
}
const selectedStageEvents = computed<TraceEvent[]>(() => eventsForStage(selectedStageId.value));
const selectedEvent = computed(() =>
  selectedStageEvents.value.find((event) => eventKey(event) === selectedEventKey.value) || null
);
const selectedEventSummary = computed(() =>
  selectedEvent.value ? summarizeEvent(selectedEvent.value, selectedStage.value, selectedStageId.value) : null
);

/** 概览总页面：聚合本次提炼的关键统计与产出 */
const overviewStats = computed(() => {
  const d = detail.value;
  if (!d) return null;
  const totalDuration = d.trace.reduce((sum, stage) => sum + stage.durationMs, 0);
  const activeContributions = d.contributions.filter((c: any) => c.active).length;
  const openQuestions = d.questions.filter((q: any) => q.status !== 'resolved').length;
  return {
    facts: d.facts.length,
    contributions: d.contributions.length,
    activeContributions,
    openQuestions,
    runCount: d.run.runCount,
    failureCount: d.run.failureCount,
    totalDuration,
    progress: d.run.progress,
  };
});
const overviewFacts = computed(() => (detail.value?.facts || []).slice(0, 6));
const overviewContributions = computed(() => (detail.value?.contributions || []).slice(0, 6));
const overviewQuestions = computed(() =>
  (detail.value?.questions || []).filter((q: any) => q.status !== 'resolved').slice(0, 4)
);

function eventStageId(stage: string): string {
  const base = stage.replace(/^ingest-/, '').split(':')[0];
  if (['map', 'map_split', 'map_failed'].includes(base)) return 'map';
  return base;
}

function eventKey(event: TraceEvent): string {
  return `${event.kind}-${event.run_id || 'run'}-${event.id}`;
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

/** 环形图节点用中文短名:优先 annotation(候选提取/归一整理…),退回 label */
function stageShortName(stage: Pick<TraceStage, 'label' | 'annotation'>): string {
  return stage.annotation || stage.label;
}

/**
 * 水平蛇形流程:第一行从左到右,行尾垂直折返到下一行,第二行从右到左(boustrophedon)。
 * 6 在上行最右,折返后 7 在其正下方,8/9/10/11 一路向左,折线连续不回头。
 * 概览在第一行最左端(序号 0)。坐标为百分比。
 */
const SNAKE_COLS = 6;
const snakeNodes = computed(() => {
  const trace = detail.value?.trace || [];
  const count = trace.length;
  if (!count) return [];
  const cols = Math.min(SNAKE_COLS, count);
  return trace.map((stage, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const forward = row % 2 === 0;
    const effectiveCol = forward ? col : cols - 1 - col;
    return {
      id: stage.id,
      stage,
      index,
      status: stage.status,
      row,
      col: effectiveCol,
      forward,
    };
  });
});
/** 按行分组:每行节点数组+是否反向标记(供 flex row-reverse) */
const snakeRows = computed(() => {
  const nodes = snakeNodes.value;
  if (!nodes.length) return [];
  const rows: Array<{ nodes: typeof nodes; reversed: boolean }> = [];
  for (const node of nodes) {
    if (!rows[node.row]) rows[node.row] = { nodes: [], reversed: !node.forward };
    rows[node.row].nodes.push(node);
  }
  return rows.filter(Boolean).map((row) => ({
    ...row,
    // DOM 顺序就是实际流程顺序(1→6,7→11),CSS 再决定第二行视觉方向。
    nodes: [...row.nodes],
  }));
});

function questionStatusLabel(status: string): string {
  return { open: '待处理', resolved: '已解决', pending: '待确认', answered: '已回答' }[status] || status;
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
  if (event.run_id) content.runId = event.run_id;
  if (event.attemptNumber) content.attemptNumber = event.attemptNumber;
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

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function parsedOutput(event: TraceEvent): unknown {
  if (event.payload !== undefined) return event.payload;
  if (!event.output) return null;
  try {
    return JSON.parse(event.output);
  } catch {
    return event.output;
  }
}

function itemList(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  const record = objectValue(value);
  if (Array.isArray(record?.items)) return record.items.filter((item: unknown) => item && typeof item === 'object');
  if (Array.isArray(record?.candidates)) return record.candidates.filter((item: unknown) => item && typeof item === 'object');
  return [];
}

function uniqueNames(items: Array<Record<string, any>>): string[] {
  return [...new Set(items.map((item) => item.name || item.title || item.target).filter(Boolean))]
    .slice(0, 6);
}

function itemBullets(items: Array<Record<string, any>>): string[] {
  return items.slice(0, 3).map((item) => {
    const name = item.name || item.title || item.target || '未命名项目';
    const copy = item.summary || item.reason || item.statement || item.content;
    return copy ? `${name}：${shortText(copy)}` : String(name);
  });
}

function actionCounts(items: Array<Record<string, any>>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const action = String(item.action || 'unknown');
    counts[action] = (counts[action] || 0) + 1;
    return counts;
  }, {});
}

function summarizeEvent(event: TraceEvent, stage: TraceStage | null, stageId: string = selectedStageId.value): HumanSummary {
  const data = parsedOutput(event);
  const record = objectValue(data);
  const items = itemList(data);
  const stageName = stage ? stageDisplayName(stage) : event.stage;
  const metrics: HumanSummary['metrics'] = [];
  const bullets: string[] = [];
  const error = event.error || String(record?.error || '');

  if ((detail.value?.run.runCount || 0) > 1) {
    metrics.push({ label: '提炼尝试', value: `第 ${event.attemptNumber || 1} 次` });
  }

  if (error || event.status === 'failed' || event.stage.startsWith('map_failed')) {
    if (event.duration_ms) metrics.push({ label: '执行耗时', value: formatDuration(event.duration_ms) });
    metrics.push({ label: '记录类型', value: event.kind === 'audit' ? '阶段审计' : '模型调用' });
    return {
      title: `${stageName}未完成`,
      description: humanError(error || '未知错误'),
      tone: 'danger',
      metrics,
      bullets: ['后续阶段未继续执行，原始错误信息已保留。'],
    };
  }

  if (event.kind === 'semantic') {
    metrics.push({ label: '调用状态', value: event.status === 'succeeded' ? '成功' : event.status || '已完成' });
    if (event.duration_ms) metrics.push({ label: '执行耗时', value: formatDuration(event.duration_ms) });
  }

  if (stageId ==='map') {
    const factCount = items.reduce((sum, item) => sum + (Array.isArray(item.facts) ? item.facts.length : 0), 0);
    metrics.push({ label: '候选对象', value: String(items.length) });
    metrics.push({ label: '来源事实', value: String(factCount) });
    const names = uniqueNames(items);
    if (names.length) bullets.push(`识别对象：${names.join('、')}`);
    bullets.push(...itemBullets(items));
    return {
      title: `识别出 ${items.length} 个候选对象`,
      description: factCount ? `这些候选共关联 ${factCount} 条来源事实。` : '本次输出没有形成可用事实。',
      tone: 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='normalize') {
    const inputCount = Number(record?.inputCount ?? items.length);
    const outputCount = Number(record?.outputCount ?? items.length);
    const mergeCount = Array.isArray(record?.merges) ? record.merges.length : Math.max(0, inputCount - outputCount);
    metrics.push({ label: '整理前', value: String(inputCount) });
    metrics.push({ label: '整理后', value: String(outputCount) });
    metrics.push({ label: '合并重复项', value: String(mergeCount) });
    return {
      title: `候选对象整理为 ${outputCount} 项`,
      description: mergeCount ? `发现并合并了 ${mergeCount} 组重复或近似对象。` : '未发现需要合并的重复对象。',
      tone: 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='retrieve') {
    const related = String(record?.related || '');
    const lines = related.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '));
    const names = lines.map((line) => line.slice(2).split('（')[0]).filter(Boolean);
    metrics.push({ label: '关联结果', value: String(lines.length) });
    if (names.length) bullets.push(`关联页面：${[...new Set(names)].slice(0, 8).join('、')}`);
    return {
      title: `检索到 ${lines.length} 条相关知识`,
      description: lines.length ? '这些内容将用于判断新建、合并与冲突关系。' : '知识库中没有找到可用于辅助判断的相关内容。',
      tone: lines.length ? 'success' : 'neutral',
      metrics,
      bullets,
    };
  }

  if (stageId ==='plan') {
    const counts = actionCounts(items);
    const labels: Record<string, string> = {
      create: '新建',
      merge: '合并',
      review: '人工审核',
      skip: '跳过',
      unknown: '未分类',
    };
    for (const [action, count] of Object.entries(counts)) {
      metrics.push({ label: labels[action] || action, value: String(count) });
    }
    bullets.push(...itemBullets(items));
    return {
      title: `已为 ${items.length} 个对象制定处理计划`,
      description: '计划明确了每个对象应新建、合并、审核还是跳过。',
      tone: 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='critic' || stageId ==='critic_review') {
    const issues = Array.isArray(record?.issues) ? record.issues : [];
    metrics.push({ label: '审查对象', value: String(items.length) });
    metrics.push({ label: '发现问题', value: String(issues.length) });
    if (record?.skippedSecondPass) metrics.push({ label: '二次审查', value: '无需执行' });
    bullets.push(...issues.slice(0, 4).map((issue: unknown) => shortText(issue)));
    return {
      title: record?.approved === false ? '审查发现仍需修订的问题' : '审查通过',
      description: issues.length ? `共发现 ${issues.length} 个需要处理的问题。` : '计划覆盖度、证据和冲突检查均通过。',
      tone: record?.approved === false ? 'neutral' : 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='compose') {
    const charCount = items.reduce((sum, item) => sum + String(item.content || '').length, 0);
    metrics.push({ label: '生成对象', value: String(items.length) });
    metrics.push({ label: '正文字符', value: String(charCount) });
    bullets.push(...itemBullets(items));
    return {
      title: `已生成 ${items.length} 份页面内容`,
      description: '正文由已核实事实组织生成，等待后续事实验证。',
      tone: 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='questions') {
    const questions = Array.isArray(record?.questions) ? record.questions : [];
    metrics.push({ label: '待确认问题', value: String(questions.length) });
    bullets.push(...questions.slice(0, 4).map((question: any) => shortText(question.question || question)));
    return {
      title: questions.length ? `发现 ${questions.length} 个需要确认的问题` : '没有需要用户补充的问题',
      description: questions.length ? '这些问题需要补充信息后再继续处理。' : '当前事实足以继续验证和提交。',
      tone: questions.length ? 'neutral' : 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='verify') {
    const passed = items.filter((item) => item.pass === true).length;
    const unsupported = items.reduce((sum, item) => sum + (Array.isArray(item.unsupported) ? item.unsupported.length : 0), 0);
    const conflicts = items.reduce((sum, item) => sum + (Array.isArray(item.conflicts) ? item.conflicts.length : 0), 0);
    metrics.push({ label: '验证对象', value: String(items.length) });
    metrics.push({ label: '通过', value: String(passed) });
    metrics.push({ label: '无依据内容', value: String(unsupported) });
    metrics.push({ label: '冲突', value: String(conflicts) });
    return {
      title: passed === items.length ? '全部内容通过事实验证' : `${passed}/${items.length} 个对象通过验证`,
      description: unsupported || conflicts ? '存在无依据内容或事实冲突，提交时将进入保护处理。' : '生成内容均能由来源事实支持。',
      tone: unsupported || conflicts ? 'neutral' : 'success',
      metrics,
      bullets,
    };
  }

  if (stageId ==='commit') {
    const created = Number(record?.created || 0);
    const merged = Number(record?.merged || 0);
    const skipped = Number(record?.skipped || 0);
    const pending = Number(record?.pending || 0);
    metrics.push({ label: '新建页面', value: String(created) });
    metrics.push({ label: '合并页面', value: String(merged) });
    metrics.push({ label: '跳过', value: String(skipped) });
    metrics.push({ label: '待审核', value: String(pending) });
    return {
      title: `已落地 ${created + merged} 项知识更新`,
      description: pending ? `另有 ${pending} 项因证据或歧义问题进入待审核。` : '本次提炼结果已全部完成提交。',
      tone: 'success',
      metrics,
      bullets,
    };
  }

  const keys = record ? Object.keys(record) : [];
  if (keys.length) metrics.push({ label: '输出字段', value: String(keys.length) });
  return {
    title: `${stageName}已生成阶段结果`,
    description: '该阶段已完成并保留结构化输出。',
    tone: 'success',
    metrics,
    bullets,
  };
}

/** 聚合某阶段全部事件，基于最新事件生成流程图节点摘要 */
function summarizeStage(stage: TraceStage): HumanSummary | null {
  const events = eventsForStage(stage.id);
  if (!events.length) {
    if (stage.status === 'pending') return null;
    return {
      title: stageDisplayName(stage),
      description: stage.description,
      tone: 'neutral',
      metrics: [],
      bullets: [],
    };
  }
  const latest = events[events.length - 1];
  return summarizeEvent(latest, stage, stage.id);
}

/** 流程图各节点摘要，按阶段 ID 索引，避免模板中重复调用 */
const stageSummaries = computed<Record<string, HumanSummary | null>>(() => {
  const map: Record<string, HumanSummary | null> = {};
  for (const stage of detail.value?.trace || []) {
    map[stage.id] = summarizeStage(stage);
  }
  return map;
});

function selectEvent(event: TraceEvent) {
  selectedEventKey.value = eventKey(event);
  outputMode.value = 'summary';
}

function selectStage(stageId: string) {
  selectedStageId.value = stageId;
  const latest = selectedStageEvents.value[selectedStageEvents.value.length - 1];
  selectedEventKey.value = latest ? eventKey(latest) : '';
  outputMode.value = 'summary';
}

async function loadDetail(runId: string, options: LoadOptions = {}) {
  if (!options.silent) detailLoading.value = true;
  error.value = '';
  try {
    const { data } = await api.get(`/api/ingest/history/${encodeURIComponent(runId)}`);
    if (selectedRunId.value !== runId) return;

    const preservedStageId = options.preserveSelection ? selectedStageId.value : '';
    const preservedEventKey = options.preserveSelection ? selectedEventKey.value : '';
    const preservedOutputMode = outputMode.value;
    detail.value = data;

    if (preservedStageId && data.trace.some((stage: TraceStage) => stage.id === preservedStageId)) {
      selectedStageId.value = preservedStageId;
      const preservedEvent = selectedStageEvents.value.find((event) => eventKey(event) === preservedEventKey);
      const latestEvent = selectedStageEvents.value[selectedStageEvents.value.length - 1];
      selectedEventKey.value = preservedEvent
        ? preservedEventKey
        : latestEvent
          ? eventKey(latestEvent)
          : '';
      outputMode.value = preservedOutputMode;
    } else {
      // 默认选中概览;仅在运行中/失败时直接定位到该阶段(用户关心的现场)
      const preferred = data.trace.find((stage: TraceStage) => ['current', 'failed'].includes(stage.status));
      if (preferred) selectStage(preferred.id);
      else selectedStageId.value = '';
    }
  } catch (requestError: any) {
    if (selectedRunId.value === runId) {
      if (!options.silent) detail.value = null;
      error.value = requestError.response?.data?.error || '提炼轨迹读取失败。';
    }
  } finally {
    if (!options.silent) detailLoading.value = false;
  }
}

async function selectRun(runId: string) {
  if (selectedRunId.value === runId && detail.value) return;
  selectedRunId.value = runId;
  await loadDetail(runId);
}

async function loadRuns(reset: boolean, options: LoadOptions = {}) {
  if (!options.silent) {
    if (reset) loading.value = true;
    else loadingMore.value = true;
  }
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
      const previousRunId = selectedRunId.value;
      const nextId = runs.value.some((run) => run.id === selectedRunId.value)
        ? selectedRunId.value
        : runs.value[0]?.id || '';
      selectedRunId.value = nextId;
      if (nextId) {
        await loadDetail(nextId, {
          preserveSelection: options.preserveSelection && nextId === previousRunId,
          silent: options.silent,
        });
      }
      else detail.value = null;
    }
  } catch (requestError: any) {
    error.value = requestError.response?.data?.error || '提炼历史读取失败。';
  } finally {
    if (!options.silent) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadRuns(true), 260);
}

async function refresh() {
  notice.value = '';
  await loadRuns(true, { preserveSelection: true });
}

async function pollRuns() {
  if (pollInFlight || loading.value || loadingMore.value || detailLoading.value) return;
  pollInFlight = true;
  try {
    await loadRuns(true, { preserveSelection: true, silent: true });
  } finally {
    pollInFlight = false;
  }
}

async function clearHistory() {
  const ok = await confirmDialog({
    title: '清空提炼历史',
    message: '确定清空已完成、失败和已取消的提炼历史吗？知识正文、事实来源和页面贡献不会被删除。',
    confirmText: '清空',
    danger: true,
  });
  if (!ok) return;
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
  // 从整理覆盖视图跳入:按路径预选对应轨迹(在搜索框预填路径,加载后选中第一条)
  if (props.initialPath) query.value = props.initialPath;
  await loadRuns(true);
  if (props.initialPath) {
    const matched = runs.value.find((run) => run.path === props.initialPath) || runs.value[0];
    if (matched) await selectRun(matched.id);
  }
  pollTimer = setInterval(() => {
    if (runs.value.some((run) => run.status === 'running')) void pollRuns();
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
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.history-workspace {
  display: grid;
  grid-template-columns: 286px minmax(0, 1fr);
  min-height: 820px;
}

.history-list {
  max-height: 920px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-run {
  position: relative;
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  padding: 10px 12px 10px 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  transition: background 120ms ease, border-color 120ms ease;
}

.history-run:hover {
  background: var(--bg-hover);
}

.history-run.active {
  background: var(--bg);
  border-color: var(--border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

/* 状态色左边条 */
.run-color-bar {
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 6px;
  width: 3px;
  border-radius: 2px;
  background: var(--text-faint);
  opacity: 0.4;
  transition: opacity 120ms ease;
}
.history-run.active .run-color-bar,
.history-run:hover .run-color-bar { opacity: 1; }
.history-run.completed .run-color-bar { background: var(--success); }
.history-run.failed .run-color-bar { background: var(--danger); opacity: 1; }
.history-run.cancelled .run-color-bar { background: var(--text-faint); }
.history-run.running .run-color-bar { background: var(--accent); opacity: 1; }

/* 失败 run 整卡淡红底提示 */
.history-run.failed:not(.active) {
  background: color-mix(in srgb, var(--danger) 4%, transparent);
}
.history-run.failed:not(.active):hover {
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}

.run-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.history-run strong {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.run-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.run-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.run-state-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.run-failure-count {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--warn-soft);
  color: var(--warning);
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
  color: var(--text-faint);
  font-size: 10px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 10px;
  flex-wrap: wrap;
}

.meta-sep {
  color: var(--text-faint);
  user-select: none;
}

.run-progress {
  position: relative;
  display: block;
  height: 14px;
  margin-top: 2px;
  overflow: hidden;
  background: var(--bg-tertiary);
  border-radius: 7px;
}

.run-progress > span:first-child {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 7px;
  transition: width 240ms ease;
}

.history-run.completed .run-progress > span:first-child { background: var(--success); }
.history-run.failed .run-progress > span:first-child { background: var(--danger); }

.run-progress-label {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  font-size: 9px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
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
  display: flex;
  flex-direction: column;
}

/* ---------- 概览:细长条 ---------- */
.snake-toolbar {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px 18px 4px;
  background: var(--bg-secondary);
}
.snake-overview-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 22px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--bg);
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.snake-overview-btn:hover { border-color: var(--accent); }
.snake-overview-btn.active { border-color: var(--accent); background: var(--accent-soft); }
.snake-overview-btn strong { font-size: 13px; color: var(--text); }
.snake-overview-btn span { font-size: 11px; color: var(--text-faint); }

/* ---------- 蛇形流程(纯 flex,节点间引导条,不穿过节点) ---------- */
.snake-wrap {
  padding: 10px 18px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.snake-flow {
  --node-width: 108px;
  --pill-height: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
}
.snake-row {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  width: 100%;
  min-height: 58px;
  gap: 10px;
}
.snake-row.reversed { flex-direction: row-reverse; }
/* 引导条:固定短条,与 pill 垂直居中 */
.snake-node-gap {
  flex: 0 0 auto;
  width: 26px;
  height: var(--pill-height);
  display: flex;
  align-items: center;
  justify-content: center;
}
.guide-bar {
  display: block;
  width: 26px;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}
.guide-bar.vertical {
  width: 4px;
  height: 26px;
}
/* 行间转折:与节点行同构(同 flex/gap/居中),占位复刻节点槽位,竖条落在行尾节点中心 */
.snake-turn {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 10px;
  height: 26px;
  width: 100%;
}
.turn-spacer {
  flex: 0 0 var(--node-width);
  width: var(--node-width);
}
.turn-gap {
  flex: 0 0 auto;
  width: 26px;
}
.snake-turn .guide-bar.vertical {
  margin-top: -4px;
}
.snake-node {
  flex: 0 0 var(--node-width);
  width: var(--node-width);
  min-width: var(--node-width);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: none;
  border: 0;
  cursor: pointer;
  padding: 0;
}
/* 椭圆 pill 包含阶段中文名(浅底柔和配色) */
.snake-node-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: var(--pill-height);
  box-sizing: border-box;
  padding: 0 10px;
  border: 1.5px solid var(--border);
  border-radius: calc(var(--pill-height) / 2);
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  transition: border-color .15s, background .15s, color .15s, transform .15s, box-shadow .15s;
}
.snake-node:hover .snake-node-pill { transform: scale(1.06); border-color: var(--accent); }
.snake-node.completed .snake-node-pill { border-color: color-mix(in srgb, var(--success, #2e7d32) 55%, var(--border)); background: color-mix(in srgb, var(--success, #2e7d32) 8%, var(--bg)); color: color-mix(in srgb, var(--success, #2e7d32) 80%, var(--text)); }
.snake-node.failed .snake-node-pill { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); background: color-mix(in srgb, var(--danger) 8%, var(--bg)); color: color-mix(in srgb, var(--danger) 80%, var(--text)); }
.snake-node.current .snake-node-pill { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.snake-node.pending .snake-node-pill { opacity: .55; }
.snake-node.active .snake-node-pill { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
/* 序号移到下方,小字 */
.snake-node-num {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  line-height: 1;
}
.snake-node.active .snake-node-num { color: var(--accent); }
.snake-node.completed .snake-node-num { color: var(--success, #2e7d32); }
.snake-node.failed .snake-node-num { color: var(--danger); }

/* 概览区改为 tab 内容,去掉底部边框(与流程图衔接) */
.overview-section {
  border-bottom: 0;
  flex: 1;
}
.stage-inspector {
  flex: 1;
  border-top: 0;
}

.trajectory-head {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(to bottom, var(--bg), var(--bg-secondary));
}

.trajectory-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trajectory-title-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.trajectory-title-line h4 {
  flex: 1;
  min-width: 200px;
  overflow: hidden;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 顶部统计条独占一行，避免与标题挤压 */
.stat-strip {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 0;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}

.trajectory-title-block > p {
  margin: 0;
  max-width: 68ch;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  border-right: 1px solid var(--border);
  min-width: 0;
}

.stat-cell:last-child { border-right: 0; }

.stat-cell dt {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.stat-cell dd {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.stat-cell dd.stat-num {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.stat-cell.stat-bad dd.stat-num {
  color: var(--danger);
}

/* 兼容旧选择器（防止其他 dl div 仍引用） */
.trajectory-summary {
  display: grid;
  grid-template-columns: repeat(5, auto);
  gap: 18px;
  margin: 0;
}

.trajectory-summary div {
  min-width: 0;
}

.trajectory-summary dt {
  color: var(--text-faint);
  font-size: 9px;
}

.trajectory-summary dd {
  margin: 3px 0 0;
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.flow-section {
  padding: 14px 18px 16px;
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

/* ---------- 提炼概览（总页面） ---------- */
.overview-section {
  padding: 14px 18px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.overview-stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.stat-card span {
  color: var(--text-faint);
  font-size: 10px;
}

.stat-card strong {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  line-height: 1.25;
  /* 长文本（如「2 分 57 秒」）允许换行，保持完整可读 */
  overflow-wrap: anywhere;
}

.stat-card small {
  color: var(--text-faint);
  font-size: 9px;
}

.overview-body {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  margin-top: 20px;
}

.overview-block h5 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
}

.block-count {
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 9px;
  font-weight: 700;
}

.overview-block ul {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.overview-block li {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}

.ov-fact-text,
.ov-contrib-summary,
.ov-question-text {
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.ov-fact-sources {
  color: var(--accent);
  font-size: 9px;
  font-weight: 600;
}

.ov-contrib-title {
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.ov-contrib-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ov-contrib-active {
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
  color: var(--success);
  font-size: 9px;
  font-weight: 700;
}

.ov-contrib-confidence {
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.ov-question-status {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 9px;
  font-weight: 600;
}

.ov-question-status.open,
.ov-question-status.pending {
  background: color-mix(in srgb, var(--warn) 12%, var(--bg));
  color: var(--warn);
}

/* ---------- 纵向流程图 ---------- */
.flow-vertical {
  display: flex;
  flex-direction: column;
  margin: 18px 0 0;
  padding: 0;
  list-style: none;
}

.flow-card {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
}

.flow-rail {
  position: relative;
  display: flex;
  justify-content: center;
}

.flow-card:not(:last-child) .flow-rail::after {
  position: absolute;
  top: 34px;
  bottom: -6px;
  left: 50%;
  width: 2px;
  background: var(--border);
  content: "";
  transform: translateX(-50%);
}

.flow-card.completed:not(:last-child) .flow-rail::after {
  background: color-mix(in srgb, var(--success) 45%, var(--border));
}

.flow-node {
  position: relative;
  z-index: 1;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 700;
  transition: transform 150ms ease, border-color 150ms ease, background 150ms ease;
}

.flow-card.completed .flow-node {
  border-color: var(--success);
  background: var(--success);
  color: #fff;
}

.flow-card.current .flow-node {
  border-color: var(--accent);
  background: var(--bg);
  color: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent);
}

.flow-card.current .flow-node .pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: flow-pulse 1.4s ease-in-out infinite;
}

@keyframes flow-pulse {
  0%, 100% { transform: scale(0.85); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.72; }
}

.flow-card.failed .flow-node {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}

.flow-node .node-index {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.flow-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.flow-card-body:hover {
  border-color: var(--border-strong);
  background: var(--bg-secondary);
}

.flow-card.selected .flow-card-body {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 4%, var(--bg));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
}

.flow-card.failed .flow-card-body {
  border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
}

.flow-card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.flow-card-index {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}

.flow-card-head strong {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.005em;
}

.flow-card-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.flow-stage-status {
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.flow-stage-status.completed {
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
  color: var(--success);
}

.flow-stage-status.current {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--accent);
}

.flow-stage-status.failed {
  background: color-mix(in srgb, var(--danger) 10%, var(--bg));
  color: var(--danger);
}

.flow-stage-duration {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.flow-stage-fail {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 10px;
  font-weight: 600;
}

.flow-card-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.flow-card-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin: 6px 0 0;
  padding: 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.flow-card-metrics div {
  min-width: 0;
  padding: 8px 14px;
  border-right: 1px solid var(--border);
}

.flow-card-metrics div:last-child {
  border-right: 0;
}

.flow-card-metrics dt {
  color: var(--text-faint);
  font-size: 9px;
}

.flow-card-metrics dd {
  margin: 3px 0 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.flow-card-bullets {
  display: grid;
  gap: 5px;
  margin: 6px 0 0;
  padding: 0;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.5;
  list-style: none;
}

.flow-card-bullets li {
  position: relative;
  padding-left: 11px;
}

.flow-card-bullets li::before {
  position: absolute;
  top: 0.6em;
  left: 1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-faint);
  content: "";
}

.flow-card-pending {
  color: var(--text-faint);
  font-size: 10px;
  font-style: italic;
}

.stage-inspector {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  min-height: 320px;
}

.stage-overview {
  padding: 18px 22px;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}

.stage-head-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.stage-head-line h4 { margin: 0; font-size: 15px; }
.stage-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.stage-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--bg);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.stage-chip i { font-style: normal; color: var(--text-faint); font-size: 11px; }
.stage-chip.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }

.stage-kicker {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}

.stage-overview h4 {
  margin-top: 8px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.stage-overview .stage-desc {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.65;
}

.stage-overview > p:not(.stage-desc):not(.stage-failure) {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.stage-meta {
  display: grid;
  gap: 0;
  margin: 18px 0 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}

.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}

.meta-row:last-child { border-bottom: 0; }

.meta-row dt {
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 500;
}

.meta-row dd {
  margin: 0;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.meta-row dd.meta-num {
  font-size: 14px;
  font-weight: 700;
}

.meta-row.meta-bad dd {
  color: var(--danger);
}

.stage-state-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.stage-state-pill.completed {
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
  color: var(--success);
}

.stage-state-pill.current {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--accent);
}

.stage-state-pill.failed {
  background: color-mix(in srgb, var(--danger) 10%, var(--bg));
  color: var(--danger);
}

.stage-failure {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 14px;
  padding: 10px 12px;
  border-left: 3px solid var(--danger);
  border-radius: 0 6px 6px 0;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11px;
  line-height: 1.55;
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

.output-head-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.output-mode {
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}

.output-mode button {
  min-width: 58px;
  height: 24px;
  padding: 0 7px;
  border-radius: 4px;
  color: var(--text-faint);
  font-size: 9px;
}

.output-mode button.active {
  background: var(--bg-tertiary);
  color: var(--text);
  font-weight: 600;
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

.human-output {
  max-height: 340px;
  overflow-y: auto;
  padding: 16px;
}

.human-output-title {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 10px;
}

.summary-mark {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
  color: var(--success);
}

.human-output.danger .summary-mark {
  background: color-mix(in srgb, var(--danger) 10%, var(--bg));
  color: var(--danger);
}

.human-output.neutral .summary-mark {
  background: color-mix(in srgb, var(--warn) 10%, var(--bg));
  color: var(--warn);
}

.human-output-title strong {
  font-size: 13px;
}

.human-output-title p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
}

.summary-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 0;
  margin: 16px 0 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.summary-metrics div {
  min-width: 0;
  padding: 10px 8px;
  border-right: 1px solid var(--border);
}

.summary-metrics div:last-child {
  border-right: 0;
}

.summary-metrics dt {
  color: var(--text-faint);
  font-size: 9px;
}

.summary-metrics dd {
  margin: 4px 0 0;
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.summary-bullets {
  display: grid;
  gap: 7px;
  margin: 14px 0 0;
  padding: 0;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.55;
  list-style: none;
}

.summary-bullets li {
  position: relative;
  padding-left: 12px;
}

.summary-bullets li::before {
  position: absolute;
  top: 0.65em;
  left: 1px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-faint);
  content: "";
}

.event-empty {
  padding: 28px 14px;
  color: var(--text-faint);
  font-size: 10px;
  text-align: center;
}

@media (max-width: 1024px) {
  .history-workspace {
    grid-template-columns: 244px minmax(0, 1fr);
  }

  .trajectory-head {
    grid-template-columns: 1fr;
  }

  .trajectory-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    justify-content: stretch;
  }

  .overview-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .overview-body {
    grid-template-columns: 1fr;
  }

  .stage-inspector {
    grid-template-columns: 180px minmax(0, 1fr);
  }

  /* 窄容器(如整理覆盖 900px 页)回退单列,阶段详情回到底部 */
  .trajectory-detail:has(.stage-inspector) {
    grid-template-columns: minmax(0, 1fr);
  }
  .trajectory-detail > .stage-inspector {
    grid-column: 1;
    grid-row: auto;
    position: static;
    max-height: none;
    border-left: 0;
    border-top: 1px solid var(--border);
  }
}

@media (max-width: 768px) {
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
  .overview-section,
  .flow-section {
    padding-right: 16px;
    padding-left: 16px;
  }

  .overview-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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

  .event-output-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .output-head-actions {
    width: 100%;
    justify-content: space-between;
  }
}

@media (max-width: 640px) {
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

  .overview-stats {
    grid-template-columns: 1fr;
  }

  .flow-card {
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 10px;
  }
}
</style>
