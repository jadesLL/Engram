<template>
  <div class="jobs-panel card">
    <div class="jp-head">
      <b>AI 任务队列</b>
      <div class="jp-head-actions">
        <button class="icon-btn" title="清理历史" @click="clear"><Icon name="trash" :size="14" /></button>
        <button class="icon-btn" title="关闭" @click="$emit('close')"><Icon name="x" :size="14" /></button>
      </div>
    </div>

    <div class="jp-body">
      <div v-if="jobs.active.length" class="jp-group">
        <div class="jp-sub">进行中 / 等待中</div>
        <template v-for="g in groupedActive" :key="g.key">
          <div class="job-group">
            <div class="group-head small faint" :title="g.key">{{ g.label }}</div>
            <div v-for="j in g.tasks" :key="j.id" class="job-row indented">
              <span class="spinner" v-if="j.status === 'running'" />
              <span class="dot pending" v-else />
              <span class="job-label">{{ j.label }}</span>
              <span class="job-status faint small">{{ j.stage }}</span>
              <span class="job-progress small">{{ j.progress }}%</span>
            </div>
          </div>
        </template>
      </div>

      <div v-if="failedJobs.length" class="jp-group">
        <div class="jp-sub">失败</div>
        <template v-for="g in groupedFailed" :key="g.key">
          <div class="job-group">
            <div class="group-head small faint" :title="g.key">{{ g.label }}</div>
            <div v-for="j in g.tasks" :key="j.id" class="job-row failed indented">
              <span class="dot failed" />
              <span class="job-label">{{ j.label }}</span>
              <span class="job-status faint small" :title="j.error">{{ j.stage }}</span>
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
import { computed } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import Icon from './Icon.vue';

const emit = defineEmits(['close']);
const app = useAppStore();
const jobs = computed(() => app.jobs);

const failedJobs = computed(() => jobs.value.recent.filter((j: any) => j.status === 'failed'));
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
const groupedFailed = computed(() => groupByTarget(failedJobs.value));
const groupedDone = computed(() => groupByTarget(doneJobs.value));

async function retry(j: any) {
  await api.post(`/api/jobs/${j.id}/retry`);
  await app.refreshJobs();
}

async function clear() {
  await api.post('/api/jobs/clear');
  await app.refreshJobs();
}

function shortTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
.jp-head-actions { display: flex; gap: 2px; }
.icon-btn { display: flex; padding: 4px; border-radius: 5px; color: var(--text-secondary); }
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
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
.job-status { max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-progress { min-width: 32px; text-align: right; color: var(--accent); font-variant-numeric: tabular-nums; }
.job-target {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot.pending { background: var(--warn); }
.dot.failed { background: var(--danger); }
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
