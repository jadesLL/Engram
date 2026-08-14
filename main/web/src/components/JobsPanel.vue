<template>
  <div
    ref="panelRef"
    class="jobs-panel card"
    :class="{ resized: Boolean(panelHeight) }"
    :style="panelStyle"
  >
    <button
      type="button"
      class="jp-resize-handle"
      title="拖动调整面板大小，双击还原"
      aria-label="调整 AI 任务队列面板大小"
      :aria-valuetext="`${panelWidth} × ${displayPanelHeight} 像素`"
      @pointerdown="startResize"
      @dblclick="resetPanelSize"
      @keydown.left.prevent="nudgePanel(-RESIZE_STEP, 0)"
      @keydown.right.prevent="nudgePanel(RESIZE_STEP, 0)"
      @keydown.up.prevent="nudgePanel(0, RESIZE_STEP)"
      @keydown.down.prevent="nudgePanel(0, -RESIZE_STEP)"
      @keydown.home.prevent="resetPanelSize"
    >
      <Icon name="move-diagonal" :size="13" :stroke-width="1.9" />
    </button>

    <div class="jp-head">
      <div class="jp-title">
        <b>AI 任务队列</b>
        <span class="queue-state small" :class="{ stopped: !jobs.queueRunning }">
          <span class="dot" />
          {{ jobs.queueRunning ? '运行中' : '已停止' }}
        </span>
      </div>
      <div class="jp-head-actions">
        <button class="btn icon" title="清理历史" aria-label="清理历史" @click="clear"><Icon name="trash" :size="14" /></button>
        <button class="btn icon" title="关闭" aria-label="关闭任务队列" @click="$emit('close')"><Icon name="x" :size="14" /></button>
      </div>
    </div>

    <div class="jp-controls">
      <button
        type="button"
        class="btn small primary"
        :disabled="jobs.queueRunning || Boolean(actionPending)"
        @click="runQueueAction('start')"
      >
        <Icon name="play" :size="13" />
        一键启动
      </button>
      <button
        type="button"
        class="btn small danger"
        :disabled="!jobs.queueRunning || Boolean(actionPending)"
        @click="runQueueAction('stop')"
      >
        <Icon name="square" :size="12" />
        一键停止
      </button>
      <button
        type="button"
        class="btn small"
        :disabled="!jobs.failed || Boolean(actionPending)"
        @click="runQueueAction('retry-failed')"
      >
        <Icon name="rotate-right" :size="13" />
        重试失败<span v-if="jobs.failed"> {{ jobs.failed }}</span>
      </button>
    </div>
    <p v-if="actionError" class="action-error small">{{ actionError }}</p>

    <div class="jp-body">
      <div v-if="jobs.active.length" class="jp-group">
        <div class="jp-sub">进行中 / 等待中</div>
        <template v-for="g in groupedActive" :key="g.key">
          <div class="job-group">
            <div class="group-head small faint" :title="g.key">{{ g.label }}</div>
            <div v-for="j in g.tasks" :key="j.id" class="job-row indented">
              <AppSpinner v-if="j.status === 'running'" :size="11" />
              <span class="dot paused" v-else-if="j.status === 'paused'" />
              <span class="dot pending" v-else />
              <span class="job-label">{{ j.label }}</span>
              <span class="job-status faint small" :title="j.detail || j.stage">{{ statusText(j) }}</span>
              <span class="job-eta faint small">{{ etaText(j) }}</span>
              <span class="job-progress small">{{ j.progress }}%</span>
              <button class="btn icon job-cancel" title="取消任务" aria-label="取消任务" @click="cancel(j)">
                <Icon name="x" :size="12" />
              </button>
            </div>
          </div>
        </template>
      </div>

      <div v-if="stoppedJobs.length" class="jp-group">
        <div class="jp-sub">失败 / 已取消</div>
        <template v-for="g in groupedStopped" :key="g.key">
          <div class="job-group">
            <div class="group-head small faint" :title="g.key">{{ g.label }}</div>
            <div v-for="j in g.tasks" :key="j.id" class="job-row failed indented">
              <span class="dot" :class="j.status === 'failed' ? 'failed' : 'cancelled'" />
              <span class="job-label">{{ j.label }}</span>
              <span class="job-status faint small" :title="humanError(j.error || '')">
                {{ j.status === 'cancelled' ? '已取消' : j.stage }}
              </span>
              <button class="btn small" @click="retry(j)">重试</button>
            </div>
          </div>
        </template>
        <p class="err-text small" v-if="failedJobs[0]?.error">{{ humanError(failedJobs[0].error) }}</p>
      </div>

      <div class="jp-group">
        <div class="jp-sub">最近完成</div>
        <template v-for="g in groupedDone" :key="g.key">
          <div class="job-group">
            <div class="group-head small faint" :title="g.key">{{ g.label }}</div>
            <div v-for="j in g.tasks" :key="j.id" class="job-row done indented">
              <span class="dot done" />
              <span class="job-label">{{ j.label }}</span>
              <span class="faint small">{{ shortTime(j.run_at) }}</span>
            </div>
          </div>
        </template>
        <p v-if="!doneJobs.length" class="faint small none">暂无记录</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { humanError } from '../lib/ingestError';
