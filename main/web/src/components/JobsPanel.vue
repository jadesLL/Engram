<template>
  <div class="jobs-panel card">
    <div class="jp-head">
      <div class="jp-title">
        <b>AI 任务队列</b>
        <span class="queue-state small" :class="{ stopped: !jobs.queueRunning }">
          <span class="dot" />
          {{ jobs.queueRunning ? '运行中' : '已停止' }}
        </span>
      </div>
      <div class="jp-head-actions">
        <button class="icon-btn" title="清理历史" @click="clear"><Icon name="trash" :size="14" /></button>
        <button class="icon-btn" title="关闭" @click="$emit('close')"><Icon name="x" :size="14" /></button>
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
              <span class="spinner" v-if="j.status === 'running'" />
              <span class="dot paused" v-else-if="j.status === 'paused'" />
              <span class="dot pending" v-else />
              <span class="job-label">{{ j.label }}</span>
              <span class="job-status faint small" :title="j.detail || j.stage">{{ statusText(j) }}</span>
              <span class="job-eta faint small">{{ etaText(j) }}</span>
              <span class="job-progress small">{{ j.progress }}%</span>
              <button class="icon-btn job-cancel" title="取消任务" @click="cancel(j)">
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
              <span class="job-status faint small" :title="j.error">
                {{ j.status === 'cancelled' ? '已取消' : j.stage }}
              </span>
              <button class="btn small" @click="retry(j)">重试</button>
            </div>
          </div>
        </template>
        <p class="err-text small" v-if="failedJobs[0]?.error">{{ failedJobs[0].error }}</p>
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
import { computed, ref } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import Icon from './Icon.vue';

const emit = defineEmits(['close']);
const app = useAppStore();
const jobs = computed(() => app.jobs);
const actionPending = ref('');
const actionError = ref('');

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
  await api.post(`/api/jobs/${j.id}/retry`);
  await app.refreshJobs();
}

async function cancel(j: any) {
  await api.post(`/api/jobs/${j.id}/cancel`);
  await app.refreshJobs();
}

async function clear() {
  await api.post('/api/jobs/clear');
  await app.refreshJobs();
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
  width: 340px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  z-index: 80;
  box-shadow: var(--shadow);
  padding: 12px 14px;
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
.icon-btn { display: flex; padding: 4px; border-radius: 5px; color: var(--text-secondary); }
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
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
.jp-body { overflow-y: auto; }
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
.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  flex-shrink: 0;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.err-text { color: var(--danger); margin: 2px 0 0 17px; word-break: break-all; }
.none { padding: 4px 2px; }

@media (max-width: 768px) {
  .jobs-panel { left: 8px; right: 8px; width: auto; bottom: 60px; }
}
</style>
