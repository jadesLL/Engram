<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>自动整理（梦境思考）</h3>
        <p>到点让内置 Agent 在后台提炼未整理的原始资料，并做一次全库纠错。</p>
      </div>
    </div>

    <SettingsGroup
      anchor="agent-dream"
      title="自动整理（梦境思考）"
      hint="按计划提炼资料并做一次全库纠错。"
    >
      <!-- 运行状态：会变的实时状态统一用状态条，不再用灰字铺一段说明 -->
      <div v-if="loaded" class="state-strip dream-status" :class="statusTone">
        <span class="state-dot" aria-hidden="true" />
        <div class="dream-status-copy">
          <strong class="dream-status-label">{{ statusLabel }}</strong>
          <span v-if="nextRunText" class="dream-meta">下次运行：{{ nextRunText }}</span>
          <span v-if="lastRunText" class="dream-meta">上次运行：{{ lastRunText }}</span>
          <span v-if="status?.last?.error" class="dream-error">{{ status.last.error }}</span>
          <span class="dream-meta" :title="auditDetail">{{ auditText }}</span>
        </div>
        <div class="setting-actions dream-status-actions">
          <button class="btn ghost small" type="button" @click="loadStatus">刷新</button>
        </div>
      </div>

      <!-- 计划：启用开关 + 频率 + 时间，一行一件事 -->
      <div class="setting-row">
        <div class="setting-copy">
          <strong>启用自动整理</strong>
          <span>默认关闭；打开后到点自动跑一轮。</span>
        </div>
        <div class="setting-control dream-switch-cell">
          <label class="switch-control">
            <input v-model="form.enabled" type="checkbox" aria-label="启用自动整理" />
            <span aria-hidden="true"></span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>运行频率</strong>
          <span>每天一次，或每隔几天跑一次。</span>
        </div>
        <div class="setting-control dream-control">
          <AppSelect v-model="form.frequency" aria-label="运行频率" :options="frequencyOptions" />
        </div>
      </div>

      <div v-if="form.frequency === 'interval'" class="setting-row">
        <div class="setting-copy">
          <strong>间隔天数</strong>
          <span>1 到 30 天。</span>
        </div>
        <div class="setting-control dream-control">
          <input v-model.number="form.intervalDays" type="number" min="1" max="30" step="1" aria-label="间隔天数" />
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>运行时间</strong>
          <span>建议放在凌晨空闲时段。</span>
        </div>
        <div class="setting-control dream-control">
          <input v-model="form.time" type="time" step="60" aria-label="运行时间" />
        </div>
      </div>

      <div class="setting-actions dream-actions">
        <button v-if="status?.sessionId" class="btn ghost small" type="button" @click="openConversation">
          查看过程与结果
        </button>
        <button v-if="!status?.running" class="btn small" type="button" :disabled="starting" @click="runNow">
          {{ starting ? '正在发起…' : '立即执行一次' }}
        </button>
        <button v-else class="btn danger small" type="button" :disabled="stopping" @click="stop">
          {{ stopping ? '正在停止…' : '停止' }}
        </button>
        <button class="btn primary small" type="button" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>

      <!-- 提炼看板：一轮跑完「提炼了哪几份、写了哪些页、修了什么」摊在这里，
           不用再点进「梦境思考」对话翻工具卡。明细由服务端按工具卡现算，不走第二套账。 -->
      <section class="dream-board">
        <div class="dream-board-head">
          <h4>提炼看板</h4>
          <span v-if="boardHint" class="dream-board-hint">{{ boardHint }}</span>
        </div>

        <p v-if="!loaded" class="setting-note">正在读取提炼记录…</p>
        <div v-else-if="!boardRounds.length" class="empty-panel">
          还没有提炼记录。点「立即执行一次」，或等计划时间自动跑一轮。
        </div>

        <template v-else>
          <article v-for="(round, index) in boardRounds" :key="round.runId" class="dream-round">
            <header class="dream-round-head" @click="toggleRound(round.runId, index)">
              <span class="group-badge" :class="`tone-${roundBadgeTone(round.status)}`">{{ statusText(round.status) }}</span>
              <span class="dream-round-time">{{ formatStamp(round.startedAt) }}</span>
              <span v-if="roundMeta(round)" class="dream-round-meta">{{ roundMeta(round) }}</span>
              <span v-if="index === 0" class="group-badge tone-accent">最近一轮</span>
              <button class="text-action dream-round-fold" type="button" @click.stop="toggleRound(round.runId, index)">
                {{ isRoundOpen(round.runId, index) ? '收起' : '展开' }}
              </button>
            </header>

            <p v-if="round.error" class="dream-error">{{ round.error }}</p>

            <template v-if="isRoundOpen(round.runId, index)">
              <div class="dream-round-metrics">
                <span v-for="metric in roundMetrics(round)" :key="metric" class="dream-metric">{{ metric }}</span>
              </div>

              <div v-if="round.sources.length" class="dream-group">
                <div class="dream-group-label">读入原始资料 · {{ round.sources.length }} 份</div>
                <ul class="dream-items">
                  <li v-for="source in round.sources" :key="`src-${source.label}`">
                    <span class="dream-item-text">{{ source.label }}</span>
                  </li>
                </ul>
              </div>

              <div v-if="round.pages.length" class="dream-group">
                <div class="dream-group-label">写入 / 更新页面 · {{ round.pages.length }} 个</div>
                <ul class="dream-items">
                  <li v-for="page in round.pages" :key="`page-${page.label}`">
                    <a class="dream-item-link" href="#" @click.prevent="openPage(page.label)">{{ page.label }}</a>
                    <span v-if="page.note" class="dream-item-note">{{ page.note }}</span>
                    <span v-if="!page.ok" class="dream-item-fail">写入失败</span>
                  </li>
                </ul>
              </div>

              <div v-if="round.changes.length" class="dream-group">
                <div class="dream-group-label">纠错动作 · {{ round.changes.length }} 处</div>
                <ul class="dream-items">
                  <li v-for="change in round.changes" :key="`${change.kind}-${change.label}`">
                    <span class="dream-item-kind">{{ changeKindText(change.kind) }}</span>
                    <span class="dream-item-text">{{ change.label }}</span>
                    <span v-if="change.note" class="dream-item-note">{{ change.note }}</span>
                    <span v-if="!change.ok" class="dream-item-fail">失败</span>
                  </li>
                </ul>
              </div>

              <p v-if="!round.counts.calls" class="setting-note">
                这一轮没有工具调用，详情看对话里的过程。
              </p>

              <div v-if="round.summary" class="dream-round-summary">
                <div
                  class="dream-md-wrap"
                  :class="{ fold: summaryFoldNeeded(round.summary), open: isSummaryOpen(round.runId) }"
                >
                  <div class="dream-md" v-html="renderMarkdown(round.summary)" @click="onSummaryClick" />
                </div>
                <button
                  v-if="summaryFoldNeeded(round.summary)"
                  class="btn ghost small dream-summary-toggle"
                  type="button"
                  @click="toggleSummary(round.runId)"
                >
                  {{ isSummaryOpen(round.runId) ? '收起总结' : '展开全部总结' }}
                </button>
              </div>
            </template>

            <p v-else-if="round.summary" class="setting-note dream-round-peek">{{ summaryPeek(round.summary) }}</p>
          </article>
        </template>
      </section>

      <p class="setting-note">
        跑的是内置 Agent：只经 engram 命令读写知识库，写入受证据门禁约束、删除只入回收站。没有待办时到点只检查一次，不消耗模型额度。
      </p>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { confirmDialog } from '../../lib/confirm';