import { useAppStore } from '../stores/app';
import Icon from './Icon.vue';
import AppSpinner from './ui/AppSpinner.vue';
import { notify } from '../lib/notify';

const emit = defineEmits(['close']);
const app = useAppStore();
const jobs = computed(() => app.jobs);
const actionPending = ref('');
const actionError = ref('');
const panelRef = ref<HTMLElement>();

const STORAGE_KEY = 'jobsPanelSize';
const DEFAULT_PANEL_WIDTH = 340;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 720;
const MIN_PANEL_HEIGHT = 260;
const PANEL_LEFT = 56;
const PANEL_BOTTOM = 16;
const PANEL_VIEWPORT_GAP = 16;
const RESIZE_STEP = 24;

type StoredPanelSize = {
  width?: number;
  height?: number;
};

function readStoredPanelSize(): StoredPanelSize {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

const storedPanelSize = readStoredPanelSize();
const viewportWidth = ref(window.innerWidth);
const viewportHeight = ref(window.innerHeight);
const panelWidth = ref(Number(storedPanelSize.width) || DEFAULT_PANEL_WIDTH);
const panelHeight = ref(Number(storedPanelSize.height) || 0);

const maxPanelWidth = computed(() =>
  Math.max(MIN_PANEL_WIDTH, Math.min(
    MAX_PANEL_WIDTH,
    viewportWidth.value - PANEL_LEFT - PANEL_VIEWPORT_GAP
  ))
);
const maxPanelHeight = computed(() =>
  Math.max(
    MIN_PANEL_HEIGHT,
    viewportHeight.value - PANEL_BOTTOM - PANEL_VIEWPORT_GAP
  )
);
const panelStyle = computed(() => ({
  width: `${panelWidth.value}px`,
  height: panelHeight.value ? `${panelHeight.value}px` : undefined,
}));
const displayPanelHeight = computed(() =>
  panelHeight.value || Math.round(panelRef.value?.getBoundingClientRect().height || MIN_PANEL_HEIGHT)
);

function clampPanelWidth(width: number) {
  return Math.min(maxPanelWidth.value, Math.max(MIN_PANEL_WIDTH, width));
}

function clampPanelHeight(height: number) {
  return Math.min(maxPanelHeight.value, Math.max(MIN_PANEL_HEIGHT, height));
}

function savePanelSize() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    width: panelWidth.value,
    ...(panelHeight.value ? { height: panelHeight.value } : {}),
  }));
}

function setPanelSize(width: number, height: number, persist = true) {
  panelWidth.value = clampPanelWidth(width);
  panelHeight.value = clampPanelHeight(height);
  if (persist) savePanelSize();
}

function currentPanelHeight() {
  return panelHeight.value
    || panelRef.value?.getBoundingClientRect().height
    || MIN_PANEL_HEIGHT;
}

function nudgePanel(widthDelta: number, heightDelta: number) {
  setPanelSize(
    panelWidth.value + widthDelta,
    currentPanelHeight() + heightDelta
  );
}

function resetPanelSize() {
  panelWidth.value = clampPanelWidth(DEFAULT_PANEL_WIDTH);
  panelHeight.value = 0;
  savePanelSize();
}

let stopActiveResize: (() => void) | null = null;

