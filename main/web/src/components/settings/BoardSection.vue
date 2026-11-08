<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>任务看板提炼</h3>
        <p>看板不在后台定时跑：只有打开「任务看板」页时，才按这里的间隔判断要不要让内置 Agent 重新提炼一次。</p>
      </div>
    </div>

    <SettingsGroup
      anchor="agent-board"
      title="任务看板提炼"
      hint="打开看板页时按间隔重新提炼。"
    >
      <!-- 运行状态：会变的实时状态统一用状态条 -->
      <div v-if="loaded" class="state-strip board-status" :class="statusTone">
        <span class="state-dot" aria-hidden="true" />
        <div class="board-status-copy">
          <strong class="board-status-label">{{ statusLabel }}</strong>
          <span v-if="lastText" class="board-meta">
            上次提炼：{{ lastText }}<template v-if="fromText">（{{ fromText }}）</template>
          </span>
          <span v-if="dueText && !isOff" class="board-meta">下次到期：{{ dueText }}</span>
        </div>
        <div class="setting-actions board-status-actions">
          <button class="btn ghost small" type="button" @click="loadConfig">刷新</button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>重新提炼间隔</strong>
          <span>从关闭自动到每 7 天一次。</span>
        </div>
        <div class="setting-control board-control">
          <AppSelect v-model="form.days" aria-label="重新提炼间隔" :options="selectOptions" />
        </div>
      </div>

      <div class="setting-actions board-actions">
        <button class="btn small" type="button" @click="openBoard">打开任务看板</button>
        <button class="btn primary small" type="button" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>

      <p class="setting-note">
        「关闭自动」只是不再自己重跑；看板页右上角的「刷新」随时可用。间隔按距上次提炼的时间算，不绑具体时刻。
      </p>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { boardAutoChoices, boardAutoLabel, formatBoardDue, formatBoardStamp } from '../../lib/boardAuto';
import SettingsGroup from './SettingsGroup.vue';
import AppSelect from '../ui/AppSelect.vue';

/**
 * 「任务看板提炼」设置面板：自动重新提炼的间隔（关闭自动 / 每天 / 每 2 天 / 每 3 天 / 每 7 天）
 * + 上次更新时间与到期时刻。
 *
 * 口径全在服务端（server/src/assistant/boardCore.ts 与 taskBoard.ts）：这里只显示服务端算好的
 * 档位、生成时刻与到期时刻，不自己推一遍「哪天到期」；看板页页头的按钮跳到本分组（缺省落点）。
 * 看板不在后台定时跑——到没到期只有打开看板页时才判一次，所以这里也没有「立即执行」按钮，
 * 要立刻重跑就去看板页点「刷新」。
 *
 * 2026-11 第二轮内容精修：长机制说明压到一句备注；状态收进 .state-strip；表单改一行
 * setting-row；卡头不再放与状态条重复的徽标。
 */

/** 服务端给的配置态（与 server/src/assistant/taskBoard.ts 的 TaskBoardConfigState 对应） */
interface BoardConfigDto {
  autoDays: number;
  options: number[];
  generatedAt: string;
  dueAt: string;
  stale: boolean;
  running: boolean;
  runId: string;
  /** 这份看板是不是本机生成的（false = 别端同步来的） */
  local: boolean;
  sourceNodeLabel: string;
}

const router = useRouter();
const config = ref<BoardConfigDto | null>(null);
/** 表单里是字符串（AppSelect 的取值是字符串），提交时转回数字 */
const form = reactive<{ days: string }>({ days: '2' });
const stored = reactive<{ days: string }>({ days: '2' });
const loaded = ref(false);
const saving = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 首次加载前 options 还不知道：先给一份与服务端一致的兜底档位，避免下拉空白 */
const selectOptions = computed(() => boardAutoChoices(config.value?.options?.length ? config.value.options : [0, 1, 2, 3, 7]));

const currentDays = computed(() => Number(form.days) || 0);
const isOff = computed(() => currentDays.value <= 0);
/** 表单有没有改过（没改时「保存」不可点） */
const dirty = computed(() => form.days !== stored.days);

const lastText = computed(() => formatBoardStamp(config.value?.generatedAt || ''));
const dueText = computed(() => formatBoardDue(config.value?.dueAt || ''));
/** 上次提炼那行后面的括注：来自哪台设备（别端同步过来的那份） */
const fromText = computed(() => {
  const current = config.value;
  if (!current) return '';
  return !current.local && current.sourceNodeLabel ? `来自 ${current.sourceNodeLabel}` : '';
});

/** 状态条色档：跑起来了用强调色，到期了用警示色，其余保持中性 */
const statusTone = computed(() => {
  const current = config.value;
  if (!current) return '';
  if (current.running) return 'tone-busy';
  if (current.autoDays > 0 && current.stale) return 'tone-warn';
  return '';
});

const statusLabel = computed(() => {
  const current = config.value;
  if (!current) return '正在读配置…';
  if (current.running) return '正在提炼';
  if (current.autoDays <= 0) return '已关闭自动';
  if (!current.generatedAt) return '还没有生成过';
  if (current.stale) return `已到期（${boardAutoLabel(current.autoDays)}）`;
  return `等待到期（${boardAutoLabel(current.autoDays)}）`;
});

function applyConfig(data: BoardConfigDto): void {
  config.value = data;
  // 用户正在改表单时不要被轮询覆盖（保存成功后会按服务端结果回填）
  if (!dirty.value) {
    form.days = String(data.autoDays);
    stored.days = String(data.autoDays);
  }
}

async function loadConfig(): Promise<void> {
  try {
    const { data } = await api.get('/api/tasks/board/config');
    applyConfig(data as BoardConfigDto);
  } catch (error) {
    console.error('加载任务看板提炼配置失败', error);
  } finally {
    loaded.value = true;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const { data } = await api.put('/api/tasks/board/config', { autoDays: currentDays.value });
    const next = data as BoardConfigDto;
    config.value = next;
    form.days = String(next.autoDays);
    stored.days = String(next.autoDays);
    notify.success(next.autoDays > 0 ? `已保存：${boardAutoLabel(next.autoDays)}重新提炼一次` : '已保存：自动提炼已关闭');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '保存失败');
  } finally {
    saving.value = false;
  }
}

function openBoard(): void {
  void router.push('/tasks');
}

/**
 * 设置分区激活态：Agent 大类隐藏时不再每 30 秒拉一次看板配置（切走即停表，
 * 切回来立刻重拉一次并重新计时）。active 缺省（未传）按可见处理。
 */
const props = defineProps<{ active?: boolean }>();

function startPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void loadConfig(), 30_000);
}

function stopPoll(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

onMounted(async () => {
  await loadConfig();
  if (props.active !== false) startPoll();
});

watch(() => props.active, (now) => {
  if (now === false) {
    stopPoll();
    return;
  }
  void loadConfig();
  startPoll();
});

onUnmounted(() => {
  stopPoll();
});
</script>

<style scoped>
/* ---------- 运行状态条 ---------- */
.board-status {
  align-items: flex-start;
  gap: 10px;
  margin: 4px 0 6px;
}
.board-status-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.board-status-label {
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}
.board-status-actions {
  flex: none;
}
.board-meta {
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

/* ---------- 间隔表单 ---------- */
.board-control :deep(.app-select) {
  width: 100%;
}
.board-actions {
  margin-top: 12px;
}
.board-actions + .setting-note {
  margin-top: 12px;
}
</style>
