<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>自动整理（梦境思考）</h3>
        <p>到点让内置 Agent 在后台把没提炼的原始资料整理进知识库，并做一次全库纠错；过程就是「梦境思考」这个对话，随时可点开看。</p>
      </div>
    </div>

    <SettingsGroup
      anchor="agent-dream"
      title="自动整理（梦境思考）"
      :hint="`按计划自动跑一轮：整理未提炼的资料 + 一次纠错（${status?.scheduleLabel || '未启用'}）`"
    >
      <div v-if="loaded" class="dream-status" :class="{ ok: statusOk, bad: statusBad, busy: Boolean(status?.running) }">
        <div class="dream-status-row">
          <span class="dream-dot" aria-hidden="true"></span>
          <span class="dream-status-label">{{ statusLabel }}</span>
          <button class="btn mini" type="button" @click="loadStatus">刷新</button>
        </div>
        <div v-if="nextRunText" class="dream-meta">下次运行：{{ nextRunText }}</div>
        <div v-if="lastRunText" class="dream-meta">上次运行：{{ lastRunText }}</div>
        <div v-if="status?.last?.error" class="dream-error">{{ status.last.error }}</div>
        <div v-if="status?.last?.summary" class="dream-summary">{{ status.last.summary }}</div>
        <div class="dream-meta">当前待办：{{ auditText }}</div>
      </div>

      <div class="dream-form">
        <label class="dream-switch">
          <input v-model="form.enabled" type="checkbox" />
          <span>启用梦境思考：到点自动跑一轮</span>
        </label>

        <label class="dream-field">
          <span>运行频率</span>
          <AppSelect v-model="form.frequency" aria-label="运行频率" :options="frequencyOptions" />
        </label>

        <label v-if="form.frequency === 'interval'" class="dream-field">
          <span>间隔天数</span>
          <input v-model.number="form.intervalDays" type="number" min="1" max="30" step="1" />
        </label>

        <label class="dream-field">
          <span>运行时间</span>
          <input v-model="form.time" type="time" step="60" />
        </label>
      </div>

      <div class="dream-actions">
        <button class="btn primary small" type="button" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button v-if="!status?.running" class="btn small" type="button" :disabled="starting" @click="runNow">
          {{ starting ? '正在发起…' : '立即执行一次' }}
        </button>
        <button v-else class="btn small" type="button" :disabled="stopping" @click="stop">
          {{ stopping ? '正在停止…' : '停止' }}
        </button>
        <button v-if="status?.sessionId" class="btn small" type="button" @click="openConversation">
          查看过程与结果
        </button>
      </div>

      <p class="faint small dream-note">
        跑的是内置 Agent：只经 MCP 工具读写知识库，写入仍受证据门禁约束，删除只入回收站。没有待整理资料也没有待核查问题时，
        到点只做一次检查就跳过，不消耗模型额度。运行过程与结论都留在「梦境思考」对话里，可在左栏 ✨ 聊天抽屉查看。
        多端同步群组只在一台设备开启（配置按设备保存）。
      </p>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { useChatStore } from '../../stores/chat';
import { useAppStore } from '../../stores/app';
import SettingsGroup from './SettingsGroup.vue';
import AppSelect from '../ui/AppSelect.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';

/**
 * 梦境思考的设置面板：开关 + 每天/每隔 N 天 + 时间点，以及上次结果与当前待办。
 *
 * 排期口径全在服务端（server/src/assistant/dreamConfig.ts）：界面只把「下次运行」原样显示，
 * 不做第二套推算，避免两边说法不一致。状态每 30 秒轮询一次（与 DDNS 面板同档）。
 */

type Frequency = 'daily' | 'interval';

interface DreamConfigDto {
  enabled: boolean;
  frequency: Frequency;
  time: string;
  intervalDays: number;
}