import { renderMarkdown } from '../../lib/markdown';
import {
  boardHint as boardHintOf,
  changeKindText,
  roundMeta,
  roundMetrics,
  roundTone,
  statusText,
  summaryFoldNeeded,
  summaryPeek,
  type DreamBoard,
} from '../../lib/dreamBoard';
import { useChatStore } from '../../stores/chat';
import { useAppStore } from '../../stores/app';
import SettingsGroup from './SettingsGroup.vue';
import AppSelect from '../ui/AppSelect.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';

/**
 * 梦境思考的设置面板：开关 + 每天/每隔 N 天 + 时间点，上次结果、当前待办，以及提炼看板。
 *
 * 排期口径全在服务端（server/src/assistant/dreamConfig.ts）：界面只把「下次运行」原样显示，
 * 不做第二套推算，避免两边说法不一致。状态每 30 秒轮询一次（与 DDNS 面板同档）。
 *
 * 提炼看板的数据也全来自服务端（server/src/assistant/dreamBoard.ts）：轮次、工具卡明细、
 * 起点/收口计数都由它算好；界面只负责排版与 Markdown 渲染，不自己推断「这轮干了什么」。
 *
 * 2026-11 第二轮内容精修：状态收进 .state-strip（会变的值不再当灰说明写）；表单改 setting-row
 * 一行一件事；看板轮次去外框、只留细线；机制长句删到一句「必须说」的备注里。
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
  /** 提炼看板（老服务端不带这个字段时按空看板处理） */
  board?: DreamBoard;
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
const router = useRouter();

/** 看板折叠状态：默认只展开最近一轮，更早的收起成一行；总结默认只看前几行 */
const roundOpen = ref<Record<string, boolean>>({});
const summaryOpen = ref<Record<string, boolean>>({});

