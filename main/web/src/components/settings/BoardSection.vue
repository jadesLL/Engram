<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>任务看板提炼</h3>
        <p><strong>看板不在后台定时跑</strong>：只有你打开「任务看板」页时，才按这里的间隔判断要不要让内置 Agent 重新提炼一次——你没看的时候它不会动、也不烧模型额度。</p>
      </div>
    </div>

    <SettingsGroup
      anchor="agent-board"
      :badge="badge"
      :badge-tone="badgeTone"
      title="任务看板提炼"
      :hint="`打开看板页时按间隔自动重新提炼（${autoLabel}）；每次提炼都新开一个 Agent 会话，不把上一轮上下文带进来`"
    >
      <div v-if="loaded" class="board-status" :class="{ busy: Boolean(config?.running), muted: isOff }">
        <div class="board-status-row">
          <span class="board-dot" aria-hidden="true"></span>
          <span class="board-status-label">{{ statusLabel }}</span>
          <button class="btn mini" type="button" @click="loadConfig">刷新</button>
        </div>
        <div v-if="lastText" class="board-meta">上次提炼：{{ lastText }}<template v-if="fromText">（{{ fromText }}）</template></div>
        <div v-if="dueText" class="board-meta">下次到期：{{ dueText }}（到期后打开看板页才会重新提炼）</div>
      </div>

      <div class="board-form">
        <label class="board-field">
          <span>重新提炼间隔</span>
          <AppSelect v-model="form.days" aria-label="重新提炼间隔" :options="selectOptions" />
        </label>
      </div>

      <div class="board-actions">
        <button class="btn primary small" type="button" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="btn small" type="button" @click="openBoard">打开任务看板</button>
      </div>

      <p class="faint small board-note">
        「关闭自动」只是不再自己重跑：看板页右上角的手动「刷新」任何时候都能用，页头也会显示当前档位并可一键跳回这里。
        间隔按「距上次提炼过了多久」算，不绑具体时刻；过了间隔也不催你，等你下次打开看板页时才提炼一次。
        每次提炼都新开一个会话（上一轮的对话不带进这一轮，跑多轮的成本不会一轮比一轮高），过程都能在聊天抽屉里翻到。
      </p>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { boardAutoChoices, boardAutoLabel, formatBoardDue, formatBoardStamp } from '../../lib/boardAuto';
import SettingsGroup from './SettingsGroup.vue';
import AppSelect from '../ui/AppSelect.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';

/**
 * 「任务看板提炼」设置面板：自动重新提炼的间隔（关闭自动 / 每天 / 每 2 天 / 每 3 天 / 每 7 天）
 * + 上次更新时间与到期时刻。
 *
 * 口径全在服务端（server/src/assistant/boardCore.ts 与 taskBoard.ts）：这里只显示服务端算好的
 * 档位、生成时刻与到期时刻，不自己推一遍「哪天到期」；看板页页头的按钮跳到本分组（缺省落点）。
 * 看板不在后台定时跑——到没到期只有打开看板页时才判一次，所以这里也没有「立即执行」按钮，
 * 要立刻重跑就去看板页点「刷新」。
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
const autoLabel = computed(() => boardAutoLabel(currentDays.value));
const isOff = computed(() => currentDays.value <= 0);
/** 表单有没有改过（没改时「保存」不可点） */
const dirty = computed(() => form.days !== stored.days);

const lastText = computed(() => formatBoardStamp(config.value?.generatedAt || ''));
const dueText = computed(() => formatBoardDue(config.value?.dueAt || ''));
/** 上次提炼那行后面的括注：正在提炼 / 来自哪台设备（别端同步过来的那份） */
const fromText = computed(() => {
  const current = config.value;
  if (!current) return '';
  if (current.running) return '正在提炼';
  return !current.local && current.sourceNodeLabel ? `来自 ${current.sourceNodeLabel}` : '';
});

const statusLabel = computed(() => {
  const current = config.value;
  if (!current) return '正在读配置…';
  if (current.running) return '正在提炼：内置 Agent 正在从知识库重新提炼';
  if (current.autoDays <= 0) return '已关闭自动：只有看板页的「刷新」才会重新提炼';
  if (!current.generatedAt) return '还没有生成过：打开看板页就会提炼第一版';
  if (current.stale) return `已到期（${boardAutoLabel(current.autoDays)}）：下次打开看板页自动重新提炼`;
  return `等待到期（${boardAutoLabel(current.autoDays)}）：到期后打开看板页才重新提炼`;
});

const badge = computed(() => (config.value?.running ? '正在提炼' : isOff.value ? '已关闭自动' : ''));
const badgeTone = computed<'accent' | 'muted'>(() => (config.value?.running ? 'accent' : 'muted'));
useSettingsBadge('agent-board', computed(() => (config.value?.running ? '正在提炼' : '')));

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

onMounted(async () => {
  await loadConfig();
  pollTimer = setInterval(() => void loadConfig(), 30_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<style scoped>
.board-status {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.7;
}
.board-status.busy { border-color: var(--accent); }
.board-status.muted { background: var(--bg-secondary); }
.board-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.board-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint, #999);
  flex: none;
}
.board-status.busy .board-dot { background: var(--accent); }
.board-status-label { font-weight: 600; }
.board-status-row .btn.mini {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
}
.board-meta { color: var(--text-faint); }

.board-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 4px 0 14px;
}
.board-field {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.board-field > span { color: var(--text-faint); }
.board-field :deep(.app-select) {
  width: 100%;
  max-width: 220px;
}

.board-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.board-note {
  margin: 14px 0 0;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .board-field {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .board-field :deep(.app-select) {
    max-width: none;
  }
}
</style>