interface DreamStatusResp {
  config: DreamConfigDto;
  scheduleLabel: string;
  nextRunAt: string;
  due: boolean;
  running: boolean;
  runId: string;
  sessionId: string;
  agentReady: boolean;
  audit: {
    pendingFiles: number;
    pendingUnreadable: number;
    deadLinks: number;
    duplicates: number;
    outdatedPages: number;
  };
  before: { pendingFiles: number; issues: number };
  last: { at: string; trigger: string; status: string; error: string; summary: string; runId: string };
}

const frequencyOptions: Array<{ value: Frequency; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'interval', label: '每隔 N 天' },
];

const form = reactive<DreamConfigDto>({ enabled: false, frequency: 'daily', time: '03:00', intervalDays: 1 });
const stored = reactive<DreamConfigDto>({ ...form });
const status = ref<DreamStatusResp | null>(null);
const loaded = ref(false);
const saving = ref(false);
const starting = ref(false);
const stopping = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const chat = useChatStore();
const app = useAppStore();

/** 表单有没有改过（没改时「保存」不可点） */
const dirty = computed(() => (
  form.enabled !== stored.enabled
  || form.frequency !== stored.frequency
  || form.time !== stored.time
  || Number(form.intervalDays) !== Number(stored.intervalDays)
));

const statusOk = computed(() => Boolean(status.value?.config.enabled && status.value?.agentReady && !status.value?.last?.error));
const statusBad = computed(() => Boolean(status.value?.last?.status === 'failed' || (status.value?.config.enabled && !status.value?.agentReady)));

const statusLabel = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (s.running) return '正在运行：内置 Agent 正在整理与纠错';
  if (!s.agentReady) return '待配置：内置 Agent 还没配模型凭据（在「内置 Agent」分组填 Key）';
  if (!s.config.enabled) return '已停用（不会自动运行）';
  const last = s.last.status;
  if (last === 'completed') return '已启用，上次运行完成';
  if (last === 'failed') return '已启用，上次运行失败';
  if (last === 'skipped') return '已启用，上次检查没有待办，已跳过';
  if (last === 'cancelled') return '已启用，上次运行被停止';
  return '已启用，等待计划时间';
});

const nextRunText = computed(() => {
  const s = status.value;
  if (!s || !s.config.enabled || !s.nextRunAt) return '';
  return `${formatNext(s.nextRunAt)}${s.due ? '（已到时间，马上开跑）' : ''}`;
});

const lastRunText = computed(() => {
  const s = status.value;
  if (!s?.last?.at) return '';
  const trigger = s.last.trigger === 'manual' ? '手动触发' : '计划触发';
  return `${formatStamp(s.last.at)} · ${trigger}`;
});

const auditText = computed(() => {
  const s = status.value;
  if (!s) return '';
  const issues = s.audit.deadLinks + s.audit.duplicates + s.audit.outdatedPages;
  const unreadable = s.audit.pendingUnreadable > 0 ? `（其中 ${s.audit.pendingUnreadable} 份等提取完成）` : '';
  return `待提炼 ${s.audit.pendingFiles} 份${unreadable} · 待核查 ${issues} 处（死链 ${s.audit.deadLinks} · 疑似重复 ${s.audit.duplicates} · 规则落后 ${s.audit.outdatedPages}）`;
});