const boardRounds = computed(() => status.value?.board?.rounds ?? []);

const boardHint = computed(() => boardHintOf(status.value?.board));

/** 轮次状态 → 卡头同款徽标色档（复用 dreamBoard 的 ok / bad / busy / plain 映射） */
const ROUND_BADGE_TONE = { ok: 'ok', bad: 'danger', busy: 'accent', plain: 'muted' } as const;

function roundBadgeTone(state: string): string {
  return ROUND_BADGE_TONE[roundTone(state)];
}

function isRoundOpen(runId: string, index: number): boolean {
  const flag = roundOpen.value[runId];
  return flag === undefined ? index === 0 : flag;
}

function toggleRound(runId: string, index: number): void {
  roundOpen.value = { ...roundOpen.value, [runId]: !isRoundOpen(runId, index) };
}

function isSummaryOpen(runId: string): boolean {
  return summaryOpen.value[runId] === true;
}

function toggleSummary(runId: string): void {
  summaryOpen.value = { ...summaryOpen.value, [runId]: !isSummaryOpen(runId) };
}

/** 点页面标题 → 打开该页（与对话里的双链同一路径：按标题查 id 再跳阅读页） */
async function openPage(title: string): Promise<void> {
  const name = String(title || '').trim();
  if (!name) return;
  try {
    const { data } = await api.get(`/api/pages/by-title/${encodeURIComponent(name)}`);
    router.push(`/page/${data.id}`);
  } catch {
    notify.error(`没找到页面「${name}」`);
  }
}

/** 总结里的 [[双链]]：点开对应页面（外链不拦，交给 target="_blank"） */
async function onSummaryClick(event: MouseEvent): Promise<void> {
  const anchor = (event.target as HTMLElement | null)?.closest?.('a.md-wikilink') as HTMLAnchorElement | null;
  if (!anchor) return;
  event.preventDefault();
  await openPage(anchor.dataset.wiki || '');
}

/** 表单有没有改过（没改时「保存」不可点） */
const dirty = computed(() => (
  form.enabled !== stored.enabled
  || form.frequency !== stored.frequency
  || form.time !== stored.time
  || Number(form.intervalDays) !== Number(stored.intervalDays)
));

/** 状态条色档：跑起来了用强调色，失败/待配置用警示色，配置就绪用完成色，停用保持中性 */
const statusTone = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (s.running) return 'tone-busy';
  if (s.last?.status === 'failed' || (s.config.enabled && !s.agentReady)) return 'tone-warn';
  if (s.config.enabled && s.agentReady) return 'tone-ok';
  return '';
});

const statusLabel = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (s.running) return '正在运行';
  if (!s.agentReady) return '待配置：先给内置 Agent 填模型凭据';
  if (!s.config.enabled) return '已停用';
  const last = s.last.status;
  if (last === 'completed') return '上次运行完成';
  if (last === 'failed') return '上次运行失败';
  if (last === 'skipped') return '上次无待办，已跳过';
  if (last === 'cancelled') return '上次运行已停止';
  return '等待计划时间';
});

const nextRunText = computed(() => {
  const s = status.value;
  if (!s || !s.config.enabled || !s.nextRunAt) return '';
  return `${formatNext(s.nextRunAt)}${s.due ? '（已到期）' : ''}`;
});

const lastRunText = computed(() => {
  const s = status.value;
  if (!s?.last?.at) return '';
  const trigger = s.last.trigger === 'manual' ? '手动触发' : '计划触发';
  return `${formatStamp(s.last.at)} · ${trigger}`;
});

/** 状态条里只说「欠多少」；死链/重复/规则落后的拆解放 title，不占版面 */
const auditText = computed(() => {
  const s = status.value;
  if (!s) return '';
  const issues = s.audit.deadLinks + s.audit.duplicates + s.audit.outdatedPages;
  return `待提炼 ${s.audit.pendingFiles} 份 · 待核查 ${issues} 处`;
});

