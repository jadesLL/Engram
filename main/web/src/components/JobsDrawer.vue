<template>
  <AppModal
    :open="state.open"
    title="后台任务"
    placement="right"
    width="min(440px, 94vw)"
    @close="closeJobsDrawer"
  >
    <template #subtitle>
      <p class="jobs-sub">{{ queueSummary }}</p>
    </template>

    <!-- 失败：只列服务端判定「需要处理」的（最近 7 天、未忽略），与首页徽标同口径 -->
    <section v-if="failures.length" class="jobs-section" aria-label="失败的后台任务">
      <header class="jobs-head">
        <span class="jobs-title danger">失败</span>
        <span class="jobs-count">{{ failures.length }}</span>
      </header>
      <ul class="jobs-list">
        <li v-for="job in failures" :key="job.id" class="job-row">
          <div class="job-main">
            <p class="job-line">
              <span class="job-label">{{ job.label || '后台任务' }}</span>
              <span v-if="formatTime(job)" class="job-time">{{ formatTime(job) }}</span>
            </p>
            <p v-if="jobTarget(job)" class="job-target">{{ jobTarget(job) }}</p>
            <p class="job-error">{{ job.error || '任务失败（没有错误详情）' }}</p>
          </div>
          <button
            class="btn job-ignore"
            type="button"
            :disabled="busy"
            :aria-label="`忽略「${job.label || '后台任务'}」这条失败`"
            @click="acknowledge([job.id])"
          >
            忽略
          </button>
        </li>
      </ul>
    </section>

    <!-- 进行中：执行 / 排队 / 已停止，给出阶段与进度，避免「后台在干嘛」只能猜 -->
    <section v-if="active.length" class="jobs-section" aria-label="进行中的后台任务">
      <header class="jobs-head">
        <span class="jobs-title">进行中</span>
        <span class="jobs-count">{{ active.length }}</span>
      </header>
      <ul class="jobs-list">
        <li v-for="job in active" :key="job.id" class="job-row">
          <div class="job-main">
            <p class="job-line">
              <span class="job-label">{{ job.label || '后台任务' }}</span>
              <span class="job-time">{{ job.status === 'paused' ? '已停止' : job.stage || '执行中' }}</span>
            </p>
            <p v-if="jobTarget(job)" class="job-target">{{ jobTarget(job) }}</p>
            <p v-if="job.status === 'running' && Number(job.progress) > 0" class="job-progress">
              <span class="job-bar" aria-hidden="true"><i :style="{ width: progressWidth(job) }" /></span>
              <span>{{ Math.round(Number(job.progress) || 0) }}%</span>
            </p>
          </div>
        </li>
      </ul>
    </section>

    <AppEmptyState
      v-if="!failures.length && !active.length"
      icon="check"
      title="没有待处理的后台任务"
      hint="索引、提炼与转换都在后台跑，失败会在这里提醒。"
    />

    <p class="jobs-note">失败提醒只看最近 7 天；更早的失败已归为历史记录，不再计入首页。</p>

    <template #footer>
      <button class="btn" type="button" :disabled="busy" @click="refresh">刷新</button>
      <button v-if="failures.length" class="btn" type="button" :disabled="busy" @click="acknowledge()">
        全部忽略
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 后台任务抽屉（2026-11-22）：首页「1 项失败 · 去处理」点进来必须看到真实清单。
 *
 * 数据源就是首页已经在轮询的 `/api/jobs`（store.jobs），打开时补一次刷新：
 *  - failures：服务端已按「未忽略 + 最近 7 天」筛过，与徽标同口径；
 *  - active：pending / running / paused。
 * 「忽略」写 acknowledged_at（POST /api/jobs/acknowledge），失败行立刻消失，首页徽标同步归零。
 */
import { computed, ref, watch } from 'vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import AppModal from './ui/AppModal.vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { closeJobsDrawer, jobsDrawerState as state } from '../lib/jobsDrawer';
import { notify } from '../lib/notify';
import { formatSyncTime } from '../lib/syncStatus';

const app = useAppStore();
const busy = ref(false);

const failures = computed<any[]>(() => (app.jobs as any)?.failures || []);
const active = computed<any[]>(() => (app.jobs as any)?.active || []);

const queueSummary = computed(() => {
  const running = Number(app.jobs?.running || 0);
  const pending = Number(app.jobs?.pending || 0);
  // 手机本地服务是 /api/jobs 空桩，没有 queueRunning 字段：只有明确 false 才说「已停止」
  if (app.jobs?.queueRunning === false) return '队列已停止，任务不会自动执行';
  if (running && pending) return `执行 ${running} · 排队 ${pending}`;
  if (running) return `执行 ${running}`;
  if (pending) return `排队 ${pending}`;
  return '队列空闲';
});

function jobTarget(job: any): string {
  return String(job?.targetLabel || job?.target || job?.payload?.path || '');
}

function formatTime(job: any): string {
  return formatSyncTime(job?.updated_at || job?.run_at || job?.created_at);
}

function progressWidth(job: any): string {
  const value = Math.max(0, Math.min(100, Math.round(Number(job?.progress) || 0)));
  return `${value}%`;
}

async function refresh(): Promise<void> {
  await app.refreshJobs();
}

watch(
  () => state.open,
  (open) => {
    if (open) void refresh();
  }
);

/**
 * 忽略失败：不传 ids = 全部忽略；传了只忽略指定行。
 * 刷新失败也不影响「已忽略」的结果，下一次首页轮询会把数字带回来。
 */
async function acknowledge(ids?: number[]): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.post('/api/jobs/acknowledge', ids ? { ids } : {});
    // 成功不弹 toast：行会立即消失、首页数字同步归零，反馈已经足够；
    // 而右上角 toast 会盖住右侧抽屉的标题（2026-11-22 验收截图里发现的遮挡）。
    await refresh();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '忽略失败任务失败');
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.jobs-sub {
  margin: 5px 0 0;
  font-size: var(--fs-caption);
  color: var(--text-faint);
}

.jobs-section + .jobs-section { margin-top: 18px; }
.jobs-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 14px 0 2px;
}
.jobs-title {
  font-size: var(--font-sm);
  font-weight: 650;
  color: var(--text-secondary);
}
.jobs-title.danger { color: var(--danger); }
.jobs-count {
  font-size: var(--fs-caption);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.jobs-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.job-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 0;
  border-top: 1px solid var(--border);
}
.job-main { flex: 1; min-width: 0; }
.job-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  margin: 0;
}
.job-label {
  min-width: 0;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.job-time {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-faint);
  white-space: nowrap;
}
.job-target {
  margin: 3px 0 0;
  font-size: var(--fs-caption);
  line-height: 1.45;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.job-error {
  margin: 4px 0 0;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.job-ignore {
  flex: none;
  min-height: 30px;
  padding: 0 11px;
  font-size: var(--fs-caption);
}
.job-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 7px 0 0;
  font-size: var(--fs-caption);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.job-bar {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}
.job-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
}

.jobs-note {
  margin: 18px 0 0;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--text-faint);
}

/* 触屏：忽略是可点动作，热区抬到 40px */
@media (hover: none) and (pointer: coarse) {
  .job-ignore { min-height: 40px; }
}
</style>