/** 二级导航徽标：正在跑 / 待配凭据 */
useSettingsBadge('agent-dream', computed(() => {
  if (status.value?.running) return '运行中';
  if (status.value?.config.enabled && status.value && !status.value.agentReady) return '待配置';
  return '';
}));

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 计划时刻：今天/明天/昨天说人话，更远给日期 */
function formatNext(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((dayStart(at) - dayStart(new Date())) / 86_400_000);
  if (diffDays === 0) return `今天 ${clock}`;
  if (diffDays === 1) return `明天 ${clock}`;
  if (diffDays === -1) return `昨天 ${clock}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/** 历史时刻：完整日期时间（上次运行可能隔了好几天） */
function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function applyStatus(data: DreamStatusResp): void {
  status.value = data;
  // 用户正在改表单时不要被轮询覆盖（保存成功后会按服务端归一化结果回填）
  if (!dirty.value) {
    Object.assign(form, data.config);
    Object.assign(stored, data.config);
  }
}

async function loadStatus(): Promise<void> {
  try {
    const { data } = await api.get('/api/assistant/dream');
    applyStatus(data as DreamStatusResp);
  } catch (error) {
    console.error('加载梦境思考状态失败', error);
  } finally {
    loaded.value = true;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const payload = {
      enabled: form.enabled,
      frequency: form.frequency,
      time: form.time,
      intervalDays: Math.min(30, Math.max(1, Math.floor(Number(form.intervalDays) || 1))),
    };
    const { data } = await api.put('/api/assistant/dream', payload);
    const next = data as DreamStatusResp;
    status.value = next;
    // 以服务端归一化结果为准回填（间隔天数会被收敛到 1~30、时间会规范化成 HH:MM）
    Object.assign(form, next.config);
    Object.assign(stored, next.config);
    notify.success(next.config.enabled ? `已保存：${next.scheduleLabel}` : '已保存：梦境思考已停用');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function runNow(): Promise<void> {
  starting.value = true;
  try {
    await api.post('/api/assistant/dream/run', {});
    notify.success('已发起一轮梦境思考，可在「查看过程与结果」里看进度');
    await loadStatus();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '发起失败');
    await loadStatus();
  } finally {
    starting.value = false;
  }
}

async function stop(): Promise<void> {
  stopping.value = true;
  try {
    await api.post('/api/assistant/dream/stop', {});
    notify.success('已停止本轮');
    await loadStatus();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '停止失败');
  } finally {
    stopping.value = false;
  }
}

/** 打开聊天抽屉并定位到梦境思考会话：过程、工具卡与小结都在那儿 */
async function openConversation(): Promise<void> {
  const sessionId = status.value?.sessionId;
  if (!sessionId) return;
  try {
    await chat.loadSessions();
    await chat.selectSession(sessionId);
    app.toggleChat(true);
  } catch (error) {
    console.error(error);
    notify.error('暂时打不开梦境思考对话');
  }
}

onMounted(async () => {
  await loadStatus();
  pollTimer = setInterval(() => void loadStatus(), 30_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<style scoped>
.dream-status {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.7;
}
.dream-status.ok { border-color: var(--success, #3fb27f); }
.dream-status.bad { border-color: var(--warn, #c77916); }
.dream-status.busy { border-color: var(--accent); }
.dream-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint, #999);
  flex: none;
}
.dream-status.ok .dream-dot { background: var(--success, #3fb27f); }
.dream-status.bad .dream-dot { background: var(--warn, #c77916); }
.dream-status.busy .dream-dot { background: var(--accent); }
.dream-status-label { font-weight: 600; }
.dream-status-row .btn.mini {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
}
.dream-meta { color: var(--text-faint); }
.dream-error { color: var(--danger, #d95757); word-break: break-all; }
.dream-summary {
  color: var(--text-secondary);
  margin-top: 2px;
  padding-top: 4px;
  border-top: 1px dashed var(--border);
  white-space: pre-wrap;
}
.dream-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 4px 0 14px;
}
.dream-field {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.dream-field > span { color: var(--text-faint); }
.dream-field input[type='number'],
.dream-field input[type='time'] {
  width: 100%;
  max-width: 220px;
  padding: 7px 10px;
  font-size: 13px;
}
.dream-field :deep(.app-select) {
  width: 100%;
  max-width: 220px;
}
.dream-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.dream-switch input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}
.dream-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dream-note {
  margin: 14px 0 0;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .dream-field {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .dream-field input[type='number'],
  .dream-field input[type='time'],
  .dream-field :deep(.app-select) {
    max-width: none;
  }
}
</style>