const auditDetail = computed(() => {
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

/** 停止是不可撤销动作（已写入的页面不会回滚）：先确认再停 */
async function stop(): Promise<void> {
  const ok = await confirmDialog({
    title: '停止本轮自动整理',
    message: '本轮已写入的页面不会回滚，剩余步骤不再执行。继续？',
    confirmText: '停止',
    danger: true,
  });
  if (!ok) return;
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

/**
 * 设置分区激活态：Agent 大类隐藏时不再每 30 秒拉一次梦境状态（切走即停表，
 * 切回来立刻重拉一次并重新计时）。active 缺省（未传）按可见处理。
 */
const props = defineProps<{ active?: boolean }>();

function startPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void loadStatus(), 30_000);
}

function stopPoll(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

onMounted(async () => {
  await loadStatus();
  if (props.active !== false) startPoll();
});

watch(() => props.active, (now) => {
  if (now === false) {
    stopPoll();
    return;
  }
  void loadStatus();
  startPoll();
});

onUnmounted(() => {
  stopPoll();
});
</script>

<style scoped>
/* ---------- 运行状态条：状态点在首行光学中线上，右侧只留一个刷新 ---------- */
.dream-status {
  align-items: flex-start;
  gap: 10px;
  margin: 4px 0 6px;
}
.dream-status-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dream-status-label {
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}
.dream-status-actions {
  flex: none;
}
.dream-meta {
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}
.dream-error {
  color: var(--danger);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* ---------- 计划表单：控件与全局 32px 口径对齐 ---------- */
.dream-switch-cell {
  display: flex;
  justify-content: flex-end;
}
.dream-control :deep(.app-select) {
  width: 100%;
}
.dream-control input {
  width: 100%;
}
.dream-actions { margin-top: 12px; }

/* ---------- 提炼看板：细线分组，不再每轮套一张描边卡 ---------- */
.dream-board {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.dream-board-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}
.dream-board-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.dream-board-hint {
  color: var(--text-secondary);
  font-size: 11.5px;
}
.dream-round {
  border-top: 1px solid var(--border);
  padding: 10px 0;
}
.dream-round:first-of-type { border-top: 0; }
.dream-round-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  cursor: pointer;
}
.dream-round-time {
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dream-round-meta {
  color: var(--text-secondary);
  font-size: 11.5px;
}
.dream-round-fold { margin-left: auto; }
.dream-round-peek { margin-top: 6px; }

.dream-round-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 2px;
}
.dream-metric {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11.5px;
}

.dream-group { margin-top: 10px; }
.dream-group-label {
  margin-bottom: 2px;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.dream-items {
  margin: 0;
  padding: 0;
  list-style: none;
}
.dream-items li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  font-size: 12px;
  line-height: 1.6;
}
.dream-item-link { color: var(--accent); text-decoration: none; }
.dream-item-link:hover { text-decoration: underline; }
.dream-item-text { color: var(--text-secondary); word-break: break-all; }
.dream-item-note {
  color: var(--text-secondary);
  font-size: 11.5px;
  word-break: break-all;
}
.dream-item-kind {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
}
.dream-item-fail { color: var(--danger); }
.dream-round-summary { margin-top: 12px; }
.dream-summary-toggle { margin-top: 8px; }

/* 折叠只给长文用：短小结套上容器会让最后一行被渐隐遮住，看起来像被截断。
   渐隐用 mask 而不是盖一层背景色——设置面板底色在浅色/深色下不同，遮罩不挑底色。 */
.dream-md-wrap.fold {
  position: relative;
  max-height: 170px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, #000 68%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, #000 68%, transparent);
}
.dream-md-wrap.fold.open {
  max-height: none;
  mask-image: none;
  -webkit-mask-image: none;
}

/* 小结按 Markdown 渲染（renderMarkdown 的产物是 v-html，样式要 :deep 才命得中） */
.dream-md {
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.75;
}
.dream-md :deep(> :first-child) { margin-top: 0; }
.dream-md :deep(> :last-child) { margin-bottom: 0; }
.dream-md :deep(h2),
.dream-md :deep(h3),
.dream-md :deep(h4),
.dream-md :deep(h5),
.dream-md :deep(h6) {
  margin: 14px 0 6px;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}
.dream-md :deep(h2),
.dream-md :deep(h3) { font-size: 13px; }
.dream-md :deep(p) { margin: 6px 0; }
.dream-md :deep(strong) { color: var(--text); font-weight: 600; }
.dream-md :deep(ul),
.dream-md :deep(ol) {
  margin: 6px 0;
  padding-left: 18px;
}
.dream-md :deep(li) { margin: 2px 0; }
.dream-md :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-secondary);
  font-size: 12px;
}
.dream-md :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  overflow-x: auto;
}
.dream-md :deep(pre code) { padding: 0; background: none; }
.dream-md :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 0 2px 10px;
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
}
.dream-md :deep(a) { color: var(--accent); }
/* 小结里的表格也只留行间细线，不再套一圈外框 */
.dream-md :deep(.md-table) {
  width: 100%;
  margin: 6px 0;
  border-collapse: collapse;
  font-size: 12px;
}
.dream-md :deep(.md-table th),
.dream-md :deep(.md-table td) {
  padding: 4px 8px;
  border: 0;
  border-top: 1px solid var(--border);
  text-align: left;
}
.dream-md :deep(.md-table th) { color: var(--text-secondary); font-weight: 600; }

</style>