function startResize(event: PointerEvent) {
  if (window.innerWidth <= 768 || !panelRef.value) return;
  event.preventDefault();

  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const startY = event.clientY;
  const bounds = panelRef.value.getBoundingClientRect();

  handle.setPointerCapture?.(event.pointerId);
  document.body.style.cursor = 'nesw-resize';
  document.body.style.userSelect = 'none';

  const move = (moveEvent: PointerEvent) => {
    setPanelSize(
      bounds.width + moveEvent.clientX - startX,
      bounds.height + startY - moveEvent.clientY,
      false
    );
  };
  const stop = () => {
    savePanelSize();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    stopActiveResize = null;
  };

  stopActiveResize?.();
  stopActiveResize = stop;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

function syncPanelToViewport() {
  viewportWidth.value = window.innerWidth;
  viewportHeight.value = window.innerHeight;

  const nextWidth = clampPanelWidth(panelWidth.value);
  const nextHeight = panelHeight.value ? clampPanelHeight(panelHeight.value) : 0;
  if (nextWidth !== panelWidth.value || nextHeight !== panelHeight.value) {
    panelWidth.value = nextWidth;
    panelHeight.value = nextHeight;
    savePanelSize();
  }
}

onMounted(() => {
  syncPanelToViewport();
  window.addEventListener('resize', syncPanelToViewport);
  window.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  stopActiveResize?.();
  window.removeEventListener('resize', syncPanelToViewport);
  window.removeEventListener('keydown', onGlobalKeydown);
});

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

const failedJobs = computed(() => jobs.value.recent.filter((j: any) => j.status === 'failed'));
const stoppedJobs = computed(() =>
  jobs.value.recent.filter((j: any) => ['failed', 'cancelled'].includes(j.status))
);
const doneJobs = computed(() => jobs.value.recent.filter((j: any) => j.status === 'done').slice(0, 10));

type JobGroup = { key: string; label: string; tasks: any[] };

/** 按稳定目标键分组，组内按 id 升序（执行先后）。
 *  无 target 的任务（mentions/metagen 等全局任务）合并到前一个有 target 的组，
 *  因为它们是紧跟该文件的处理任务入队的（id 相邻）。 */
function groupByTarget(list: any[]): JobGroup[] {
  // 先按 id 排序，保证入队顺序
  const sorted = [...list].sort((a, b) => a.id - b.id);
  const groups: JobGroup[] = [];
  let lastKey = '';
  for (const j of sorted) {
    const key = j.targetKey || j.target || '';
    const label = j.targetLabel || j.target || key;
    if (key) {
      // 有目标：按稳定身份开组，显示名称不参与归组。
      let g = groups.find((g) => g.key === key);
      if (!g) { g = { key, label, tasks: [] }; groups.push(g); }
      g.tasks.push(j);
      lastKey = key;
    } else {
      // 无 target：并入前一个有 target 的组，否则归「全局任务」
      if (lastKey) {
        const g = groups.find((g) => g.key === lastKey);
        if (g) g.tasks.push(j);
        else groups.push({ key: '全局任务', label: '全局任务', tasks: [j] });
      } else {
        let g = groups.find((g) => g.key === '全局任务');
        if (!g) { g = { key: '全局任务', label: '全局任务', tasks: [] }; groups.push(g); }
        g.tasks.push(j);
      }
    }
  }
  return groups;
}
const groupedActive = computed(() => groupByTarget(jobs.value.active || []));
const groupedStopped = computed(() => groupByTarget(stoppedJobs.value));
const groupedDone = computed(() => groupByTarget(doneJobs.value));

async function retry(j: any) {
  try {
    await api.post(`/api/jobs/${j.id}/retry`);
    await app.refreshJobs();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '重试失败');
  }
}

async function cancel(j: any) {
  try {
    await api.post(`/api/jobs/${j.id}/cancel`);
    await app.refreshJobs();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '取消失败');
  }
}

async function clear() {
  try {
    await api.post('/api/jobs/clear');
    await app.refreshJobs();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '清理失败');
  }
}

