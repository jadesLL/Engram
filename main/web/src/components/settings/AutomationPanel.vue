<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>自动化</h3>
        <p>安排知识库的夜间整理任务。</p>
      </div>
    </div>

    <div class="settings-group">
      <div class="setting-row">
        <div class="setting-copy">
          <strong>智能整理</strong>
          <span>按计划自动整理资料、关系和索引。</span>
        </div>
        <label class="switch-control">
          <input v-model="dreamEnabled" type="checkbox" @change="saveDream" />
          <span aria-hidden="true"></span>
          <em>{{ dreamEnabled ? '已启用' : '已停用' }}</em>
        </label>
      </div>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>运行计划</strong>
          <span>选择运行周期与时间，默认每天 03:00。</span>
        </div>
        <div class="schedule-controls">
          <select
            v-model="dreamScheduleFrequency"
            class="schedule-select"
            aria-label="智能整理 运行周期"
            @change="applyDreamSchedule"
          >
            <option v-for="option in dreamScheduleOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <select
            v-if="dreamScheduleFrequency !== 'custom'"
            v-model="dreamScheduleTime"
            class="schedule-select schedule-time-select"
            aria-label="智能整理 运行时间"
            @change="applyDreamSchedule"
          >
            <option v-for="option in dreamTimeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <input
            v-else
            v-model="dreamCron"
            class="cron-input"
            aria-label="智能整理 自定义 cron 表达式"
            @change="saveDream"
          />
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>客户梳理模式</strong>
          <span>开启信捷模式后，标记为「客户」的实体页面在整页综合时按 ACS「助力客户成功」框架组织（五看洞察 / 决策链 / 三层关系 / 行动计划 / 缺失资料）。在侧边栏给实体页加上「客户」标签即视为客户。切换不触发批量重综合，模式在下次整理客户页面时生效。</span>
        </div>
        <div class="segmented-control" role="group" aria-label="客户梳理模式">
          <button type="button" class="segmented-btn" :class="{ active: acsMode === 'standard' }" @click="setAcsMode('standard')">标准模式</button>
          <button type="button" class="segmented-btn" :class="{ active: acsMode === 'acs' }" @click="setAcsMode('acs')">信捷模式</button>
        </div>
      </div>
      <p v-if="acsModeMsg" class="setting-message acs-mode-message">{{ acsModeMsg }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';

type DreamScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

const dreamEnabled = ref(true);
const dreamCron = ref('0 3 * * *');
const dreamScheduleFrequency = ref<DreamScheduleFrequency>('daily');
const dreamScheduleTime = ref('03:00');
const acsMode = ref<'standard' | 'acs'>('standard');
const acsModeMsg = ref('');
const dreamScheduleOptions: Array<{ value: DreamScheduleFrequency; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周一' },
  { value: 'monthly', label: '每月 1 日' },
  { value: 'custom', label: '自定义' },
];
const defaultDreamTimeOptions = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? 0 : 30;
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { value, label: value };
});
const dreamTimeOptions = computed(() => {
  if (defaultDreamTimeOptions.some((option) => option.value === dreamScheduleTime.value)) {
    return defaultDreamTimeOptions;
  }
  return [...defaultDreamTimeOptions, { value: dreamScheduleTime.value, label: dreamScheduleTime.value }]
    .sort((a, b) => a.value.localeCompare(b.value));
});

async function saveDream() {
  await api.post('/api/dream/schedule', { cron: dreamCron.value, enabled: dreamEnabled.value });
}

function dreamCronFor(frequency: Exclude<DreamScheduleFrequency, 'custom'>, time: string): string {
  const [hour = '3', minute = '0'] = time.split(':');
  const clock = `${Number(minute)} ${Number(hour)}`;
  if (frequency === 'weekdays') return `${clock} * * 1-5`;
  if (frequency === 'weekly') return `${clock} * * 1`;
  if (frequency === 'monthly') return `${clock} 1 * *`;
  return `${clock} * * *`;
}

function parseDreamSchedule(cron: string): { frequency: DreamScheduleFrequency; time: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: 'custom', time: '03:00' };
  const [minute, hour, day, month, weekday] = parts;
  const minuteValue = Number(minute);
  const hourValue = Number(hour);
  const hasFixedTime = Number.isInteger(minuteValue)
    && minuteValue >= 0
    && minuteValue < 60
    && Number.isInteger(hourValue)
    && hourValue >= 0
    && hourValue < 24;
  if (!hasFixedTime || month !== '*') return { frequency: 'custom', time: '03:00' };

  const time = `${String(hourValue).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}`;
  if (day === '*' && weekday === '*') return { frequency: 'daily', time };
  if (day === '*' && weekday === '1-5') return { frequency: 'weekdays', time };
  if (day === '*' && weekday === '1') return { frequency: 'weekly', time };
  if (day === '1' && weekday === '*') return { frequency: 'monthly', time };
  return { frequency: 'custom', time };
}

async function applyDreamSchedule() {
  if (dreamScheduleFrequency.value === 'custom') return;
  dreamCron.value = dreamCronFor(dreamScheduleFrequency.value, dreamScheduleTime.value);
  await saveDream();
}

async function setAcsMode(mode: 'standard' | 'acs') {
  if (acsMode.value === mode) return;
  const prev = acsMode.value;
  acsMode.value = mode;
  acsModeMsg.value = '';
  try {
    const { data } = await api.put('/api/settings', { acs_mode: mode });
    if (data?.acsModeChanged) {
      acsModeMsg.value = `已切换为${mode === 'acs' ? '信捷' : '标准'}模式，下次整理客户页面时生效`;
    }
  } catch {
    acsMode.value = prev;
    acsModeMsg.value = '保存失败，已还原';
  }
}

onMounted(async () => {
  const [{ data }, { data: dreamData }] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/dream/reports?status=open'),
  ]);
  dreamEnabled.value = dreamData.enabled;
  dreamCron.value = dreamData.cron || '0 3 * * *';
  const schedule = parseDreamSchedule(dreamCron.value);
  dreamScheduleFrequency.value = schedule.frequency;
  dreamScheduleTime.value = schedule.time;
  acsMode.value = data.settings.acs_mode === 'acs' ? 'acs' : 'standard';
});
</script>

<style scoped>
.schedule-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 270px;
}
.schedule-select {
  width: 132px;
}
.schedule-time-select {
  width: 104px;
  font-variant-numeric: tabular-nums;
}
.schedule-controls .cron-input {
  width: 170px;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
}

@media (max-width: 768px) {
  .schedule-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    width: 100%;
  }
  .schedule-select,
  .schedule-controls .cron-input {
    width: 100%;
  }
}

.acs-mode-message {
  margin: -10px 24px 14px;
}
</style>