async function runQueueAction(action: 'start' | 'stop' | 'retry-failed') {
  actionPending.value = action;
  actionError.value = '';
  try {
    const path = action === 'retry-failed' ? '/api/jobs/retry-failed' : `/api/jobs/queue/${action}`;
    await api.post(path);
    await app.refreshJobs();
  } catch (error: any) {
    actionError.value = error?.response?.data?.error || '队列操作失败';
  } finally {
    actionPending.value = '';
  }
}

function shortTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(seconds?: number) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${Math.max(1, value)} 秒`;
  const minutes = Math.ceil(value / 60);
  return `${minutes} 分钟`;
}

function statusText(job: any) {
  if (job.status === 'running') return job.stage || '执行中';
  if (job.status === 'paused') return '已停止';
  if (!jobs.value.queueRunning) return '队列已停止';
  return job.queuePosition ? `队列第 ${job.queuePosition} 位` : '等待执行';
}

function etaText(job: any) {
  const candidateCount = Array.isArray(job.payload?.candidateIds)
    ? job.payload.candidateIds.length
    : 0;
  const batch = candidateCount > 1 ? `${candidateCount} 个候选` : '';
  if (job.status === 'paused' || !jobs.value.queueRunning) {
    return [batch, '等待启动'].filter(Boolean).join(' · ');
  }
  const eta = job.status === 'running'
    ? `剩余约 ${formatDuration(job.estimatedRemainingSeconds)}`
    : `约 ${formatDuration(job.estimatedWaitSeconds)}后开始`;
  return [batch, eta].filter(Boolean).join(' · ');
}
</script>

<style scoped>
.jobs-panel {
  position: fixed;
  left: 56px;
  bottom: 16px;
  min-width: 320px;
  min-height: 0;
  max-width: calc(100vw - 72px);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  z-index: var(--z-panel);
  box-shadow: var(--shadow);
  padding: 12px 14px;
}
.jobs-panel.resized { max-height: calc(100vh - 32px); }
.jp-resize-handle {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: nesw-resize;
  color: var(--border);
  opacity: 0.6;
  outline: none;
  touch-action: none;
  z-index: 1;
  transition: opacity 0.15s, color 0.15s;
}
.jp-resize-handle:hover,
.jp-resize-handle:focus-visible {
  color: var(--text-faint);
  background: var(--bg-hover);
  opacity: 1;
}
.jp-resize-handle:focus-visible {
  box-shadow: 0 0 0 2px var(--sidebar-focus-ring);
}
.jp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 14px;
}
.jp-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.queue-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--success);
  font-weight: 500;
}
.queue-state .dot { background: var(--success); }
.queue-state.stopped { color: var(--text-faint); }
.queue-state.stopped .dot { background: var(--text-faint); }
.jp-head-actions { display: flex; gap: 2px; }
.jp-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  margin-bottom: 8px;
}
.jp-controls .btn {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding-inline: 6px;
  white-space: nowrap;
}
.action-error { margin: 0 0 8px; color: var(--danger); }
.jp-body { min-height: 0; overflow-y: auto; }
.jp-group { margin-bottom: 10px; }
.jp-sub {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 4px;
  letter-spacing: 0.03em;
}
.job-group { margin-bottom: 2px; }
.group-head {
  padding: 3px 2px 1px;
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px dashed var(--border);
  margin-bottom: 1px;
}
.job-row.indented { padding-left: 14px; }
.job-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 13px;
}
.job-label { flex-shrink: 0; color: var(--text-secondary); }
.job-status { max-width: 82px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-eta {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.job-progress { min-width: 32px; text-align: right; color: var(--accent); font-variant-numeric: tabular-nums; }
.job-cancel { flex-shrink: 0; padding: 2px; }
.job-target {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot.pending { background: var(--warn); }
.dot.paused { background: var(--text-faint); }
.dot.failed { background: var(--danger); }
.dot.cancelled { background: var(--text-faint); }
.dot.done { background: var(--success); }
.err-text { color: var(--danger); margin: 2px 0 0 17px; word-break: break-all; }
.none { padding: 4px 2px; }

@media (max-width: 768px) {
  .jobs-panel {
    left: 8px;
    right: 8px;
    width: auto !important;
    height: auto !important;
    min-width: 0;
    min-height: 0;
    max-width: none;
    max-height: calc(100vh - 76px);
    bottom: 60px;
  }
  .jp-resize-handle { display: none; }
}
</style>
